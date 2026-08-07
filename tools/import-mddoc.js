#!/usr/bin/env node
'use strict';

/*
 * АДАПТЕР ВНЕШНЕГО ИСТОЧНИКА: цельный markdown-документ → книга в формате Контракта.
 *
 * Зачем отдельный адаптер. Формат Вычитки (source/translation, файл = глава) уже умеет
 * `contract.js`, и под него новые импортёры писать не надо (CLAUDE.md). Но бывает вход
 * другого рода: один большой .md-документ с заголовками — глав в нём нет, есть дерево
 * «# ЧАСТЬ → ## Раздел». Задача адаптера — только РАЗРЕЗАТЬ такой документ на главы и
 * собрать иерархию; всё, что касается самого Контракта (секторы sNNN, сноски, страницы),
 * делает ядро `contract.js`. Логику Контракта здесь НЕ дублировать.
 *
 * Одноязычный выход (`languages: [lang]`): у документа нет параллельного оригинала.
 *
 * Использование:
 *   node tools/import-mddoc.js <config.json> <папка-книги>
 *
 * Конфиг (см. пример в BACKEND.md / рядом с книгой):
 * {
 *   "bookId": "logika", "lang": "ru",
 *   "title": {...}, "author": "...", "description": "...", "category": "...", "tags": [...],
 *   "sources": [ {
 *      "file": "/путь/к/файлу.md",
 *      "group": "Логика с нуля — учебник",   // header-запись верхнего уровня; одинаковый
 *                                            // group у нескольких файлов = один раздел
 *      "chapterDepth": 2,        // глубина заголовка, который становится ГЛАВОЙ
 *                                //   (# = 1, ## = 2). Мельче — header-записи дерева,
 *                                //   глубже — обычный текст главы
 *      "partRe": "^ЧАСТЬ\\b",    // где кончается преамбула и начинается тело документа
 *      "intro": "О книге",       // преамбула → отдельная глава с таким названием (null — выбросить)
 *      "skip": ["^Оглавление$"]  // разделы, которые не переносим (у приложения своё оглавление)
 *   } ]
 * }
 */

const fs = require('fs');
const path = require('path');
const Contract = require(path.join(__dirname, '..', 'contract.js'));

const [, , CFG, OUT] = process.argv;
if (!CFG || !OUT) {
  console.error('Использование: node tools/import-mddoc.js <config.json> <папка-книги>');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const LANG = cfg.lang || 'ru';

/* ── документ → плоский список секций по заголовкам ──────────────────────────
   Ограда ```…``` неприкосновенна: внутри неё «# …» — часть ASCII-схемы или формулы,
   а не заголовок (в этих книгах ограды сплошь занимает формальная запись). */
function sectionsOf(text) {
  const out = [];
  let cur = { depth: 0, title: null, lines: [] };   // всё до первого заголовка
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) fence = !fence;
    const h = !fence && raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(cur);
      cur = { depth: h[1].length, title: h[2].trim(), lines: [] };
      continue;
    }
    cur.lines.push(raw);
  }
  out.push(cur);
  return out;
}

/* Заголовок глубже главы остаётся заголовком внутри текста — ядро превратит его в
   ведущую **жирную** часть того же сектора. Восстанавливаем строку как было. */
const headingLine = s => '#'.repeat(s.depth) + ' ' + s.title;

/* Название главы уходит в book.json и рисуется в оглавлении ТЕКСТОМ, а не markdown’ом:
   «Софизмы (*fallaciae*, мугалатат)» показался бы со звёздочками. Снимаем разметку
   выделения (`**`, `*`, `_`, `` ` ``) — в заголовке она всё равно не несёт смысла. */
const plainTitle = t => t
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/<\/?u>/g, '')
  .trim();

const nonEmpty = lines => lines.some(l => l.trim() && l.trim() !== '---');

/* ── сборка ──────────────────────────────────────────────────────────────── */
const chapters = [];          // записи манифеста (header-записи и главы)
const files = [];             // { name, body } — тела глав до конвертации
const warnings = [];
let seenGroups = new Set();

function addChapter(title, level, bodyLines) {
  const name = String(files.length + 1).padStart(2, '0') + '.md';
  files.push({ name, body: bodyLines.join('\n') });
  chapters.push({ file: name, title: { [LANG]: plainTitle(title) }, level });
}

