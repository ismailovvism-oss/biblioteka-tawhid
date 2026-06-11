'use strict';

/*
 * Импорт книги «Тауфик аль-Маннан» (репозиторий tawfiq-al-mannan) в формат читалки.
 *
 * Выравнивание (контракт «Вычитки», CLAUDE.md): секторы = абзацы по одной пустой
 * строке; одинаковые по счёту секторы source/ и translation/ спарены по порядку.
 * Аят (۞арабский + русский вплотную) = один сектор. Сноски — внизу файла, своя
 * нумерация на каждом языке.
 *
 * Выход: books/tawfiq/{ar,ru}/<метка>.md (Контракт: <!-- sNNN -->, <!-- fnN -->,
 *        числовые [^N]) + books/tawfiq/book.json, регистрация в books/index.json.
 * sNNN назначаются по порядку блоков отдельно на каждой стороне — на главах с равным
 * числом блоков индексы совпадают, и пары sNNN сходятся сами.
 *
 * Запуск:  node tools/import-tam.js [путь-к-клону-tawfiq-al-mannan]   (по умолчанию /tmp/tam-book)
 */

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/tmp/tam-book';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'books', 'tawfiq');
const BOOK_ID = 'tawfiq';
const BOOK_TITLE = { ar: 'توفيق المنان', ru: 'Тауфик аль-Маннан' };

function chapterFiles() {
  // естественный порядок частей: 06a < 06a-2 < 06a-2-2 < 06b
  // (лексически дефис стоит раньше точки, и 06a-2.md сортировался ПЕРЕД 06a.md)
  const key = f => {
    const m = f.match(/^(\d+)([a-z]?)(?:-(\d+))?(?:-(\d+))?/);
    return [+m[1], m[2] || '', +(m[3] || 0), +(m[4] || 0)];
  };
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  return fs.readdirSync(path.join(SRC, 'translation'))
    .filter(f => f.endsWith('.md'))
    .sort(cmp);
}

function stripFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: '', body: text };
  const tm = m[1].match(/^title:\s*(.+)$/m);
  const title = tm ? tm[1].trim().replace(/^["']|["']$/g, '') : '';
  return { title, body: text.slice(m[0].length) };
}

// вики-ссылки [[target|label]] → label, [[target]] → target
function delinkWiki(s) {
  return s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
}

const isDef = l => /^\s*\[\^[^\]]+\]:/.test(l);

/*
 * Маркер страницы в мастере (формат Вычитки): <!-- ص: 152 --> отдельной строкой
 * перед абзацем, с которого начинается страница тома. Ставится только в source/.
 * Принимаем и западные, и арабо-индийские цифры; на выходе — <!-- p152 --> Контракта.
 */
const PAGE_RE = /^<!--\s*(?:ص|p)\s*:?\s*([0-9٠-٩]+)\s*-->$/;
const toWesternDigits = s => s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));

/*
 * Разбор тела на основной поток (блоки) и определения сносок.
 * Блок основного потока = абзац между пустыми строками; заголовок ## — отдельный блок.
 * Сноски лежат сплошным хвостом внизу файла.
 */
