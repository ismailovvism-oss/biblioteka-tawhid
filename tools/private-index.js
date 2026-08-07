#!/usr/bin/env node
'use strict';

/*
 * Локальный реестр непубличных книг: манифесты из books-private/ → books-private/index.json.
 *
 * Зачем генерировать, а не вести руками: реестр — производная от манифестов, и стоит
 * ему разъехаться (переименовали книгу, сменили теги), как полка показывает одно, а
 * открывается другое. Публичный books/index.json ведётся руками потому, что в нём есть
 * своя, не выводимая из книги информация (review, progress, обложки, классификация);
 * здесь этого нет — книги личные.
 *
 * Формат совпадает с books/index.json, чтобы полка рисовала их теми же полями.
 * Файл — как и вся папка — под .gitignore и в репозиторий не уходит.
 *
 * Использование: node tools/private-index.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'books-private');

if (!fs.existsSync(DIR)) {
  console.log('books-private/ нет — непубличных книг локально не заведено.');
  process.exit(0);
}

const books = [];
for (const name of fs.readdirSync(DIR).sort()) {
  const manifestPath = path.join(DIR, name, 'book.json');
  if (!fs.existsSync(manifestPath)) continue;
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const id = m.bookId || name;
  const entry = {
    id,
    base: `books-private/${name}/`,
    title: m.title,
    langs: m.languages || [],
    category: m.category || 'misc',
    tags: m.tags || [],
  };
  if (m.author) entry.authors = [m.author];
  if (Array.isArray(m.authors) && m.authors.length) entry.authors = m.authors;
  if (m.description) entry.description = m.description;
  if (fs.existsSync(path.join(DIR, name, 'cover.jpg'))) entry.cover = `books-private/${name}/cover.jpg`;
  books.push(entry);
  console.log(`  · ${id} — ${(m.chapters || []).filter(c => c.file).length} глав`);
}

fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ books }, null, 2) + '\n');
console.log(`Реестр: ${books.length} непубличных книг → books-private/index.json`);