for (const src of cfg.sources) {
  const text = fs.readFileSync(src.file, 'utf8');
  const secs = sectionsOf(text);
  const partRe = src.partRe ? new RegExp(src.partRe) : null;
  const skipRes = (src.skip || []).map(r => new RegExp(r));
  const chapterDepth = src.chapterDepth || 1;

  // header-запись раздела (одна на group, даже если файлов несколько)
  let base = 0;
  if (src.group) {
    if (!seenGroups.has(src.group)) {
      seenGroups.add(src.group);
      chapters.push({ header: true, title: { [LANG]: plainTitle(src.group) }, level: 0 });
    }
    base = 1;   // всё внутри группы уезжает на уровень глубже
  }

  // граница преамбулы: первая секция, попавшая под partRe (или первая секция-глава)
  let bodyStart = secs.findIndex(s => s.title && (partRe ? partRe.test(s.title) : s.depth <= chapterDepth));
  /* Не совпавший partRe — не «книга из одной преамбулы», а почти всегда опечатка в
     конфиге (классика: `\b` в JS работает по ASCII и с кириллицей не срабатывает).
     Молча свалить весь документ в одну главу — худший исход, поэтому кричим. */
  if (bodyStart < 0) {
    warnings.push(`${path.basename(src.file)}: partRe ${src.partRe} не совпал ни с одним заголовком — документ не разрезан на главы, проверь конфиг`);
    bodyStart = secs.length;
  }

  /* Преамбула: шапка документа (заголовок + подзаголовок + вводный курсив). Первый
     заголовок — это название самого документа, оно уже стоит в book.json.title,
     повторять его главой незачем; остальные заголовки преамбулы оставляем текстом. */
  const pre = [];
  for (let i = 0; i < bodyStart; i++) {
    const s = secs[i];
    if (s.title && skipRes.some(r => r.test(s.title))) continue;
    if (s.title && !(i === 1 && s.depth === 1)) pre.push(headingLine(s));
    pre.push(...s.lines);
  }
  if (src.intro && nonEmpty(pre)) addChapter(src.intro, base, pre);

  // тело: header-записи (depth < chapterDepth), главы (== ), текст (> )
  let cur = null;                 // накопитель текущей главы
  let pendingLead = [];           // текст под header-записью до её первой главы
  const flush = () => {
    if (!cur) return;
    if (nonEmpty(cur.lines)) addChapter(cur.title, cur.level, cur.lines);
    else warnings.push(`${path.basename(src.file)}: «${cur.title}» — пустая глава, выброшена`);
    cur = null;
  };

  for (let i = bodyStart; i < secs.length; i++) {
    const s = secs[i];
    if (s.title && skipRes.some(r => r.test(s.title))) { flush(); continue; }

    if (s.depth && s.depth < chapterDepth) {
      flush();
      chapters.push({ header: true, title: { [LANG]: plainTitle(s.title) }, level: base + s.depth - 1 });
      // вводный текст части живёт до первой главы — прицепим его к ней
      pendingLead = nonEmpty(s.lines) ? s.lines.slice() : [];
      continue;
    }
    if (s.depth === chapterDepth) {
      flush();
      cur = { title: s.title, level: base + s.depth - 1, lines: pendingLead.concat(s.lines) };
      pendingLead = [];
      continue;
    }
    // глубже главы — обычный текст с заголовком внутри
    if (!cur) { warnings.push(`${path.basename(src.file)}: «${s.title || '(без заголовка)'}» вне главы — пропущено`); continue; }
    cur.lines.push(headingLine(s), ...s.lines);
  }
  flush();
}

/* ── тела глав → Контракт (ядром) ────────────────────────────────────────── */
fs.mkdirSync(path.join(OUT, LANG), { recursive: true });
let total = 0;
for (const f of files) {
  const r = Contract.convert(f.body, { label: f.name });
  fs.writeFileSync(path.join(OUT, LANG, f.name), r.content);
  total += r.sectors;
  for (const w of r.warnings) warnings.push(w);
}

/* ── манифест ────────────────────────────────────────────────────────────── */
const prevPath = path.join(OUT, 'book.json');
const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : {};
const manifest = Object.assign({}, prev, {
  bookId: cfg.bookId,
  title: cfg.title,
  author: cfg.author,
  description: cfg.description,
  languages: [LANG],
  rtl: [],
  category: cfg.category,
  tags: cfg.tags || [],
  chapters,
  hasImages: false,
});
fs.writeFileSync(prevPath, JSON.stringify(manifest, null, 2) + '\n');

/* ── отчёт ───────────────────────────────────────────────────────────────── */
const heads = chapters.filter(c => c.header).length;
for (const w of warnings) console.log('  ! ' + w);
console.log(`Готово: ${files.length} глав, ${heads} записей-групп, ${total} секторов → ${OUT}`);
