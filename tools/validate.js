#!/usr/bin/env node
'use strict';

/*
 * CLI-валидатор контракта книги (SPEC, раздел 6) — тот же парсер, что в приложении.
 * Использование: node tools/validate.js books/<bookId>
 * Код выхода 1, если найдены ошибки контракта.
 */

const fs = require('fs');
const path = require('path');
const { buildChapter, glossTokens, glossHash, parseGlossFile } = require(path.join(__dirname, '..', 'parser.js'));

const dir = process.argv[2];
if (!dir) {
  console.error('Использование: node tools/validate.js books/<bookId>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
console.log(`Книга: ${manifest.bookId} — ${manifest.title[manifest.languages[1]] || manifest.title[manifest.languages[0]] || ''}`);

let total = 0;
const glossDone = [];      // что реально подписано
const glossPending = [];   // объявлен слой подстрочника, а файла главы ещё нет
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

  // Иллюстрации: ![](media/…) — путь от папки книги. Битую ссылку ловим здесь, а не
  // на проде: валидатор гоняется в CI перед выкладкой, ошибка блокирует деплой.
  // Парсер файловой системы не знает (он двусредный) — существование проверяем тут.
  const imgs = [...new Set(pairs.flatMap(p => p.images || []))];
  for (const src of imgs) {
    if (!fs.existsSync(path.join(dir, src))) {
      warnings.push(`картинка не найдена: ${src} (ищем в ${path.join(dir, src)})`);
    }
  }
  /* Подстрочник (SPEC 3.4c): номер в gloss-файле — порядковый номер слова в секторе.
     Разойдись он с текстом хоть на единицу, и подпись встанет под чужим словом —
     а читатель примет её за перевод и подмены не заметит. Поэтому сверяем каждую
     запись со словом, которое реально стоит под этим номером, и роняем сборку. */
  for (const gl of (Array.isArray(manifest.gloss) ? manifest.gloss : [])) {
    const gp = path.join(dir, 'gloss', gl, ch.file);
    if (!fs.existsSync(gp)) { glossPending.push(`${gl}/${ch.file}`); continue; }
    const { sectors, warnings: gw } = parseGlossFile(fs.readFileSync(gp, 'utf8'));
    gw.forEach(w => warnings.push(`подстрочник ${gl}/${ch.file}: ${w}`));
    const byId = new Map(pairs.filter(p => p.type === 'text').map(p => [p.id, p]));
    const tag = `подстрочник ${gl}/${ch.file}`;
    let placed = 0, verified = 0, stale = 0;
    for (const [id, sec] of sectors) {
      const pair = byId.get(id);
      if (!pair) { warnings.push(`${tag}: сектора ${id} нет в главе`); continue; }
      if (!pair[gl]) { warnings.push(`${tag}: у сектора ${id} нет текста на ${gl}`); continue; }
      const toks = glossTokens(pair[gl]);
      const nums = new Set(sec.entries.map(e => e.n));
      if (sec.verified) verified++;

      /* Хеш протух — текст сектора правили после генерации. Это не ошибка Контракта:
         подписи, чьё слово ещё совпадает, останутся верны. Но перегенерировать надо,
         и молчать об этом нельзя. */
      if (sec.hash && sec.hash !== glossHash(pair[gl])) {
        warnings.push(`${tag}: ${id} — текст изменился после генерации, подписи протухли`);
        stale++;
      }

      for (const e of sec.entries) {
        const tok = toks[e.n - 1];
        if (!tok) {
          warnings.push(`${tag}: ${id}, слово ${e.n} — в секторе всего ${toks.length} слов`);
          continue;
        }
        if (tok.word.toLowerCase() !== e.word.toLowerCase()) {
          warnings.push(`${tag}: ${id}, слово ${e.n} — в тексте «${tok.word}», в подстрочнике «${e.word}»`);
          continue;
        }
        // стрелка «->N» обязана вести на существующее слово того же сектора,
        // и у носителя должна быть своя подпись — иначе смысл не несёт никто
        if (e.carrier != null) {
          const host = sec.entries.find(x => x.n === e.carrier);
          if (!nums.has(e.carrier)) {
            warnings.push(`${tag}: ${id}, слово ${e.n} ссылается на ${e.carrier}, а такой строки нет`);
          } else if (!host.gloss) {
            warnings.push(`${tag}: ${id}, слово ${e.n} ссылается на ${e.carrier}, у которого подписи тоже нет`);
          }
          continue;
        }
        placed++;
      }
    }
    glossDone.push(`${gl}: ${sectors.size} секторов (выверено ${verified}${stale ? `, протухло ${stale}` : ''}) / ${placed} подписей`);
  }

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

if (glossDone.length) console.log(`  подстрочник — ${glossDone.join('; ')}`);
// Отсутствие файла главы не ошибка: подписи готовятся постепенно, глава за главой.
if (glossPending.length) console.log(`  подстрочник не готов: ${glossPending.join(', ')}`);
console.log(total ? `\nОшибок контракта: ${total}` : '\nКонтракт соблюдён ✓');
process.exit(total ? 1 : 0);
