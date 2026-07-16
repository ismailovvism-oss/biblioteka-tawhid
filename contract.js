'use strict';

/*
 * ЯДРО КОНТРАКТА — писатель: формат Вычитки → формат библиотеки (SPEC).
 *
 * Пара к `parser.js` (тот — читатель Контракта). Как и он, файл **двусредный**:
 * работает и в Node (`require`), и в браузере (`<script src>`). Поэтому здесь
 * НЕ ДОЛЖНО быть ни DOM, ни fs, ни console — только чистые функции.
 * Предупреждения возвращаются массивом, печатает их вызывающая сторона.
 *
 * Кто использует:
 *   - `tools/import-tam.js`      (Node)     — адаптеры внешних источников;
 *   - Вычитка, «Опубликовать в библиотеку» (браузер) — путь авторства.
 * Раньше эта логика была написана в обоих местах отдельно и успела молча
 * разойтись (в Вычитке появились якоря-гибрид, в импортёре — счётчики и
 * предупреждения). Здесь их объединение — правим только тут.
 *
 * Вход: тело файла Вычитки (абзацы через пустую строку, сноски хвостом внизу).
 * Выход: текст Контракта — <!-- sNNN -->, <!-- fnN -->, числовые [^N], <!-- pN -->.
 */

// вики-ссылки [[target|label]] → label, [[target]] → target
function delinkWiki(s) {
  return s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
}

/*
 * Маркер страницы в мастере (формат Вычитки): <!-- ص: 152 --> отдельной строкой
 * перед абзацем, с которого начинается страница тома. Ставится только в source/.
 * Принимаем и западные, и арабо-индийские цифры; на выходе — <!-- p152 --> Контракта.
 */
const PAGE_RE = /^<!--\s*(?:ص|p)\s*:?\s*([0-9٠-٩]+)\s*-->$/;
const SECTOR_RE = /^<!--\s*(s\d+)[a-z]?\s*-->$/i; // существующий якорь сектора (гибрид)
/*
 * Строка-картинка. Зеркало IMG_RE из parser.js — держать в синхроне при изменении
 * разметки. Здесь она нужна НЕ для рендера (это дело parser.js), а только чтобы
 * посчитать секторы-картинки для диагностики паритета (см. parityHint).
 */
const IMG_LINE_RE = /^!\[[^\]]*\]\([^)\s]+\)$/;
const toWesternDigits = s => s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
const isDef = l => /^\s*\[\^[^\]]+\]:/.test(l);

