#!/usr/bin/env node
'use strict';

/*
 * Глоссарий книги (SPEC 3.4f): мастер Obsidian → glossary.json рядом с book.json.
 *
 *   node tools/import-glossary.js <glossary.md> books/<id>
 *
 * Мастер — статьи под заголовками «## якорь» (как translation/1/glossary.md фатавы);
 * статья — всё до следующего «## ». Название термина — первое **жирное** в статье,
 * иначе сам якорь. Вики-ссылки ([[…|подпись]]) становятся подписью: в читалке их
 * открыть некуда. Ссылки на другие статьи ([`термин`](glossary.md#якорь)) остаются —
 * в плашке по ним переходят дальше. В book.json ставится "glossary": "glossary.json".
 */

const fs = require('fs');
const path = require('path');
const { delinkWiki } = require(path.join(__dirname, '..', 'contract.js'));
const { glossaryAnchor } = require(path.join(__dirname, '..', 'parser.js'));

const [src, dir] = process.argv.slice(2);
if (!src || !dir) {
  console.error('Использование: node tools/import-glossary.js <glossary.md> books/<id>');
  process.exit(1);
}
const bookPath = path.join(dir, 'book.json');
if (!fs.existsSync(bookPath)) { console.error(`Нет ${bookPath} — сначала опубликуйте книгу`); process.exit(1); }

const text = fs.readFileSync(src, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '');
const entries = {};
let cur = null;
for (const line of text.split(/\r?\n/)) {
  const h = line.match(/^##\s+(.+?)\s*$/);
  if (h) { cur = { key: glossaryAnchor(h[1]), lines: [] }; entries[cur.key] = cur; continue; }
  if (cur) cur.lines.push(line);
}
const out = {};
for (const [key, e] of Object.entries(entries)) {
  const md = delinkWiki(e.lines.join('\n')).trim();
  const bold = md.match(/\*\*([^*]+)\*\*/);
  out[key] = { term: bold ? bold[1].trim() : key, md };
}
fs.writeFileSync(path.join(dir, 'glossary.json'), JSON.stringify({ entries: out }, null, 1) + '\n');
const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
book.glossary = 'glossary.json';
fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + '\n');
console.log(`Глоссарий: ${Object.keys(out).length} статей → ${path.join(dir, 'glossary.json')}`);
