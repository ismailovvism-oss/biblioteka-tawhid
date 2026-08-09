'use strict';

/*
 * МАШИННЫЙ ПЕРЕВОД — вспомогательный слой, НЕ часть книги.
 *
 * Библиотека держит выверенные человеческие переводы, выровненные по секторам.
 * Машинный перевод рядом с ними — совсем другой по достоверности текст, и путать
 * их нельзя: на кораническом и хадисном арабском машина регулярно даёт
 * доктринально неверное. Поэтому здесь только ПОЛУЧЕНИЕ перевода; показывает его
 * `app.js` отдельной карточкой поверх текста, с явной подписью, и никогда не
 * подмешивает в поток секторов. Не менять это без веской причины.
 *
 * Три провайдера:
 *   mymemory   — бесплатный, без ключа, CORS открыт → можно звать прямо из браузера.
 *                Лимит 500 БАЙТ на запрос, поэтому длинное режем по предложениям.
 *   claude     — через свою Edge Function (supabase/functions/translate). Ключ живёт
 *                в секретах функции: он общий, платит владелец библиотеки, поэтому
 *                в браузер его класть нельзя — сайт статический и лежит на Pages.
 *   openrouter — ключ ЧИТАТЕЛЯ, введённый в настройках и лежащий в localStorage
 *                этого устройства. В репозиторий не попадает, платит сам читатель,
 *                модель выбирает тоже он. CORS у OpenRouter открыт → зовём напрямую,
 *                никакого сервера для этого пути не нужно.
 *
 * ⚠️ Почему свой ключ можно, а общий нельзя: разница не в технологии, а в том, чей
 * это кошелёк. Ключ в localStorage виден любому скрипту на странице, поэтому в него
 * годится только тот ключ, чьим риском распоряжается сам владелец ключа.
 */

const MT_CACHE_PREFIX = 'chitalka:mt:';
const MT_MAX_CACHE = 300;          // записей; переводы короткие, но копятся

/* ключ OpenRouter — отдельный ключ localStorage, НЕ поле settings:
   settings уходят в файл резервной копии (экспорт), а секрету там не место */
const OR_KEY_STORE = 'chitalka:orkey';
const OR_API = 'https://openrouter.ai/api/v1';

function orKey() {
  try { return localStorage.getItem(OR_KEY_STORE) || ''; } catch { return ''; }
}
function orKeySet(value) {
  try {
    if (value) localStorage.setItem(OR_KEY_STORE, value);
    else localStorage.removeItem(OR_KEY_STORE);
  } catch { /* приватный режим — ключ проживёт только до перезагрузки */ }
}

const MT_PROVIDERS = {
  mymemory: {
    id: 'mymemory',
    label: 'Быстро',
    note: 'MyMemory — бесплатный словарный движок',
    // ключа не требует, значит доступен всегда
    available: () => true,
  },
  claude: {
    id: 'claude',
    label: 'ИИ (сервер)',
    note: 'Claude через Edge Function библиотеки',
    /* Развёрнута функция или нет, снаружи не видно — узнаём только по первому
       вызову. Поэтому сначала «доступен», а после отказа (нет функции / нет
       ключа) гасим на сессию: пусть лучше один раз честно скажет, чем каждый
       раз обещать и не мочь. */
    available: () => Boolean(window.SB && SB.configured()) && !mtClaudeDown,
  },
  openrouter: {
    id: 'openrouter',
    label: 'ИИ (свой ключ)',
    note: 'OpenRouter — ваш ключ и ваш выбор модели',
    // ключ есть — путь готов; сервер тут ни при чём, значит и офлайна-угадайки нет
    available: () => Boolean(orKey()),
  },
};
let mtClaudeDown = false;   // выяснено на первом вызове: функции/ключа нет

/* ── кэш ──────────────────────────────────────────────────────────────────── */
function mtKey(text, from, to, tag) {
  // короткий стабильный хэш: ключ localStorage не должен тащить весь абзац
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return `${MT_CACHE_PREFIX}${tag}:${from}-${to}:${(h >>> 0).toString(36)}:${text.length}`;
}

function mtCacheGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function mtCacheSet(key, value) {
  try {
    localStorage.setItem(key, value);
    // грубая, но достаточная прополка: переводы дешевле пересчитать, чем хранить вечно
    const keys = Object.keys(localStorage).filter(k => k.startsWith(MT_CACHE_PREFIX));
    if (keys.length > MT_MAX_CACHE) {
      for (const k of keys.slice(0, keys.length - MT_MAX_CACHE)) localStorage.removeItem(k);
    }
  } catch { /* приватный режим или переполнение — перевод просто не закэшируется */ }
}

/* ── нарезка под лимит MyMemory ───────────────────────────────────────────────
   Лимит считается в БАЙТАХ, а не символах: русский и арабский многобайтовые,
   и «500 символов» здесь обернулось бы 400-й ошибкой на ровном месте. */
const byteLen = s => new TextEncoder().encode(s).length;

function splitForMyMemory(text, limit = 450) {
  if (byteLen(text) <= limit) return [text];
  // режем по границам предложений, а не по символам: иначе движок получает
  // обрубок фразы и переводит его мусором
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const part of parts) {
    if (cur && byteLen(cur + part) > limit) { out.push(cur.trim()); cur = ''; }
    if (byteLen(part) > limit) {
      // одно предложение длиннее лимита — режем по словам, деваться некуда
      let piece = '';
      for (const word of part.split(/(\s+)/)) {
        if (piece && byteLen(piece + word) > limit) { out.push(piece.trim()); piece = ''; }
        /* И само слово может не влезть: длинный URL, склеенный идентификатор.
           Тогда рубим посимвольно — иначе кусок уходит в сервис как есть и
           возвращается 400 с невнятной ошибкой. */
        if (byteLen(word) > limit) {
          if (piece.trim()) { out.push(piece.trim()); piece = ''; }
          let bit = '';
          for (const ch of word) {
            if (byteLen(bit + ch) > limit) { out.push(bit); bit = ''; }
            bit += ch;
          }
          piece = bit;
          continue;
        }
        piece += word;
      }
      if (piece.trim()) cur = piece;
    } else {
      cur += part;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/* ── провайдеры ───────────────────────────────────────────────────────────── */
async function mtViaMyMemory(text, from, to) {
  const chunks = splitForMyMemory(text);
  const out = [];
  for (const chunk of chunks) {
    const url = 'https://api.mymemory.translated.net/get'
      + `?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(from + '|' + to)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory: HTTP ${res.status}`);
    const data = await res.json();
    // сервис отвечает 200 и на отказ — настоящий статус лежит в теле
    if (data.responseStatus && Number(data.responseStatus) !== 200) {
      throw new Error(data.responseDetails || `MyMemory: ${data.responseStatus}`);
    }
    const t = data.responseData && data.responseData.translatedText;
    if (!t) throw new Error('MyMemory: пустой ответ');
    out.push(t);
  }
  return out.join(' ');
}

async function mtViaClaude(text, from, to, extra) {
  if (!(window.SB && SB.configured())) throw new Error('Бэкенд не настроен');
  const res = await fetch(SB.functionUrl('translate'), {
    method: 'POST',
    headers: await SB.functionHeaders(),
    body: JSON.stringify({ text, from, to, extra }),
  });
  const body = await res.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    // самая частая причина — функция не развёрнута или в неё не положили ключ.
    // И то и другое лечится только руками, так что гасим пункт меню до перезагрузки.
    if (res.status === 404) { mtClaudeDown = true; throw new Error('Перевод через ИИ не развёрнут: нет Edge Function «translate»'); }
    if (res.status === 503) { mtClaudeDown = true; throw new Error('В функции перевода не задан ключ ANTHROPIC_API_KEY'); }
    throw new Error(msg);
  }
  if (!data || !data.text) throw new Error('Пустой ответ функции перевода');
  return data.text;
}

/* ── OpenRouter: ключ читателя, вызов прямо из браузера ───────────────────── */

const MT_LANG_NAMES = {
  ru: 'русский', en: 'английский', ar: 'арабский',
  fa: 'фарси', tr: 'турецкий', de: 'немецкий', fr: 'французский',
};
const mtLangName = code => MT_LANG_NAMES[code] || code;