function parse(body) {
  const lines = delinkWiki(body).split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) if (isDef(lines[i])) { cut = i; break; }

  // основной поток
  let main = lines.slice(0, cut);
  while (main.length && (main[main.length - 1].trim() === '' || main[main.length - 1].trim() === '---')) main.pop();
  const blocks = [];
  let cur = null;
  let pendingPage = null; // страница из маркера — присвоится следующему блоку
  const flush = () => { if (cur && cur.lines.length) blocks.push(cur); cur = null; };
  for (const raw of main) {
    const l = raw.replace(/\s+$/, '');
    if (l.trim() === '' || l.trim() === '---') { flush(); continue; }
    const pm = l.trim().match(PAGE_RE);
    if (pm) { pendingPage = parseInt(toWesternDigits(pm[1]), 10); continue; }
    const hm = l.match(/^(#{1,6})\s+(.*)$/);
    // заголовок открывает блок, но НЕ закрывает его: склеенный с абзацем заголовок
    // (без пустой строки) — один сектор, как в Вычитке (секторы только по пустым строкам)
    if (hm) { flush(); cur = { kind: 'heading', lines: [hm[2].trim()] }; }
    else if (!cur) cur = { kind: 'text', lines: [] };
    if (pendingPage != null && cur.page == null) { cur.page = pendingPage; pendingPage = null; }
    if (!hm) cur.lines.push(l);
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
 * Двуязычные секторы в translation/ (аят «۞арабский» или арабский хадис + русский
 * перевод вплотную) держат арабскую строку ради PDF-версии и паритета секторов.
 * В читалке арабский показывается из ar/ — из русской стороны эти строки выбрасываем,
 * иначе аят виден дважды. Сектор при этом остаётся (число секторов не меняется).
 */
const AR_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
function isArabicLine(l) {
  if (/^\s*۞/.test(l)) return true;
  const letters = [...l].filter(ch => /\p{L}/u.test(ch));
  if (!letters.length) return false;
  return letters.filter(ch => AR_CHAR.test(ch)).length / letters.length > 0.7;
}

// тело файла (source или translation) → текст в Контракте читалки + число секторов
// dropArabic — для русской стороны: выбросить арабские строки из текст-секторов
function convert(body, { dropArabic = false, label = '' } = {}) {
  const { blocks, defs } = parse(body);
  const map = numberFootnotes(blocks, defs);
  const out = [];
  let s = 0;
  let droppedAyat = 0, droppedOther = 0;
  for (const b of blocks) {
    if (b.page != null) out.push(`<!-- p${b.page} -->`);
    out.push(`<!-- s${String(++s).padStart(3, '0')} -->`);
    if (b.kind === 'heading') {
      out.push('**' + renumber(b.lines[0], map) + '**');
      for (const l of b.lines.slice(1)) out.push(renumber(l, map));
    } else {
      let lines = b.lines;
      if (dropArabic) {
        const kept = lines.filter(l => !isArabicLine(l));
        for (const l of lines) if (isArabicLine(l)) (/^\s*۞/.test(l) ? droppedAyat++ : droppedOther++);
        if (!kept.length) console.warn(`  ⚠ ${label} s${String(s).padStart(3, '0')}: сектор состоял только из арабских строк — оставлен пустым, проверь данные`);
        lines = kept;
      }
      for (const l of lines) out.push(renumber(l, map));
    }
    out.push('');
  }
  if (dropArabic) {
    for (const def of defs) {
      if (def.lines.some(isArabicLine)) console.warn(`  ⚠ ${label} сноска [^${def.key}]: арабская строка внутри русской сноски — НЕ выброшена, проверь`);
    }
  }
  for (const def of [...defs].sort((a, b) => map.get(a.key) - map.get(b.key))) {
    out.push(`<!-- fn${map.get(def.key)} -->`);
    for (const l of def.lines) out.push(renumber(l, map));
    out.push('');
  }
  const content = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return { content, sectors: s, droppedAyat, droppedOther };
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'translation'))) {
    console.error(`Не найден ${SRC}/translation — укажи путь к клону tawfiq-al-mannan.`);
    process.exit(1);
  }
  for (const lang of ['ar', 'ru']) {
    fs.rmSync(path.join(OUT, lang), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  }

  const chapters = [];
  const mismatches = [];
  const dropReport = [];
  for (const file of chapterFiles()) {
    const tr = stripFrontmatter(fs.readFileSync(path.join(SRC, 'translation', file), 'utf8'));
    const ru = convert(tr.body, { dropArabic: true, label: file });
    if (ru.droppedAyat || ru.droppedOther) dropReport.push(`${file}: аятов ${ru.droppedAyat}, прочих арабских строк ${ru.droppedOther}`);
    fs.writeFileSync(path.join(OUT, 'ru', file), ru.content);

    const srcPath = path.join(SRC, 'source', file);
    const ar = fs.existsSync(srcPath) ? convert(fs.readFileSync(srcPath, 'utf8')) : { content: '', sectors: 0 };
    // арабский выдаём только при точном посекторном паритете — иначе середина
    // главы молча спарилась бы неверно; до правки паритета глава читается по-русски
    if (ar.sectors === ru.sectors && ar.sectors > 0) {
      fs.writeFileSync(path.join(OUT, 'ar', file), ar.content);
    } else {
      fs.writeFileSync(path.join(OUT, 'ar', file),
        '<!-- арабский оригинал этой главы ещё не выровнен посекторно (паритет правится в Вычитке) -->\n');
      mismatches.push(`${file}: ar=${ar.sectors} ru=${ru.sectors} (Δ${ru.sectors - ar.sectors})`);
    }
    chapters.push({ file, title: { ru: tr.title || file.replace(/\.md$/, '') } });
  }

  // сканы страниц: books/tawfiq/img/pN.jpg, N = книжная страница (= pdf-страница − 2)
  const book = {
    bookId: BOOK_ID, title: BOOK_TITLE, languages: ['ar', 'ru'], rtl: ['ar'], chapters,
    hasImages: true, imagePattern: 'img/p{page}.jpg',
    feedbackEmail: 'qaadiy@gmail.com', // кнопка «✉ Ошибка?» в читалке
  };
  fs.writeFileSync(path.join(OUT, 'book.json'), JSON.stringify(book, null, 2) + '\n');

  const idxPath = path.join(ROOT, 'books', 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const prev = idx.books.find(b => b.id === BOOK_ID) || {};
  idx.books = idx.books.filter(b => b.id !== BOOK_ID);
  idx.books.push({ ...prev, id: BOOK_ID, base: 'books/tawfiq/', title: BOOK_TITLE });
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n');

  console.log(`Готово: ${chapters.length} глав → books/tawfiq/{ar,ru}/, book.json, index.json.`);
  console.log(`Параллель ar↔ru: ${chapters.length - mismatches.length}/${chapters.length} глав выровнены ✓`);
  if (dropReport.length) {
    console.log(`Из русской стороны выброшены арабские строки двуязычных секторов (арабский остаётся в ar/):`);
    for (const r of dropReport) console.log('  ' + r);
  }
  if (mismatches.length) {
    console.log(`Пока без арабского (нужен паритет абзацев в Вычитке) — ${mismatches.length}:`);
    for (const m of mismatches) console.log('  ' + m);
  }
}

main();
