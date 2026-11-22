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
 *   "razbor": { "frames": N, "words": N } — только если у записи есть «Ясный разбор»
 *       (book.json → "razbor", SPEC 3.4h): лента ставит значок, шапка статьи — «· N мин».
 *       Нет разбора — поля нет.
 *
 * Запускать после добавления записи и после правки текста или аннотации. Забыли —
 * tools/doctor.js скажет, что сведения устарели.
 *
 * Сам счёт — в contract.js (shelfCounts, shelfMeta): им же пользуется Вычитка, когда
 * публикует запись, поэтому второго счётчика здесь нет. Этот файл только читает папку
 * книги с диска и отдаёт тексты ядру; через него считают doctor.js, private-index.js и
 * конвертер статей в-читалку.py.
 */

const fs = require('fs');
const path = require('path');
const Contract = require('../contract.js');
const { razborFile, razborCounts } = require('../parser.js');

const КОРЕНЬ = path.join(__dirname, '..');
const РЕЕСТР = path.join(КОРЕНЬ, 'books', 'index.json');

/* Тексты глав на языке чтения: { "<файл главы>": "<текст>" }. Нет файла — нет ключа. */
function тексты(папка, манифест) {
  const язык = Contract.readingLang(манифест);
  const out = {};
  for (const гл of манифест.chapters || []) {
    if (!гл.file || !язык) continue;
    const п = path.join(папка, язык, гл.file);
    if (fs.existsSync(п)) out[гл.file] = fs.readFileSync(п, 'utf8');
  }
  return out;
}

/** Число глав с текстом и слов основного текста. Сноски в счёт слов не идут. */
function посчитать(папка, манифест) {
  return Contract.shelfCounts(манифест, тексты(папка, манифест));
}

/** Что должно стоять в записи реестра. null — папки или манифеста нет, судить не о чем. */
function сведения(запись, корень = КОРЕНЬ) {
  if (!запись || !запись.base || /^https?:\/\//.test(запись.base)) return null;
  const папка = path.join(корень, запись.base);
  const манифестП = path.join(папка, 'book.json');
  if (!fs.existsSync(манифестП)) return null;
  let манифест;
  try { манифест = JSON.parse(fs.readFileSync(манифестП, 'utf8')); } catch { return null; }
  return Contract.shelfMeta(запись, манифест, тексты(папка, манифест));
}

const одинаковы = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** «Ясный разбор» записи: { frames, words }; undefined — разбора нет; null — судить не о чем. */
function сведенияРазбора(запись, корень = КОРЕНЬ) {
  if (!запись || !запись.base || /^https?:\/\//.test(запись.base)) return null;
  const папка = path.join(корень, запись.base);
  let манифест;
  try { манифест = JSON.parse(fs.readFileSync(path.join(папка, 'book.json'), 'utf8')); } catch { return null; }
  const файл = razborFile(манифест, Contract.readingLang(манифест));
  if (!файл) return undefined;
  try { return razborCounts(JSON.parse(fs.readFileSync(path.join(папка, файл), 'utf8'))); } catch { return null; }
}

module.exports = { посчитать, сведения, сведенияРазбора, одинаковы };

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
    const р = сведенияРазбора(з);
    if (р === undefined && з.razbor !== undefined) { delete з.razbor; тронуто = true; }
    if (р && !одинаковы(з.razbor, р)) { з.razbor = р; тронуто = true; }
    if (тронуто) изменено++;
    const мин = Contract.readMinutes(с.counts.words);
    console.log(`  · ${з.id}: глав ${с.counts.chapters}, слов ${с.counts.words}` +
      (з.kind === 'article' ? `, читать ~${мин} мин` : '') +
      (з.razbor ? `, разбор: кадров ${з.razbor.frames}, ~${Contract.readMinutes(з.razbor.words)} мин` : '') + (тронуто ? '  ← обновлено' : ''));
  }

  if (изменено) {
    // формат файла — как у JSON.stringify с отступом 2; хвостовой перевод строки сохраняем как был
    fs.writeFileSync(РЕЕСТР, JSON.stringify(реестр, null, 2) + (текст.endsWith('\n') ? '\n' : ''));
    console.log(`\nВ реестре обновлено записей: ${изменено}.`);
  } else {
    console.log('\nРеестр уже свежий.');
  }

  /* Поисковые файлы — такая же производная от текста, и устаревают они вместе со сведениями.
     Собираем здесь же, чтобы после правки текста оставалась одна команда, а не две: её уже
     зовут конвертер статей и скилл «статья». */
  console.log('\nПоисковые файлы (tools/gen-search.js):');
  const поиск = require('./gen-search.js').записатьВсе({ говорить: console.log });
  console.log(поиск ? `\nПоисковых файлов записано: ${поиск}.` : '\nПоисковые файлы уже свежие.');
}