/* Тот же самый промпт, что и в Edge Function: перевод, а не пересказ. Отдельно про
   религиозный текст: там буквальность важнее гладкости, а догадки недопустимы.
   `extra` — просьба пользователя (разобрать, дать примеры…), см. MT_PROMPTS в app.js. */
function mtSystemPrompt(from, to, extra) {
  const parts = [`Ты переводчик. Переведи текст с ${mtLangName(from)} на ${mtLangName(to)}.`];
  /* ⚠️ «Только перевод, без пояснений» держим ровно до тех пор, пока пояснений не
     попросили: вместе с просьбой разобрать термины эта строка превращается в прямое
     противоречие, и модель выполняет случайную половину — то куцый перевод без
     разбора, то разбор вместо перевода. */
  if (!extra) parts.push('Верни ТОЛЬКО перевод: без преамбулы, без пояснений, без кавычек вокруг ответа.');
  parts.push(
    'Сохраняй абзацы, разметку и знаки препинания исходника.',
    'Если текст религиозный (Коран, хадис, богословие) — переводи буквально и осторожно:',
    'сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл.',
    'Имена собственные и термины, у которых нет принятого соответствия, оставляй как есть.',
  );
  if (extra) parts.push('Пояснения давай на языке перевода.', extra);
  return parts.join(' ');
}

/* ── команда ИИ: промпт-обёртка вокруг фрагмента ──────────────────────────────
 * Есть два способа написать свою команду, и различаются они наличием {текст}:
 *
 *   без {текст} — просьба ПОВЕРХ перевода: «после перевода разбери термины».
 *                 Фрагмент уходит отдельно, переводчик остаётся переводчиком.
 *   с {текст}   — своя команда ЦЕЛИКОМ: «Объясни, что значит {текст} в акыде».
 *                 Тогда это и есть запрос, а не добавка к переводу, и требование
 *                 «верни только перевод» снимается — иначе оно прямо противоречит
 *                 команде и модель выполняет случайную половину.
 *
 * Осторожность с религиозным текстом остаётся в обоих случаях: она не про формат
 * ответа, а про цену ошибки.
 */
const MT_SLOT = /\{\s*(?:текст|фрагмент|text|selection)\s*\}/gi;
// lastIndex сбрасываем руками: у глобальной регулярки .test() помнит позицию,
// и каждый второй вызов на той же строке вернул бы false
const mtHasSlot = s => { MT_SLOT.lastIndex = 0; return MT_SLOT.test(String(s || '')); };

function mtMessages(text, from, to, extra) {
  if (extra && mtHasSlot(extra)) {
    return {
      system: [
        'Ты помогаешь читателю двуязычной книги разбирать её текст.',
        `Фрагмент дан на языке: ${mtLangName(from)}. Отвечай на ${mtLangName(to)}, если не сказано иначе.`,
        'Если текст религиозный (Коран, хадис, богословие) — будь буквален и осторожен:',
        'сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл.',
      ].join(' '),
      user: String(extra).replace(MT_SLOT, text),
    };
  }
  return { system: mtSystemPrompt(from, to, extra), user: text };
}

/* Список моделей OpenRouter — публичный, без ключа. Нужен, чтобы выбор модели
   был выбором из РЕАЛЬНОГО каталога, а не из захардкоженного списка, который
   протухнет к следующему релизу моделей. */
