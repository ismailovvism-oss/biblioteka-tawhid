#!/usr/bin/env node
'use strict';

/*
 * Сведения для полки, которые выводятся из самой книги: число глав и слов, а у статей —
 * ещё и аннотация.
 *
 * Зачем они в реестре. Лента статей показывает у каждой записи время чтения и пару строк
 * аннотации, подпись типа («Статья · 14 мин», «Книга · 37 глав») стоит в поиске, в строке
 * «Продолжить» и в вырезках. Всё это нужно ДО открытия записи, а лежит в её манифесте и
 * тексте. Тянуть манифест каждой записи ради карточки — это запрос на карточку; на тысячах
 * записей так нельзя. Поэтому считаем один раз при публикации и кладём в реестр — так же,
 * как tools/gen-thumbs.js кладёт туда миниатюру.
 *
 * Использование: node tools/gen-meta.js
 *
 * Что пишет в books/index.json (у записей, чья папка лежит в репозитории):
 *   "counts": { "chapters": N, "words": N } — главы с текстом и слова основного текста
 *       (без сносок) на языке чтения: русский, если он есть, иначе последний язык книги;
 *   "description" — только у статей ("kind": "article"): копия аннотации из book.json.
 *       Источник истины — манифест; здесь копия, её нельзя править руками.
 *
 * Запускать после добавления записи и после правки текста или аннотации. Забыли —
 * tools/doctor.js скажет, что сведения устарели.
 *
 * Счёт слов общий с doctor.js и private-index.js (экспорт ниже): три счётчика, написанные
 * порознь, разошлись бы на первой же правке.
 */

const fs = require('fs');
const path = require('path');
const { buildChapter } = require('../parser.js');

const КОРЕНЬ = path.join(__dirname, '..');
const РЕЕСТР = path.join(КОРЕНЬ, 'books', 'index.json');

/* Слово — цепочка букв и цифр; дефис и апостроф внутри слова его не рвут
   («что-то», «ma’mūm»). Арабские огласовки — комбинируемые знаки (\p{M}), без них
   огласованное слово рассыпалось бы на куски. */
const СЛОВО = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-'’ʼ][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

function словВHtml(html) {
  const текст = String(html)
    .replace(/<button class="fnref"[^>]*>.*?<\/button>/g, ' ')   // номер сноски — не слово
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return (текст.match(СЛОВО) || []).length;
}

// язык, на котором запись читают в русском интерфейсе
function языкЧтения(манифест) {
  const языки = манифест.languages || [];
  return языки.includes('ru') ? 'ru' : языки[языки.length - 1];
}

/** Число глав с текстом и слов основного текста. Сноски в счёт слов не идут. */
function посчитать(папка, манифест) {
  const языки = манифест.languages || [];
  const язык = языкЧтения(манифест);
  let глав = 0, слов = 0;
  for (const гл of манифест.chapters || []) {
    if (!гл.file) continue;                       // запись-группа: читать нечего
    глав++;
    const тексты = {};
    for (const l of языки) {
      const п = path.join(папка, l, гл.file);
      тексты[l] = fs.existsSync(п) ? fs.readFileSync(п, 'utf8') : '';
    }
    for (const пара of buildChapter(тексты, языки).pairs) {
      if (пара.type !== 'text' || пара[язык] == null) continue;
      слов += словВHtml(пара[язык]);
    }
  }
  return { chapters: глав, words: слов };
}

/** Что должно стоять в записи реестра. null — папки или манифеста нет, судить не о чем. */
function сведения(запись, корень = КОРЕНЬ) {
  if (!запись || !запись.base || /^https?:\/\//.test(запись.base)) return null;
  const папка = path.join(корень, запись.base);
  const манифестП = path.join(папка, 'book.json');
  if (!fs.existsSync(манифестП)) return null;
  let манифест;
  try { манифест = JSON.parse(fs.readFileSync(манифестП, 'utf8')); } catch { return null; }
  const out = { counts: посчитать(папка, манифест) };
  if (запись.kind === 'article' && манифест.description) out.description = манифест.description;
  return out;
}

const одинаковы = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = { посчитать, сведения, одинаковы };

if (require.main === module) {
  const текст = fs.readFileSync(РЕЕСТР, 'utf8');
  const реестр = JSON.parse(текст);
  const книги = Array.isArray(реестр) ? реестр : (реестр.books || []);
  let изменено = 0;

  for (const з of книги) {
    const с = сведения(з);
    if (!с) { console.log(`  · ${з.id}: папки или манифеста нет — пропущено`); continue; }
    let тронуто = false;
    if (!одинаковы(з.counts, с.counts)) { з.counts = с.counts; тронуто = true; }
    if (с.description !== undefined && !одинаковы(з.description, с.description)) { з.description = с.description; тронуто = true; }
    if (тронуто) изменено++;
    const мин = Math.max(1, Math.round(с.counts.words / 200));
    console.log(`  · ${з.id}: глав ${с.counts.chapters}, слов ${с.counts.words}` +
      (з.kind === 'article' ? `, читать ~${мин} мин` : '') + (тронуто ? '  ← обновлено' : ''));
  }

  if (изменено) {
    // формат файла — как у JSON.stringify с отступом 2; хвостовой перевод строки сохраняем как был
    fs.writeFileSync(РЕЕСТР, JSON.stringify(реестр, null, 2) + (текст.endsWith('\n') ? '\n' : ''));
    console.log(`\nВ реестре обновлено записей: ${изменено}.`);
  } else {
    console.log('\nРеестр уже свежий.');
  }
}
