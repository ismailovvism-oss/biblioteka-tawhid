#!/usr/bin/env node
'use strict';

/*
 * Импорт одноязычной книги из старого формата Шамили 3 (`.bok`).
 *
 * Шаг 1 (питон, читает Access):
 *   ~/projects/shamela-books/.venv/bin/python ~/projects/shamela-books/bok2md.py \
 *       книга.bok --куда /tmp/сырьё --id <bookId>
 * Шаг 2 (здесь, пишет Контракт):
 *   node tools/import-bok.js /tmp/сырьё
 *
 * Почему два шага: `.bok` — это база Microsoft Access, её читает питон; а Контракт
 * пишет только `contract.js` — второго писателя заводить нельзя, один раз это уже
 * кончилось молчаливым расхождением с Вычиткой.
 *
 * Выход: books/<id>/ar/NN.md (Контракт), books/<id>/book.json, запись в index.json.
 * Классификация (category/tags/era) в реестре не трогается — задаётся руками.
 */

const fs = require('fs');
const path = require('path');
const { convert } = require(path.join(__dirname, '..', 'contract.js'));

const СЫРЬЁ = process.argv[2];
if (!СЫРЬЁ) {
  console.error('Использование: node tools/import-bok.js <папка-сырья>');
  process.exit(1);
}

const КОРЕНЬ = path.resolve(__dirname, '..');
const книга = JSON.parse(fs.readFileSync(path.join(СЫРЬЁ, 'книга.json'), 'utf8'));
const язык = книга.язык || 'ar';
const id = книга.id;
if (!id) { console.error('В книга.json нет id'); process.exit(1); }

const ВЫХОД = path.join(КОРЕНЬ, 'books', id);
fs.mkdirSync(path.join(ВЫХОД, язык), { recursive: true });

console.log(`Книга: ${книга.title || id}`);

const главы = [];
let секторов = 0;
const жалобы = [];

for (const гл of книга.chapters) {
  const тело = fs.readFileSync(path.join(СЫРЬЁ, язык, гл.file), 'utf8');
  const готово = convert(тело, { label: гл.file });
  fs.writeFileSync(path.join(ВЫХОД, язык, гл.file), готово.content);
  секторов += готово.sectors;
  жалобы.push(...готово.warnings);
  главы.push({ file: гл.file, title: { [язык]: гл.title } });
}

// Односторонняя книга: языков ровно один, он же rtl для арабского.
const манифест = {
  bookId: id,
  title: { [язык]: книга.title || id },
  languages: [язык],
  rtl: язык === 'ar' ? [язык] : [],
  chapters: главы,
  hasImages: false,
};
if (книга.author) манифест.author = { [язык]: книга.author };
if (книга.карточка) манифест.description = книга.карточка;
fs.writeFileSync(path.join(ВЫХОД, 'book.json'), JSON.stringify(манифест, null, 2) + '\n');

// реестр: классификацию, что уже проставлена руками, сохраняем через ...прежняя
const реестрП = path.join(КОРЕНЬ, 'books', 'index.json');
const реестр = JSON.parse(fs.readFileSync(реестрП, 'utf8'));
const прежняя = реестр.books.find(b => b.id === id) || {};
реестр.books = реестр.books.filter(b => b.id !== id);
реестр.books.push({
  ...прежняя,
  id,
  base: `books/${id}/`,
  title: манифест.title,
  langs: манифест.languages,
  authors: прежняя.authors || (книга.author ? [книга.author] : undefined),
});
fs.writeFileSync(реестрП, JSON.stringify(реестр, null, 2) + '\n');

console.log(`  глав: ${главы.length}, секторов: ${секторов}`);
if (жалобы.length) {
  console.log('  замечания Контракта:');
  for (const ж of жалобы.slice(0, 10)) console.log('   • ' + ж);
  if (жалобы.length > 10) console.log(`   … и ещё ${жалобы.length - 10}`);
}
console.log(`  записано: books/${id}/`);
console.log('\nДальше: проставить category/era/tags в books/index.json и прогнать');
console.log(`  node tools/validate.js books/${id} && node tools/doctor.js`);