async function mtModels() {
  const res = await fetch(OR_API + '/models');
  if (!res.ok) throw new Error(`OpenRouter: HTTP ${res.status}`);
  const data = await res.json();
  const list = ((data && data.data) || []).filter(m => {
    // `:batch` — тот же движок, но с отложенным ответом; в чат-эндпоинт такой
    // id отправлять бессмысленно, а из автодополнения он выбирается на раз
    if (/:batch$/.test(m.id)) return false;
    const out = ((m.architecture || {}).output_modalities) || ['text'];
    return out.includes('text');   // модели, рисующие картинки, переводить не станут
  });
  return list.map(m => ({
    id: m.id,
    name: m.name || m.id,
    // цена приходит строкой «за токен»; переводим в доллары за миллион — так читаемо
    inM: Math.round((Number((m.pricing || {}).prompt) || 0) * 1e6 * 100) / 100,
    outM: Math.round((Number((m.pricing || {}).completion) || 0) * 1e6 * 100) / 100,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

async function mtViaOpenRouter(text, from, to, model, extra) {
  const key = orKey();
  if (!key) throw new Error('Не задан ключ OpenRouter (настройки → «Перевод через ИИ»)');
  if (!model) throw new Error('Не выбрана модель (настройки → «Перевод через ИИ»)');

  const req = mtMessages(text, from, to, extra);

  let res;
  try {
    res = await fetch(OR_API + '/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        /* необязательные поля атрибуции OpenRouter; в статистике видно, кто звал.
           ⚠️ Только латиница: значение заголовка — ByteString, и кириллическое
           название роняет сам fetch (TypeError) ещё до отправки — то есть перевод
           не работал бы вообще и жаловался бы на «нет сети». */
        'HTTP-Referer': location.origin,
        'X-Title': 'Biblioteka Tawhid',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
  } catch {
    // сюда же попадает офлайн: сеть для этого пути обязательна
    throw new Error('OpenRouter недоступен — нет сети?');
  }

  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const errMsg = data && data.error && (data.error.message || data.error);

  if (!res.ok) {
    if (res.status === 401) throw new Error('OpenRouter не принял ключ — проверьте его в настройках');
    if (res.status === 402) throw new Error('На счету OpenRouter кончились средства');
    if (res.status === 429) throw new Error('OpenRouter: слишком часто, подождите немного');
    throw new Error('OpenRouter: ' + (errMsg || `HTTP ${res.status}`));
  }
  // ошибку могут прислать и с кодом 200 — тело важнее статуса
  if (errMsg) throw new Error('OpenRouter: ' + errMsg);

  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const out = msg && (typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content.map(p => (p && p.text) || '').join('')
      : '');
  if (!out || !out.trim()) throw new Error('OpenRouter вернул пустой перевод');
  return out.trim();
}

/* ── публичная точка входа ────────────────────────────────────────────────── */
/**
 * Перевести фрагмент. Возвращает { text, provider, cached }.
 * `opts.model` нужен только провайдеру openrouter;
 * `opts.extra` — дополнительная просьба к ИИ (разобрать, дать примеры…),
 * `opts.promptId` — её короткое имя, нужно только для ключа кэша.
 * Ошибки пробрасываются — показывает их вызывающая сторона.
 */
async function mtTranslate(text, from, to, providerId, opts) {
  const src = String(text || '').trim();
  if (!src) throw new Error('Нечего переводить');
  if (from === to) throw new Error('Исходный и целевой язык совпадают');
  const provider = MT_PROVIDERS[providerId];
  if (!provider) throw new Error('Неизвестный провайдер перевода');
  if (!provider.available()) throw new Error(`«${provider.label}» сейчас недоступен`);

  const model = (opts && opts.model) || '';
  const extra = (opts && opts.extra) || '';
  const promptId = (opts && opts.promptId) || 'plain';
  /* Модель и промпт — часть ключа кэша: тот же фрагмент у другой модели и с другой
     просьбой даёт другой ответ, и склеить их в одну запись значит показать разбор
     там, где просили короткий перевод. */
  const tag = (providerId === 'openrouter' ? 'or/' + model : providerId)
    + (providerId === 'mymemory' || promptId === 'plain' ? '' : '#' + promptId);
  const key = mtKey(src, from, to, tag);
  const hit = mtCacheGet(key);
  if (hit) return { text: hit, provider, cached: true };

  const out = providerId === 'openrouter' ? await mtViaOpenRouter(src, from, to, model, extra)
    : providerId === 'claude' ? await mtViaClaude(src, from, to, extra)
    : await mtViaMyMemory(src, from, to);   // словарный движок промпта не знает — и не притворяемся

  mtCacheSet(key, out);
  return { text: out, provider, cached: false };
}

// список провайдеров, доступных прямо сейчас (для меню)
function mtAvailable() {
  return Object.values(MT_PROVIDERS).map(p => ({ ...p, ready: p.available() }));
}
