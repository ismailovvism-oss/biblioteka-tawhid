#!/usr/bin/env node
'use strict';

/*
 * CLI-валидатор контракта книги (SPEC, раздел 6) — тот же парсер, что в приложении.
 * Использование: node tools/validate.js books/<bookId>
 * Код выхода 1, если найдены ошибки контракта.
 */

const fs = require('fs');
const path = require('path');
const { buildChapter } = require(path.join(__dirname, '..', 'parser.js'));

const dir = process.argv[2];
if (!dir) {
  console.error('Использование: node tools/validate.js books/<bookId>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
console.log(`Книга: ${manifest.bookId} — ${manifest.title[manifest.languages[1]] || manifest.title[manifest.languages[0]] || ''}`);

let total = 0;
for (const ch of manifest.chapters) {
  // запись-группа (header) — заголовок без файла, читать нечего
  if (!ch.file) continue;

  // Гибридная книга: главы у языка может не быть (напр. проза только в переводе).
  // Как в читалке (loadChapterData) — нет файла, значит пусто, а не падение.
  const texts = {};
  const missing = [];
  for (const lang of manifest.languages) {
    try {
      texts[lang] = fs.readFileSync(path.join(dir, lang, ch.file), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      texts[lang] = '';
      missing.push(lang);
    }
  }
  const { pairs, warnings } = buildChapter(texts, manifest.languages);
  const fnCount = pairs.filter(p => p.type === 'footnote').length;
  const pages = [...new Set(pairs.map(p => p.page).filter(p => p != null))];
  const only = missing.length
    ? `, только ${manifest.languages.filter(l => !missing.includes(l)).join('+') || '—'}`
    : '';
  console.log(
    `  ${ch.file}: секторов ${pairs.length - fnCount}, сносок ${fnCount}, страницы: ${pages.join(', ') || '—'}${only}`
  );
  for (const w of warnings) {
    console.log('    ⚠ ' + w);
    total++;
  }
}

console.log(total ? `\nОшибок контракта: ${total}` : '\nКонтракт соблюдён ✓');
process.exit(total ? 1 : 0);
