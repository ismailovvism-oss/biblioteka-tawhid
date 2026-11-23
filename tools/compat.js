#!/usr/bin/env node
'use strict';
/*
 * Совместимость оболочки со старыми iPhone: node tools/compat.js
 *
 * 23.11.2026 читатель на iPhone с iOS ниже 16.4 не смог открыть ни одной статьи: в parser.js с 25.07
 * стояла регулярка с «просмотром назад» (?<!…). Safari понимает его только с 16.4 и отвергает весь
 * файл ещё при загрузке, а без parser.js не разбирается ни один раздел. На iOS все браузеры, Chrome
 * тоже, работают на движке Safari, а iPhone 6s и 7 выше iOS 15 не обновляются.
 *
 * Здесь ищутся приёмы, которых нет в Safari 15.0, с версией, где они появились. Нашлось — выход 1,
 * и pages.yml не выкладывает. Комментарии пропускаются: строки, начинающиеся с // или *, и хвосты
 * « // …». Нужно новое — проверить, есть ли оно в Safari 15 (caniuse.com), и обойтись без него
 * или проверять наличие (`if (Intl.Segmenter)` — так можно: сюда это не попадает).
 */
const fs = require('fs');
const path = require('path');

const КОРЕНЬ = path.join(__dirname, '..');
// файлы оболочки — то, что грузит index.html, и воркер
const ФАЙЛЫ = ['parser.js', 'translate.js', 'gloss.js', 'contract.js', 'app.js', 'sw.js',
  'supabase/config.js', 'supabase/client.js'];

const ПРИЁМЫ = [
  [/\(\?<[=!]/, 'просмотр назад в регулярке (?<= / (?<!', '16.4 — файл не загрузится целиком'],
  [/\bstatic\s*\{/, 'статический блок класса static { }', '16.4 — файл не загрузится целиком'],
  [/\.at\(\s*-?\w/, 'arr.at(…)', '15.4'],
  [/\.findLast(Index)?\(/, 'findLast / findLastIndex', '15.4'],
  [/\bstructuredClone\(/, 'structuredClone', '15.4'],
  [/\bObject\.hasOwn\(/, 'Object.hasOwn', '15.4'],
  [/\.(toSorted|toReversed|toSpliced)\(/, 'toSorted / toReversed / toSpliced', '16'],
  [/\b(Object|Map)\.groupBy\(/, 'Object.groupBy / Map.groupBy', '17.4'],
  [/\bPromise\.withResolvers\(/, 'Promise.withResolvers', '17.4'],
  [/\.(union|intersection|difference|symmetricDifference|isSubsetOf)\(new Set/, 'методы Set (union и др.)', '17'],
];

let найдено = 0;
for (const f of ФАЙЛЫ) {
  const п = path.join(КОРЕНЬ, f);
  if (!fs.existsSync(п)) continue;
  fs.readFileSync(п, 'utf8').split('\n').forEach((строка, i) => {
    const т = строка.trim();
    if (т.startsWith('//') || т.startsWith('*') || т.startsWith('/*')) return;
    const код = строка.replace(/\s\/\/\s.*$/, '');
    for (const [re, что, с] of ПРИЁМЫ) {
      if (re.test(код)) {
        найдено++;
        console.log(`${f}:${i + 1}: ${что} — в Safari с iOS ${с}\n    ${т.slice(0, 140)}`);
      }
    }
  });
}
if (найдено) {
  console.log(`\nНайдено ${найдено}. Старые iPhone (iOS 15) этого не понимают — заменить обычным приёмом.`);
  process.exit(1);
}
console.log('Оболочка понятна Safari 15 (iOS 15) ✓');
