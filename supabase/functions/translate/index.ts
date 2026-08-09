/*
 * Edge Function «translate» — ИИ-перевод фрагмента через Claude.
 *
 * Зачем функция, а не вызов из браузера: сайт статический и лежит на GitHub Pages,
 * исходники видны всем. Ключ Anthropic, положенный в клиент, утечёт в первый же
 * день. Здесь он берётся из секретов функции и наружу не выходит.
 *
 * ⚠️ Это путь ОБЩЕГО ключа: платит владелец библиотеки. У читателя есть второй,
 * независимый путь — свой ключ OpenRouter прямо из браузера (см. translate.js).
 * Там ключ в localStorage допустим именно потому, что он свой.
 *
 * Развернуть:
 *   supabase functions deploy translate
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *
 * Пока ключ не задан, функция честно отвечает 503, а интерфейс показывает
 * «ИИ» серым и не даёт нажать — публичная библиотека при этом работает как
 * работала (см. CLAUDE.md: бэкенд — надстройка, а не фундамент).
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.115.0';

const LANG_NAMES: Record<string, string> = {
  ru: 'русский', en: 'английский', ar: 'арабский',
  fa: 'фарси', tr: 'турецкий', de: 'немецкий', fr: 'французский',
};
const langName = (code: string) => LANG_NAMES[code] || code;

const MAX_CHARS = 6000;          // один сектор с запасом; больше — почти наверняка ошибка вызова
const MAX_EXTRA = 1000;          // просьба пользователя — подсказка, а не канал для промпта любой длины

/* Слот для своей команды-обёртки. Промпт со слотом — это уже самостоятельный запрос,
   а не добавка к переводу. Та же развилка в translate.js: их логика обязана совпадать. */
const SLOT = /\{\s*(?:текст|фрагмент|text|selection)\s*\}/gi;
// lastIndex сбрасываем руками: у глобальной регулярки .test() помнит позицию
const hasSlot = (s: string) => { SLOT.lastIndex = 0; return SLOT.test(s); };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

/* Один вызов модели на обе ветки (перевод и своя команда): различаются они только
   текстом system и user, а разбор ответа и ошибок у них общий. */
async function askClaude(apiKey: string, system: string, user: string) {
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8000,
      // низкое усилие: короткий фрагмент не требует глубокого рассуждения,
      // а задержка здесь видна пользователю — он ждёт карточку
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: user }],
    });

    // на отказ классификаторов приходит HTTP 200 со stop_reason: "refusal" —
    // читать content[0] не проверив, значит однажды упасть на пустом массиве
    if (message.stop_reason === 'refusal') {
      return json({ error: 'Модель отказалась отвечать на этот фрагмент' }, 422);
    }

    const out = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!out) return json({ error: 'Пустой ответ модели' }, 502);
    return json({ text: out, model: message.model, usage: message.usage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: 'Не удалось: ' + msg }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Только POST' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY не задан в секретах функции' }, 503);

  let payload: { text?: string; from?: string; to?: string; extra?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Тело запроса — не JSON' }, 400);
  }

  const text = (payload.text || '').trim();
  const from = payload.from || '';
  const to = payload.to || 'ru';
  const extra = (payload.extra || '').trim().slice(0, MAX_EXTRA);
  if (!text) return json({ error: 'Пустой текст' }, 400);
  if (text.length > MAX_CHARS) return json({ error: `Слишком длинный фрагмент (${text.length} > ${MAX_CHARS})` }, 400);
  if (from === to) return json({ error: 'Исходный и целевой язык совпадают' }, 400);

  /* Своя команда со слотом {текст}: она и есть запрос, поэтому переводческий
     системный промпт с требованием «верни только перевод» здесь не годится — он
     прямо противоречил бы команде. Осторожность с религиозным текстом остаётся:
     она про цену ошибки, а не про формат ответа. */
  if (extra && hasSlot(extra)) {
    const system = [
      'Ты помогаешь читателю двуязычной книги разбирать её текст.',
      `Фрагмент дан на языке: ${langName(from)}. Отвечай на ${langName(to)}, если не сказано иначе.`,
      'Если текст религиозный (Коран, хадис, богословие) — будь буквален и осторожен:',
      'сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл.',
      'Не включай в ответ внутренние или служебные XML-теги.',
    ].join(' ');
    return await askClaude(apiKey, system, extra.replace(SLOT, text));
  }

  /* Перевод, а не пересказ: результат вставляется в карточку как есть. Отдельно про
     религиозный текст — там буквальность важнее гладкости, а догадки недопустимы.
     ⚠️ «Только перевод, без пояснений» держим ровно до тех пор, пока пояснений не
     попросили: вместе с просьбой разобрать термины эта строка — прямое противоречие,
     и модель выполняет случайную половину. */
  const parts = [`Ты переводчик. Переведи текст с ${langName(from)} на ${langName(to)}.`];
  if (!extra) parts.push('Верни ТОЛЬКО перевод: без преамбулы, без пояснений, без кавычек вокруг ответа.');
  parts.push(
    'Сохраняй абзацы, разметку и знаки препинания исходника.',
    'Если текст религиозный (Коран, хадис, богословие) — переводи буквально и осторожно:',
    'сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл.',
    'Имена собственные и термины, у которых нет принятого соответствия, оставляй как есть.',
    'Не включай в ответ внутренние или служебные XML-теги.',
  );
  if (extra) parts.push('Пояснения давай на языке перевода.', extra);

  return await askClaude(apiKey, parts.join(' '), text);
});
