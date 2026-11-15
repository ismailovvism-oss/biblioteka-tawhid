#!/usr/bin/env node
'use strict';

/*
 * Поисковые файлы книг: books/<id>/search.json — весь текст записи, уже разобранный на
 * секторы, одним файлом.
 *
 * Зачем. Поиск по библиотеке раньше скачивал каждую главу каждой книги и разбирал её в
 * браузере: ~240 запросов и около 20 секунд на первом поиске. Очередь из сотен запросов
 * хостинг принимает за атаку и закрывает читателю адрес (так случилось 15.11.2026). С этим
 * файлом поиск берёт книгу одним запросом и ничего не разбирает.
 *
 * Использование:
 *   node tools/gen-search.js              собрать файлы всех записей реестра
 *   node tools/gen-search.js --проверить  ничего не писать, только сказать, что устарело
 *
 * Отдельно звать его обычно не нужно: tools/gen-meta.js зовёт сам. Запускать после
 * добавления записи и после правки текста; забыли — tools/doctor.js скажет, что файл устарел.
 * Читалка без файла не ломается: такую книгу она разбирает по главам по-старому (медленно).
 *
 * Сам разбор — в parser.js (searchIndex): файл и читалка обязаны видеть одну и ту же
 * строку текста, поэтому второго разборщика здесь нет. Этот инструмент только читает папку
 * книги с диска и пишет результат. Формат файла описан там же.
 */

const fs = require('fs');
const path = require('path');
const Parser = require('../parser.js');
const Contract = require('../contract.js');

const КОРЕНЬ = path.join(__dirname, '..');
// публичный реестр и — если есть на этой машине — реестр локальных непубличных книг
const РЕЕСТРЫ = ['books/index.json', 'books-private/index.json'];

/* Тексты глав: { "<файл главы>": { "<язык>": "<markdown>" } }. Нет файла — нет ключа. */
function тексты(папка, манифест) {
  const out = {};
  for (const гл of манифест.chapters || []) {
    if (!гл || !гл.file) continue;
    const по = {};
    for (const язык of манифест.languages || []) {
      const п = path.join(папка, язык, гл.file);
      if (fs.existsSync(п)) по[язык] = fs.readFileSync(п, 'utf8').replace(/^﻿/, '');
    }
    if (Object.keys(по).length) out[гл.file] = по;
  }
  return out;
}

const путь = (запись, корень = КОРЕНЬ) => path.join(корень, запись.base, 'search.json');

/** Каким должен быть поисковый файл записи (строкой). null — папки или манифеста нет. */
function построить(запись, корень = КОРЕНЬ) {
  if (!запись || !запись.base || /^https?:\/\//.test(запись.base)) return null;
  const папка = path.join(корень, запись.base);
  const манифестП = path.join(папка, 'book.json');
  if (!fs.existsSync(манифестП)) return null;
  let манифест;
  try { манифест = JSON.parse(fs.readFileSync(манифестП, 'utf8')); } catch { return null; }
  if (!Array.isArray(манифест.languages) || !Array.isArray(манифест.chapters)) return null;
  const т = тексты(папка, манифест);
  const файл = Parser.searchIndex(манифест, т);
  /* `c` — число глав и слов, тем же счётом, что кладёт в реестр gen-meta.js (и Вычитка при
     публикации). По нему читалка узнаёт отставший файл: в реестре числа уже новые, а в
     файле прежние — значит, текст меняли, а файл не пересобрали, и верить ему нельзя. */
  const язык = Contract.readingLang(манифест);
  const чтение = {};
  for (const [имя, по] of Object.entries(т)) if (язык && по[язык] != null) чтение[имя] = по[язык];
  файл.c = Contract.shelfCounts(манифест, чтение);
  return JSON.stringify(файл) + '\n';
}

/** Что с файлом на диске: 'свеж' | 'нет' | 'устарел' | null (судить не о чем). */
function состояние(запись, корень = КОРЕНЬ) {
  const надо = построить(запись, корень);
  if (надо == null) return null;
  const п = путь(запись, корень);
  if (!fs.existsSync(п)) return 'нет';
  return fs.readFileSync(п, 'utf8') === надо ? 'свеж' : 'устарел';
}

function записи(корень = КОРЕНЬ) {
  const все = [];
  for (const имя of РЕЕСТРЫ) {
    const п = path.join(корень, имя);
    if (!fs.existsSync(п)) continue;
    let р;
    try { р = JSON.parse(fs.readFileSync(п, 'utf8')); } catch { continue; }
    все.push(...(Array.isArray(р) ? р : (р.books || [])));
  }
  return все;
}

/** Собрать файлы всех записей. Возвращает число записанных; `говорить` — печатать ход. */
function записатьВсе({ корень = КОРЕНЬ, проверить = false, говорить = () => {} } = {}) {
  let тронуто = 0;
  for (const з of записи(корень)) {
    const надо = построить(з, корень);
    if (надо == null) { говорить(`  · ${з.id}: папки или манифеста нет — пропущено`); continue; }
    const п = путь(з, корень);
    const было = fs.existsSync(п) ? fs.readFileSync(п, 'utf8') : null;
    const кб = Math.round(Buffer.byteLength(надо) / 1024);
    if (было === надо) { говорить(`  · ${з.id}: ${кб} КБ`); continue; }
    тронуто++;
    if (!проверить) fs.writeFileSync(п, надо);
    говорить(`  · ${з.id}: ${кб} КБ  ← ${проверить ? (было == null ? 'файла нет' : 'устарел') : (было == null ? 'создан' : 'обновлён')}`);
  }
  return тронуто;
}

module.exports = { построить, состояние, записатьВсе };

if (require.main === module) {
  const проверить = process.argv.includes('--проверить');
  const n = записатьВсе({ проверить, говорить: console.log });
  if (проверить) {
    console.log(n ? `\nУстарело поисковых файлов: ${n} — запустите node tools/gen-search.js` : '\nПоисковые файлы свежие.');
    process.exit(n ? 1 : 0);
  }
  console.log(n ? `\nПоисковых файлов записано: ${n}.` : '\nПоисковые файлы уже свежие.');
}