// YAML-фронтматтер мастера: срезать, вернуть title (в Контракт фронтматтер не идёт)
function stripFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: '', body: text };
  const tm = m[1].match(/^title:\s*(.+)$/m);
  const title = tm ? tm[1].trim().replace(/^["']|["']$/g, '') : '';
  return { title, body: text.slice(m[0].length) };
}

/*
 * Двуязычные секторы в translation/ (аят «۞арабский» или арабский хадис + русский
 * перевод вплотную) держат арабскую строку ради PDF-версии и паритета секторов.
 * В библиотеке арабский показывается из ar/ — из русской стороны эти строки
 * выбрасываем, иначе аят виден дважды. Сектор при этом остаётся.
 */
const AR_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
function isArabicLine(l) {
  if (/^\s*۞/.test(l)) return true;
  const letters = [...l].filter(ch => /\p{L}/u.test(ch));
  if (!letters.length) return false;
  return letters.filter(ch => AR_CHAR.test(ch)).length / letters.length > 0.7;
}

/*
 * Разбор тела на основной поток (блоки) и определения сносок.
 * Блок основного потока = абзац между пустыми строками; заголовок ## — отдельный блок.
 * Сноски лежат сплошным хвостом внизу файла.
 */
function parseBody(body) {
  const lines = delinkWiki(body).split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) if (isDef(lines[i])) { cut = i; break; }

  // основной поток
  let main = lines.slice(0, cut);
  while (main.length && (main[main.length - 1].trim() === '' || main[main.length - 1].trim() === '---')) main.pop();
  const blocks = [];
  let cur = null;
  let pendingPage = null; // страница из маркера — присвоится следующему блоку
  let pendingId = null;   // якорь из маркера — задаст ID следующему сектору
  const flush = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (const raw of main) {
    const l = raw.replace(/\s+$/, '');
    if (l.trim() === '' || l.trim() === '---') { flush(); continue; }
    const pm = l.trim().match(PAGE_RE);
    if (pm) { pendingPage = parseInt(toWesternDigits(pm[1]), 10); continue; }
    // существующий якорь <!-- sNNN --> — задаёт ID следующему сектору (гибрид):
    // сохраняем его, чтобы цитаты ar/ru парились по этому ID, а не по перенумерации
    const sm = l.trim().match(SECTOR_RE);
    if (sm) { flush(); pendingId = sm[1].toLowerCase(); continue; }
    const hm = l.match(/^(#{1,6})\s+(.*)$/);
    // Заголовок — самостоятельный, тут же закрытый блок. Сектором он НЕ становится
    // (см. convert): прицепляется к следующему текст-сектору как часть того же sNNN,
    // иначе лишний блок сдвинул бы посекторную парность с арабским оригиналом.
    if (hm) {
      flush();
      const hb = { kind: 'heading', lines: [hm[2].trim()] };
      if (pendingPage != null) { hb.page = pendingPage; pendingPage = null; }
      blocks.push(hb);
      continue;
    }
    if (!cur) { cur = { kind: 'text', lines: [], id: pendingId }; pendingId = null; }
    if (pendingPage != null && cur.page == null) { cur.page = pendingPage; pendingPage = null; }
    cur.lines.push(l);
  }
  flush();

  // сноски: каждый [^key]: ... + продолжения (пустые/с отступом) до следующего определения
  const defs = [];
  let d = null;
  for (const raw of lines.slice(cut)) {
    const m = raw.match(/^\s*\[\^([^\]]+)\]:\s?(.*)$/);
    if (m) { d = { key: m[1], lines: [m[2]] }; defs.push(d); }
    else if (d) d.lines.push(raw);
  }
  for (const def of defs) while (def.lines.length && def.lines[def.lines.length - 1].trim() === '') def.lines.pop();

  return { blocks, defs };
}

// ключ-сноски → номер по первому упоминанию в тексте (неотсылаемые определения — в хвост)
function numberFootnotes(blocks, defs) {
  const order = [];
  const seen = new Set();
  const note = k => { if (!seen.has(k)) { seen.add(k); order.push(k); } };
  for (const b of blocks) for (const l of b.lines) for (const m of l.matchAll(/\[\^([^\]]+)\]/g)) note(m[1]);
  for (const def of defs) note(def.key);
  const map = new Map();
  order.forEach((k, i) => map.set(k, i + 1));
  return map;
}

const renumber = (s, map) => s.replace(/\[\^([^\]]+)\]/g, (w, k) => map.has(k) ? `[^${map.get(k)}]` : w);

/*
 * Тело файла (source или translation) → текст в Контракте библиотеки.
 * dropArabic — для русской стороны: выбросить арабские строки из текст-секторов.
 * label — только для текстов предупреждений.
 *
 * Нумерация секторов:
 *  - если в исходнике есть якоря <!-- sNNN --> (гибрид) — они сохраняются, а
 *    абзацам без якоря выдаются свободные ID (занятые пропускаются);
 *  - иначе (полный параллельный формат) — сквозная s001, s002… с padding.
 *
 * Возвращает { content, sectors, anchored, droppedAyat, droppedOther, warnings }.
 */
