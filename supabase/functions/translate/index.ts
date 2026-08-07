/*
 * Edge Function «translate» — ИИ-перевод фрагмента через Claude.
 *
 * Зачем функция, а не вызов из браузера: сайт статический и лежит на GitHub Pages,
 * исходники видны всем. Ключ Anthropic, положенный в клиент, утечёт в первый же
 * день. Здесь он берётся из секретов функции и наружу не выходит.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Только POST' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY не задан в секретах функции' }, 503);

  let payload: { text?: string; from?: string; to?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Тело запроса — не JSON' }, 400);
  }

  const text = (payload.text || '').trim();
  const from = payload.from || '';
  const to = payload.to || 'ru';
  if (!text) return json({ error: 'Пустой текст' }, 400);
  if (text.length > MAX_CHARS) return json({ error: `Слишком длинный фрагмент (${text.length} > ${MAX_CHARS})` }, 400);
  if (from === to) return json({ error: 'Исходный и целевой язык совпадают' }, 400);

  /* Перевод, а не пересказ, и без преамбулы: результат вставляется в карточку
     как есть. Отдельно про религиозный текст — там буквальность важнее гладкости,
     а догадки недопустимы: лучше сохранить термин, чем «улучшить» смысл. */
  const system = [
    `Ты переводчик. Переведи текст с ${langName(from)} на ${langName(to)}.`,
    'Верни ТОЛЬКО перевод: без преамбулы, без пояснений, без кавычек вокруг ответа.',
    'Сохраняй абзацы, разметку и знаки препинания исходника.',
    'Если текст религиозный (Коран, хадис, богословие) — переводи буквально и осторожно:',
    'сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл.',
    'Имена собственные и термины, у которых нет принятого соответствия, оставляй как есть.',
    'Не включай в ответ внутренние или служебные XML-теги.',
  ].join(' ');

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 8000,
      // низкое усилие: перевод короткого фрагмента не требует глубокого рассуждения,
      // а задержка здесь видна пользователю — он ждёт карточку
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: text }],
    });

    // на отказ классификаторов приходит HTTP 200 со stop_reason: "refusal" —
    // читать content[0] не проверив, значит однажды упасть на пустом массиве
    if (message.stop_reason === 'refusal') {
      return json({ error: 'Модель отказалась переводить этот фрагмент' }, 422);
    }

    const out = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!out) return json({ error: 'Пустой перевод' }, 502);
    return json({ text: out, model: message.model, usage: message.usage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: 'Перевод не удался: ' + msg }, 502);
  }
});
