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
 * Два провайдера:
 *   mymemory — бесплатный, без ключа, CORS открыт → можно звать прямо из браузера.
 *              Лимит 500 БАЙТ на запрос, поэтому длинное режем по предложениям.
 *   claude   — через свою Edge Function (supabase/functions/translate). Ключ живёт
 *              в секретах функции: сайт статический и лежит на Pages, любой ключ
 *              в браузере утечёт в первый же день.
 */

const MT_CACHE_PREFIX = 'chitalka:mt:';
const MT_MAX_CACHE = 300;          // записей; переводы короткие, но копятся

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
    label: 'ИИ',
    note: 'Claude — связный перевод с учётом контекста',
    /* Развёрнута функция или нет, снаружи не видно — узнаём только по первому
       вызову. Поэтому сначала «доступен», а после отказа (нет функции / нет
       ключа) гасим на сессию: пусть лучше один раз честно скажет, чем каждый
       раз обещать и не мочь. */
    available: () => Boolean(window.SB && SB.configured()) && !mtClaudeDown,
  },
};
let mtClaudeDown = false;   // выяснено на первом вызове: функции/ключа нет

/* ── кэш ──────────────────────────────────────────────────────────────────── */
function mtKey(text, from, to, provider) {
  // короткий стабильный хэш: ключ localStorage не должен тащить весь абзац
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return `${MT_CACHE_PREFIX}${provider}:${from}-${to}:${(h >>> 0).toString(36)}:${text.length}`;
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

async function mtViaClaude(text, from, to) {
  if (!(window.SB && SB.configured())) throw new Error('Бэкенд не настроен');
  const res = await fetch(SB.functionUrl('translate'), {
    method: 'POST',
    headers: await SB.functionHeaders(),
    body: JSON.stringify({ text, from, to }),
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

/* ── публичная точка входа ────────────────────────────────────────────────── */
/**
 * Перевести фрагмент. Возвращает { text, provider, cached }.
 * Ошибки пробрасываются — показывает их вызывающая сторона.
 */
async function mtTranslate(text, from, to, providerId) {
  const src = String(text || '').trim();
  if (!src) throw new Error('Нечего переводить');
  if (from === to) throw new Error('Исходный и целевой язык совпадают');
  const provider = MT_PROVIDERS[providerId];
  if (!provider) throw new Error('Неизвестный провайдер перевода');
  if (!provider.available()) throw new Error(`«${provider.label}» сейчас недоступен`);

  const key = mtKey(src, from, to, providerId);
  const hit = mtCacheGet(key);
  if (hit) return { text: hit, provider, cached: true };

  const out = providerId === 'claude'
    ? await mtViaClaude(src, from, to)
    : await mtViaMyMemory(src, from, to);

  mtCacheSet(key, out);
  return { text: out, provider, cached: false };
}

// список провайдеров, доступных прямо сейчас (для меню)
function mtAvailable() {
  return Object.values(MT_PROVIDERS).map(p => ({ ...p, ready: p.available() }));
}
