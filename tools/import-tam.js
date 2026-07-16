'use strict';

/*
 * Импорт книги «Тауфик аль-Маннан» (репозиторий tawfiq-al-mannan) в формат библиотеки.
 *
 * Это **адаптер источника**: знает только про раскладку конкретного репозитория
 * (порядок файлов, метаданные книги, паритет ar↔ru). Сама запись Контракта —
 * в общем ядре `contract.js`, оно же под Вычиткой. Логику Контракта править ТАМ.
 *
 * Выравнивание (формат Вычитки): секторы = абзацы по одной пустой строке;
 * одинаковые по счёту секторы source/ и translation/ спарены по порядку.
 * Аят (۞арабский + русский вплотную) = один сектор. Сноски — внизу файла, своя
 * нумерация на каждом языке.
 *
 * Выход: books/tawfiq/{ar,ru}/<метка>.md (Контракт: <!-- sNNN -->, <!-- fnN -->,
 *        числовые [^N]) + books/tawfiq/book.json, регистрация в books/index.json.
 *
 * Запуск:  node tools/import-tam.js [путь-к-клону-tawfiq-al-mannan]   (по умолчанию /tmp/tam-book)
 */

const fs = require('fs');
const path = require('path');
const { convert, stripFrontmatter, parityHint } = require(path.join(__dirname, '..', 'contract.js'));

const SRC = process.argv[2] || '/tmp/tam-book';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'books', 'tawfiq');
const BOOK_ID = 'tawfiq';
const BOOK_TITLE = { ar: 'توفيق المنان', ru: 'Тауфик аль-Маннан' };

function chapterFiles() {
  // естественный порядок частей: 06a < 06a-2 < 06a-2-2 < 06b
  // (лексически дефис стоит раньше точки, и 06a-2.md сортировался ПЕРЕД 06a.md)
  const key = f => {
    const m = f.match(/^(\d+)([a-z]?)(?:-(\d+))?(?:-(\d+))?/);
    return [+m[1], m[2] || '', +(m[3] || 0), +(m[4] || 0)];
  };
  const cmp = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  return fs.readdirSync(path.join(SRC, 'translation'))
    .filter(f => f.endsWith('.md'))
    .sort(cmp);
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'translation'))) {
    console.error(`Не найден ${SRC}/translation — укажи путь к клону tawfiq-al-mannan.`);
    process.exit(1);
  }
  for (const lang of ['ar', 'ru']) {
    fs.rmSync(path.join(OUT, lang), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  }

  const chapters = [];
  const mismatches = [];
  const dropReport = [];
  for (const file of chapterFiles()) {
    const tr = stripFrontmatter(fs.readFileSync(path.join(SRC, 'translation', file), 'utf8'));
    const ru = convert(tr.body, { dropArabic: true, label: file });
    if (ru.droppedAyat || ru.droppedOther) dropReport.push(`${file}: аятов ${ru.droppedAyat}, прочих арабских строк ${ru.droppedOther}`);
    fs.writeFileSync(path.join(OUT, 'ru', file), ru.content);

    const srcPath = path.join(SRC, 'source', file);
    const ar = fs.existsSync(srcPath) ? convert(fs.readFileSync(srcPath, 'utf8')) : { content: '', sectors: 0, warnings: [] };
    // ядро Контракта не печатает — предупреждения возвращаются и печатаются здесь
    for (const w of [...(ru.warnings || []), ...(ar.warnings || [])]) console.warn('  ⚠ ' + w);
    // арабский выдаём только при точном посекторном паритете — иначе середина
    // главы молча спарилась бы неверно; до правки паритета глава читается по-русски
    if (ar.sectors === ru.sectors && ar.sectors > 0) {
      fs.writeFileSync(path.join(OUT, 'ar', file), ar.content);
    } else {
      fs.writeFileSync(path.join(OUT, 'ar', file),
        '<!-- арабский оригинал этой главы ещё не выровнен посекторно (паритет правится в Вычитке) -->\n');
      // картинка отдельным абзацем — лишний сектор; сама по себе разница «Δ1» этого
      // не подсказывает, поэтому объясняем прямо
      const hint = parityHint(ar, ru);
      mismatches.push(`${file}: ar=${ar.sectors} ru=${ru.sectors} (Δ${ru.sectors - ar.sectors})`
        + (hint ? `\n      ↳ ${hint}` : ''));
    }
    chapters.push({ file, title: { ru: tr.title || file.replace(/\.md$/, '') } });
  }

  // сканы страниц: books/tawfiq/img/pN.jpg, N = книжная страница (= pdf-страница − 2)
  const book = {
    bookId: BOOK_ID, title: BOOK_TITLE, languages: ['ar', 'ru'], rtl: ['ar'], chapters,
    hasImages: true, imagePattern: 'img/p{page}.jpg',
    feedbackEmail: 'qaadiy@gmail.com', // кнопка «✉ Ошибка?» в читалке
    author: { ru: 'Абд аль-Кадир ибн Исмаил аль-Ибрахими', ar: 'عبد القادر بن إسماعيل الإبراهيمي' },
    description: 'Апологетический труд по акыде, том второй: защита имамов Ислама — Ибн Таймии, Ибн аль-Каййима, Ибн Абд аль-Барра, Ибн Хазма и шейха Абу Бутайна — от возводимой на них клеветы и искажения их слов. Параллельный текст: арабский оригинал и русский перевод, выровненные по смысловым абзацам, с примечаниями переводчика и сканами страниц оригинала.',
  };
  fs.writeFileSync(path.join(OUT, 'book.json'), JSON.stringify(book, null, 2) + '\n');

  const idxPath = path.join(ROOT, 'books', 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const prev = idx.books.find(b => b.id === BOOK_ID) || {};
  idx.books = idx.books.filter(b => b.id !== BOOK_ID);
  // классификация (category/tags/era) задаётся в реестре вручную и сохраняется через ...prev;
  // langs/authors денормализуем из манифеста для фасетов библиотеки
  idx.books.push({
    ...prev, id: BOOK_ID, base: 'books/tawfiq/', title: BOOK_TITLE,
    langs: book.languages,
    authors: prev.authors || (book.author ? [book.author.ru || Object.values(book.author)[0]].filter(Boolean) : undefined),
  });
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n');

  console.log(`Готово: ${chapters.length} глав → books/tawfiq/{ar,ru}/, book.json, index.json.`);
  console.log(`Параллель ar↔ru: ${chapters.length - mismatches.length}/${chapters.length} глав выровнены ✓`);
  if (dropReport.length) {
    console.log(`Из русской стороны выброшены арабские строки двуязычных секторов (арабский остаётся в ar/):`);
    for (const r of dropReport) console.log('  ' + r);
  }
  if (mismatches.length) {
    console.log(`Пока без арабского (нужен паритет абзацев в Вычитке) — ${mismatches.length}:`);
    for (const m of mismatches) console.log('  ' + m);
  }
}

main();
