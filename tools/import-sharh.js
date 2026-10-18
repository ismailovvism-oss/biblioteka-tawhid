#!/usr/bin/env node
'use strict';

/*
 * Книга шарха (SPEC 3.4g): папка статей шарха из Obsidian → одноязычная книга.
 *
 *   node tools/import-sharh.js <папка-статей> books/<id-шарха> --title "Название"
 *        [--for books/<id-текста>] [--glossary books/<id>/glossary.json]
 *
 * Статья = глава. Порядок — по номеру страницы в начале имени файла («392-…»), файлы
 * на «0-» (оглавления Obsidian) пропускаются: оглавление строит сама читалка.
 * Название главы — title из шапки, иначе имя файла без номера; key — имя файла: по
 * нему и по названию значок 💡 у абзаца находит свою статью. Строка-навигация
 * Obsidian из одних вики-ссылок ([[…]] | [[…]]) выбрасывается. Текст идёт через
 * ядро Контракта, как публикация из Вычитки (арабские цитаты остаются).
 * --for ставит книге текста "sharh": "<id-шарха>"; --glossary кладёт тот же глоссарий
 * и в книгу шарха, чтобы термины нажимались и там.
 */

const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', 'contract.js'));

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const title = opt('--title');
const forBook = opt('--for');
const glossary = opt('--glossary');
const [src, dir] = args;
if (!src || !dir || !title) {
  console.error('Использование: node tools/import-sharh.js <папка-статей> books/<id-шарха> --title "…" [--for books/<id>] [--glossary …/glossary.json]');
  process.exit(1);
}
const id = path.basename(path.resolve(dir));
const pageOf = f => { const m = f.match(/^(\d+)/); return m ? parseInt(m[1], 10) : Infinity; };
const files = fs.readdirSync(src).filter(f => f.endsWith('.md') && !/^0-/.test(f))
  .sort((a, b) => pageOf(a) - pageOf(b) || a.localeCompare(b, 'ru'));
const NAV_LINE = /^\s*\[\[[^\]]+\]\](\s*\|\s*\[\[[^\]]+\]\])*\s*$/;

fs.mkdirSync(path.join(dir, 'ru'), { recursive: true });
const chapters = [];
files.forEach((f, i) => {
  const raw = fs.readFileSync(path.join(src, f), 'utf8');
  const { title: t, body } = C.stripFrontmatter(raw);
  const key = f.replace(/\.md$/, '');
  const name = t || key.replace(/^\d+(?:-\d+)?\s*-\s*/, '');
  const clean = body.split(/\r?\n/).filter(l => !NAV_LINE.test(l)).join('\n');
  const r = C.convert(clean, { label: f });
  r.warnings.forEach(w => console.log('  ⚠ ' + w));
  const file = String(i + 1).padStart(2, '0') + '.md';
  fs.writeFileSync(path.join(dir, 'ru', file), r.content);
  chapters.push({ file, title: { ru: name }, key });
});
const prev = fs.existsSync(path.join(dir, 'book.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8')) : {};
const book = { ...prev, bookId: id, title: { ru: title }, languages: ['ru'], rtl: [], chapters, type: 'sharh' };
if (forBook) book.sharhOf = path.basename(path.resolve(forBook));
if (glossary) { fs.copyFileSync(glossary, path.join(dir, 'glossary.json')); book.glossary = 'glossary.json'; }
fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify(book, null, 2) + '\n');
console.log(`Книга шарха «${title}»: ${chapters.length} статей → ${dir}`);
if (forBook) {
  const bp = path.join(forBook, 'book.json');
  const tb = JSON.parse(fs.readFileSync(bp, 'utf8'));
  tb.sharh = id;
  fs.writeFileSync(bp, JSON.stringify(tb, null, 2) + '\n');
  console.log(`Книге ${tb.bookId} назначен шарх: "sharh": "${id}"`);
}
