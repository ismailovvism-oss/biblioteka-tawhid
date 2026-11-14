#!/usr/bin/env node
'use strict';

/*
 * Миниатюры обложек для полки.
 *
 * Обложка книги (`cover.jpg`) — 800–910 px в ширину и 100–390 КБ; на карточке книги она
 * нужна такой, а на полке показывается в слоте шириной около 100 px. Девять книг давали
 * два мегабайта на первый экран (замер 14.11.2026) — с телефона на мобильной сети полка
 * несколько секунд стояла с пустыми обложками. Поэтому рядом с каждой обложкой лежит
 * `cover-thumb.jpg` шириной 320 px (хватает на экран с тройной плотностью), а в реестре —
 * поле `thumb`. Полка берёт `thumb`, карточка книги — `cover` (app.js, coverInto).
 *
 * Использование: node tools/gen-thumbs.js [--заново]
 *   --заново — пересоздать все миниатюры, даже свежие.
 *
 * Что делает:
 *   1. для каждой книги реестра с обложкой создаёт миниатюру, если её нет или обложка новее;
 *   2. дописывает в books/index.json строку "thumb" сразу после "cover" — правкой текста,
 *      остальное форматирование файла не трогается;
 *   3. то же для books-private/<книга>/cover.jpg (только файлы: реестр непубличных книг
 *      пересобирает tools/private-index.js, он сам подхватит миниатюру).
 *
 * Нужен ImageMagick (команда `magick`). Запускать после добавления или замены обложки.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const КОРЕНЬ = path.join(__dirname, '..');
const РЕЕСТР = path.join(КОРЕНЬ, 'books', 'index.json');
const ШИРИНА = 320;
const заново = process.argv.includes('--заново');

const миниатюраДля = обложка => обложка.replace(/[^/]+$/, 'cover-thumb.jpg');

function сделать(обложкаП, миниП) {
  const свежая = fs.existsSync(миниП) && fs.statSync(миниП).mtimeMs >= fs.statSync(обложкаП).mtimeMs;
  if (свежая && !заново) return false;
  // «320x>» — только уменьшать: обложку у́же 320 px не растягиваем
  execFileSync('magick', [обложкаП, '-auto-orient', '-resize', `${ШИРИНА}x>`, '-strip',
    '-interlace', 'Plane', '-quality', '82', миниП]);
  return true;
}

const кб = п => Math.round(fs.statSync(п).size / 1024);

try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); }
catch { console.error('Не найден ImageMagick (команда magick). Установите его и запустите снова.'); process.exit(1); }

/* ── публичные книги: файлы + реестр ── */
let текст = fs.readFileSync(РЕЕСТР, 'utf8');
const реестр = JSON.parse(текст);
const книги = Array.isArray(реестр) ? реестр : (реестр.books || []);
let создано = 0, вписано = 0, былоКБ = 0, сталоКБ = 0;

for (const з of книги) {
  if (!з.cover) continue;
  const обложкаП = path.join(КОРЕНЬ, з.cover);
  if (!fs.existsSync(обложкаП)) { console.warn(`  ! ${з.id}: обложки нет (${з.cover}) — пропущено`); continue; }
  const мини = миниатюраДля(з.cover);
  const миниП = path.join(КОРЕНЬ, мини);
  if (сделать(обложкаП, миниП)) создано++;
  былоКБ += кб(обложкаП); сталоКБ += кб(миниП);
  console.log(`  · ${з.id}: ${кб(обложкаП)} КБ → ${кб(миниП)} КБ`);

  if (з.thumb === мини) continue;
  if (з.thumb) { console.warn(`  ! ${з.id}: в реестре уже стоит другой thumb (${з.thumb}) — не трогаю`); continue; }
  // строка "cover" этой книги → она же плюс строка "thumb" с тем же отступом
  const строка = new RegExp(`^([ \\t]*)"cover": ${JSON.stringify(з.cover).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,?)[ \\t]*$`, 'm');
  if (!строка.test(текст)) { console.warn(`  ! ${з.id}: не нашёл строку "cover" в реестре — впишите "thumb" руками`); continue; }
  текст = текст.replace(строка, (_, отступ, запятая) =>
    `${отступ}"cover": ${JSON.stringify(з.cover)},\n${отступ}"thumb": ${JSON.stringify(мини)}${запятая}`);
  вписано++;
}

if (вписано) {
  JSON.parse(текст);   // не записывать сломанный реестр
  fs.writeFileSync(РЕЕСТР, текст);
}

/* ── непубличные книги: только файлы ── */
const ЛИЧНЫЕ = path.join(КОРЕНЬ, 'books-private');
let личных = 0;
if (fs.existsSync(ЛИЧНЫЕ)) {
  for (const имя of fs.readdirSync(ЛИЧНЫЕ)) {
    const обложкаП = path.join(ЛИЧНЫЕ, имя, 'cover.jpg');
    if (!fs.existsSync(обложкаП)) continue;
    if (сделать(обложкаП, path.join(ЛИЧНЫЕ, имя, 'cover-thumb.jpg'))) личных++;
  }
}

console.log(`\nМиниатюр создано: ${создано}, вписано в реестр: ${вписано}.`
  + (былоКБ ? ` Полка: ${былоКБ} КБ → ${сталоКБ} КБ.` : ''));
if (личных) console.log(`Непубличных миниатюр создано: ${личных} — пересоберите их реестр: node tools/private-index.js`);