function convert(body, { dropArabic = false, label = '' } = {}) {
  const { blocks, defs } = parseBody(body);
  const map = numberFootnotes(blocks, defs);
  const warnings = [];
  let droppedAyat = 0, droppedOther = 0;

  // строки текст-блока (с вырезкой арабского для русской стороны)
  const renderTextLines = (b) => {
    let lines = b.lines;
    if (dropArabic) {
      const kept = lines.filter(l => !isArabicLine(l));
      for (const l of lines) if (isArabicLine(l)) (/^\s*۞/.test(l) ? droppedAyat++ : droppedOther++);
      if (!kept.length) warnings.push(`${label} (заголовочный/пустой сектор): после вырезки арабского строк не осталось — проверь данные`);
      lines = kept;
    }
    return lines.map(l => renumber(l, map));
  };

  // Собираем секторы. Заголовок НЕ открывает свой сектор: он копится в pendingHeads
  // и прицепляется к следующему текст-сектору как ведущая часть того же baseId sNNN
  // (части a=заголовок(и), b=текст). Так заголовок виден, а число секторов = арабскому.
  const sectors = [];
  let pendingHeads = [];
  let pendingPage = null;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      if (b.page != null && pendingPage == null) pendingPage = b.page;
      pendingHeads.push(['**' + renumber(b.lines[0], map) + '**']);
      continue;
    }
    const page = (b.page != null) ? b.page : pendingPage;
    pendingPage = null;
    sectors.push({ page, parts: [...pendingHeads, renderTextLines(b)], id: b.id || null });
    pendingHeads = [];
  }
  // заголовки без последующего текста — доп. части последнего сектора (не новый сектор)
  if (pendingHeads.length) {
    if (sectors.length) sectors[sectors.length - 1].parts.push(...pendingHeads);
    else sectors.push({ page: pendingPage, parts: pendingHeads, id: null });
  }

  // гибрид с якорями vs сквозная нумерация (см. шапку функции)
  const anchored = sectors.some(sec => sec.id);
  const used = new Set();
  for (const sec of sectors) if (sec.id) { const n = parseInt(sec.id.slice(1), 10); if (Number.isFinite(n)) used.add(n); }
  let auto = 0;
  const nextAuto = () => { do { auto++; } while (used.has(auto)); return 's' + auto; };

  const out = [];
  let legacy = 0;
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  for (const sec of sectors) {
    if (sec.page != null) out.push(`<!-- p${sec.page} -->`);
    const base = anchored ? (sec.id || nextAuto()) : `s${String(++legacy).padStart(3, '0')}`;
    if (sec.parts.length === 1) {
      out.push(`<!-- ${base} -->`);
      for (const l of sec.parts[0]) out.push(l);
      out.push('');
    } else {
      sec.parts.forEach((pl, i) => {
        out.push(`<!-- ${base}${LETTERS[i]} -->`);
        for (const l of pl) out.push(l);
        out.push('');
      });
    }
  }
  if (dropArabic) {
    for (const def of defs) {
      if (def.lines.some(isArabicLine)) warnings.push(`${label} сноска [^${def.key}]: арабская строка внутри русской сноски — НЕ выброшена, проверь`);
    }
  }
  for (const def of [...defs].sort((a, b) => map.get(a.key) - map.get(b.key))) {
    out.push(`<!-- fn${map.get(def.key)} -->`);
    for (const l of def.lines) out.push(renumber(l, map));
    out.push('');
  }
  const content = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  // секторы, состоящие только из картинки — для диагностики паритета (см. parityHint)
  const imageOnly = sectors.filter(sec => {
    const ls = sec.parts.reduce((acc, p) => acc.concat(p), []).filter(l => l.trim());
    return ls.length > 0 && ls.every(l => IMG_LINE_RE.test(l));
  }).length;
  return { content, sectors: sectors.length, anchored, imageOnly, droppedAyat, droppedOther, warnings };
}

/*
 * Подсказка, когда посекторный паритет ar↔ru разошёлся.
 *
 * Частая и совершенно неочевидная причина — картинка, поставленная ОТДЕЛЬНЫМ абзацем
 * (пустая строка вокруг): для конвертера это лишний сектор, счёт расходится, и сторона
 * целиком уезжает в заглушку. Автор при этом видит только «нет паритета: 1» и не может
 * догадаться, что виновата картинка. Прицепленная к абзацу (без пустой строки) картинка
 * живёт внутри существующего сектора и паритет не трогает.
 *
 * Возвращает строку-подсказку или null, если картинки разницу не объясняют.
 */
function parityHint(orig, trans) {
  const d = (trans.sectors || 0) - (orig.sectors || 0);
  if (!d) return null;
  const di = (trans.imageOnly || 0) - (orig.imageOnly || 0);
  const advice = 'прицепи ![…](…) к соседнему абзацу — без пустой строки перед картинкой';
  const whole = n => Math.abs(n) === Math.abs(d) ? ' — это объясняет всю разницу' : '';
  if (d > 0 && di > 0) return `в переводе картинок отдельным абзацем на ${di} больше, чем в оригинале; каждая такая — лишний сектор${whole(di)}. Либо ${advice}, либо поставь парную картинку в оригинал.`;
  if (d < 0 && di < 0) return `в оригинале картинок отдельным абзацем на ${-di} больше, чем в переводе; каждая такая — лишний сектор${whole(di)}. Либо ${advice}, либо поставь парную картинку в перевод.`;
  return null;
}

// Node — require; браузер — глобал window.Contract (см. шапку: файл двусредный)
const API = { parseBody, convert, parityHint, delinkWiki, isArabicLine, numberFootnotes, stripFrontmatter, renumber };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof window !== 'undefined') window.Contract = API;
