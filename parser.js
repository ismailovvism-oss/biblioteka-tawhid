'use strict';

/*
 * Парсер контракта книги (SPEC, разделы 3–4, 6).
 * Чистые функции без DOM — работают и в браузере, и в Node (tools/validate.js).
 *
 * Вход:  тексты глав по языкам (ar/NN.md + ru/NN.md).
 * Выход: массив пар { id, page, type, <lang>: html|null, refs } + warnings валидатора.
 */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Inline-markdown внутри сектора: код, подчёркивание, жирный, курсив, маркеры сносок [^N].
   Код в обратных кавычках вынимается ПЕРВЫМ и подменяется плейсхолдером: внутри `a*b*c`
   звёздочки — часть термина (транслитерация вроде `qiyas istithna'i`), а не курсив. */
function inlineMd(text) {
  let h = escapeHtml(text);
  const codes = [];
  h = h.replace(/`([^`]+)`/g, (_, c) => '\u0000' + (codes.push(c) - 1) + '\u0000');
  h = h.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>'); // подчёркивание <u>…</u>
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/\[\^(\d+)\]/g, '<button class="fnref" data-fn="$1" type="button">$1</button>');
  h = h.replace(/\n/g, '<br>');
  h = h.replace(/\u0000(\d+)\u0000/g, (_, n) => '<code>' + codes[Number(n)] + '</code>');
  return h;
}

/*
 * Иллюстрация в тексте: строка целиком из ![подпись](media/схема.png) — блок-картинка
 * (график, схема, пояснение). Своя на каждый язык: секторы пер-язычные, значит в ar/
 * своя разметка, в ru/ своя, и подпись переводится. Один и тот же файл в обоих языках —
 * просто одна и та же ссылка, дублей на диске нет.
 *
 * Путь — от базы книги (`books/<id>/`), как и imagePattern сканов. Папка — media/,
 * НЕ img/: в img/ у Тауфика лежат сканы целых страниц (p1.jpg), мешать нельзя.
 * Инлайн-картинок внутри абзаца намеренно нет — для схем это блок.
 */
const IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const INLINE_IMG_RE = /!\[[^\]]*\]\([^)\s]+\)/; // та же разметка, но не отдельной строкой

/*
 * Пускаем только относительный путь внутрь книги. Отсекаем схему (javascript:, data:,
 * http:), протокол-относительный //, абсолютный / и выход вверх через ".." — иначе
 * ![](javascript:…) или ![](../../чужое) прошли бы в src как есть.
 */
function safeImgSrc(s) {
  if (!s) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false; // схема
  if (s.startsWith('//') || s.startsWith('/')) return false;
  if (s.split('/').includes('..')) return false;
  return true;
}

/* Заголовок callout по типу, если автор не задал свой (для [!quote] и т. п.). */
const CALLOUT_LABELS = {
  quote: 'Цитата', note: 'Примечание', info: 'Инфо', tip: 'Совет',
  important: 'Важное', warning: 'Предупреждение', success: 'Готово',
  question: 'Вопрос', failure: 'Ошибка', danger: 'Опасно',
  example: 'Пример', abstract: 'Резюме',
};

/*
 * Блочный markdown внутри сектора: цитата (> ), callout (> [!тип] загол.),
 * списки (- / 1.), иначе обычный абзац. Рекурсивно: цитата/callout могут
 * содержать вложенные блоки. Тип callout произвольный — неизвестный получает
 * дефолтный стиль (.callout-<тип>), так что набор типов не захардкожен.
 */
/*
 * Таблица (SPEC 3.4b) — разметка GFM: строка ячеек через «|», под ней строка-разделитель
 * из дефисов. Двоеточия в разделителе задают выравнивание колонки (:-- слева, --: справа,
 * :-: по центру). Нужна справочникам: словари терминов, таблицы соответствий, парадигмы.
 *
 * Картинкой такое верстать нельзя: изображение не ищется поиском, из него не скопировать
 * термин, оно не переносится по ширине экрана и не слушается размера шрифта и темы.
 * Поэтому именно разметка, а горизонтальная прокрутка узких экранов — забота CSS.
 */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const isTableRow = l => l.includes('|') && l.trim() !== '';

// «| a | b |» → ['a','b']. Экранированная «\|» внутри ячейки остаётся символом.
function splitRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
  return cells;
}

function alignsOf(sep) {
  return splitRow(sep).map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
}

function renderTable(head, sep, body) {
  const aligns = alignsOf(sep);
  const cell = (tag, text, i) => {
    const a = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
    return '<' + tag + a + '>' + inlineMd(text) + '</' + tag + '>';
  };
  const thead = '<thead><tr>' + splitRow(head).map((c, i) => cell('th', c, i)).join('') + '</tr></thead>';
  const tbody = body.length
    ? '<tbody>' + body.map(r => '<tr>' + splitRow(r).map((c, i) => cell('td', c, i)).join('') + '</tr>').join('') + '</tbody>'
    : '';
  // обёртка со своей прокруткой: широкая таблица не должна разъезжать страницу вбок
  return '<div class="table-wrap"><table>' + thead + tbody + '</table></div>';
}

function renderBlocks(lines, base) {
  base = base || '';
  const isQuote = l => /^>\s?/.test(l);
  const isUl = l => /^[-*]\s+/.test(l);
  const isOl = l => /^\d+\.\s+/.test(l);
  const isFence = l => /^\s*```/.test(l);
  const isTableStart = n => isTableRow(lines[n]) && n + 1 < lines.length
    && TABLE_SEP_RE.test(lines[n + 1]) && lines[n + 1].includes('-');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    /* Блок кода/формул: ```…``` — моноширинно, без разбора разметки внутри. Держит
       ASCII-схемы и формальную запись (∀x (S(x) → P(x))), где пробелы значимы.
       Пустая строка завершает сектор, поэтому пустых строк внутри блока быть не может. */
    if (isFence(lines[i])) {
      i++;
      const code = [];
      while (i < lines.length && !isFence(lines[i])) { code.push(lines[i]); i++; }
      if (i < lines.length) i++;                 // закрывающая ограда
      out.push('<pre class="code"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    // таблица: строка с «|», под ней разделитель из дефисов
    if (isTableStart(i)) {
      const head = lines[i], sep = lines[i + 1];
      i += 2;
      const body = [];
      while (i < lines.length && isTableRow(lines[i]) && !isFence(lines[i])) { body.push(lines[i]); i++; }
      out.push(renderTable(head, sep, body));
      continue;
    }
    // строка целиком из ![подпись](путь) → <figure>. Подпись необязательна.
    const im = lines[i].match(IMG_RE);
    if (im && safeImgSrc(im[2])) {
      const alt = im[1];
      const cap = alt.trim() ? '<figcaption>' + inlineMd(alt) + '</figcaption>' : '';
      out.push('<figure class="fig"><img src="' + escapeHtml(base + im[2]) + '"'
        + ' alt="' + escapeHtml(alt) + '" loading="lazy">' + cap + '</figure>');
      i++;
      continue;
    }
    if (isQuote(lines[i])) {
      const run = [];
      while (i < lines.length && isQuote(lines[i])) { run.push(lines[i].replace(/^>\s?/, '')); i++; }
      // [!тип] статичный, [!тип]+ сворачиваемый (раскрыт), [!тип]- сворачиваемый (свёрнут)
      const m = run[0] && run[0].match(/^\[!([\w-]+)\]([+-]?)\s*(.*)$/);
      if (m) {
        const type = m[1].toLowerCase();
        const fold = m[2];   // '+' раскрыт, '-' свёрнут, '' не сворачивается
        const title = (m[3] || '').trim() || CALLOUT_LABELS[type] || (type[0].toUpperCase() + type.slice(1));
        const body = run.slice(1);
        const bodyHtml = body.length ? '<div class="callout-body">' + renderBlocks(body, base).join('') + '</div>' : '';
        if (fold) {
          out.push('<details class="callout callout-' + type + ' callout-foldable"' + (fold === '+' ? ' open' : '') + '>'
            + '<summary class="callout-title">' + inlineMd(title) + '</summary>'
            + bodyHtml + '</details>');
        } else {
          out.push('<div class="callout callout-' + type + '">'
            + '<div class="callout-title">' + inlineMd(title) + '</div>'
            + bodyHtml + '</div>');
        }
      } else {
        out.push('<blockquote>' + renderBlocks(run, base).join('') + '</blockquote>');
      }
      continue;
    }
    if (isUl(lines[i]) || isOl(lines[i])) {
      const ordered = isOl(lines[i]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, '')); i++;
      }
      out.push('<' + tag + '>' + items.map(it => '<li>' + inlineMd(it) + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    const run = [];
    // прогон абзаца обрывается и на картинке — иначе «Вот схема:» + ![](…) на следующей
    // строке склеились бы в один <p> и разметка осталась бы голым текстом
    while (i < lines.length && !isQuote(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])
           && !isFence(lines[i]) && !isTableStart(i)
           && !(IMG_RE.test(lines[i]) && safeImgSrc(lines[i].match(IMG_RE)[2]))) { run.push(lines[i]); i++; }
    out.push('<p>' + inlineMd(run.join('\n')) + '</p>');
  }
  return out;
}

/*
 * Разбор одного .md-файла главы на элементы.
 * Возвращает [{ id, baseId, type: "text"|"footnote", page, paras: [строки] }].
 * Базовый id — id без хвостовой буквы группы (s050a → s050).
 * page — действующий маркер <!-- pNNN --> на момент якоря (ставится только в ar).
 */
function parseFile(md) {
  const lines = md.split(/\r?\n/);
  const items = [];
  let page = null;
  let cur = null;
  let inNote = false;   // регион <!-- note --> … <!-- /note --> — личные правки автора, не публикуем
  let inFence = false;  // внутри ```…``` пробелы значимы (ASCII-схемы) и пустая строка не рвёт сектор

  const flush = () => {
    if (cur) {
      cur.paras = cur.paras.filter(p => p !== '');
      items.push(cur);
      cur = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    let m;
    // личные заметки автора (вычитка) при чтении прячем целиком
    if (/^<!--\s*note\s*-->$/i.test(line)) { flush(); inNote = true; continue; }
    if (/^<!--\s*\/\s*note\s*-->$/i.test(line)) { inNote = false; continue; }
    if (inNote) continue;
    if ((m = line.match(/^<!--\s*p(\d+)\s*-->$/))) {
      flush();
      page = parseInt(m[1], 10);
      continue;
    }
    if ((m = line.match(/^<!--\s*(s\d+)([a-z]?)\s*-->$/))) {
      flush();
      inFence = false;   // якорь сильнее ограды: незакрытый ``` портит один сектор, не файл
      cur = { id: m[1] + m[2], baseId: m[1], type: 'text', page, paras: [''] };
      continue;
    }
    if ((m = line.match(/^<!--\s*fn(\d+)\s*-->$/))) {
      flush();
      inFence = false;
      cur = { id: 'fn' + m[1], baseId: 'fn' + m[1], type: 'footnote', page, paras: [''] };
      continue;
    }
    if (!cur) continue; // текст вне якорей игнорируется
    if (/^```/.test(line)) inFence = !inFence;
    if (line === '' && !inFence) {
      if (cur.type === 'text') {
        flush(); // сектор заканчивается на пустой строке
      } else if (cur.paras[cur.paras.length - 1] !== '') {
        cur.paras.push(''); // многоабзацная сноска: новый абзац
      }
      continue;
    }
    // внутри ограды строка идёт как есть: в ASCII-схеме и формальной записи отступ значим
    const keep = inFence ? raw.replace(/\s+$/, '') : line;
    const last = cur.paras.length - 1;
    cur.paras[last] = cur.paras[last] !== '' ? cur.paras[last] + '\n' + keep : keep;
  }
  flush();
  return items;
}

/* Склейка группы (s050a + s050b) в один html-блок. */
function renderGroup(group, base) {
  const out = [];
  for (const part of group.parts) {
    for (const para of part.paras) out.push(...renderBlocks(para.split('\n'), base));
  }
  return out.join('');
}

/*
 * Ядро: два файла главы → массив пар + предупреждения валидатора.
 * texts — { ar: "...", ru: "..." }, langs — manifest.languages,
 * первый язык считается оригиналом (источник страниц).
 */
function buildChapter(texts, langs, opts) {
  const orig = langs[0];
  const trans = langs[1];
  const warnings = [];
  // база книги для путей картинок (books/<id>/); валидатор зовёт без неё — пути остаются
  // относительными, ему они и нужны такими для проверки существования файла
  const base = (opts && opts.base) || '';

  // группировка по базовому id в пределах языка
  const maps = {};
  for (const lang of langs) {
    const seenIds = new Set();
    const map = new Map();
    for (const it of parseFile(texts[lang])) {
      if (seenIds.has(it.id)) warnings.push(`[${lang}] дублирующийся якорь ${it.id}`);
      seenIds.add(it.id);
      let g = map.get(it.baseId);
      if (!g) {
        g = { baseId: it.baseId, type: it.type, page: it.page, parts: [], refs: [], images: [] };
        map.set(it.baseId, g);
      }
      g.parts.push(it);
      if (g.page == null && it.page != null) g.page = it.page;
      for (const para of it.paras) {
        const re = /\[\^(\d+)\]/g;
        let m;
        while ((m = re.exec(para))) g.refs.push(m[1]);
        // ссылки на картинки — валидатору, чтобы ловить битые пути до деплоя
        for (const raw of para.split('\n')) {
          // внутри цитаты/callout строка идёт с «> » — renderBlocks снимает его при
          // рекурсии, картинка там рендерится штатно. Снимаем и здесь, иначе такая
          // строка не совпала бы с IMG_RE и получила ложное «инлайн не поддержан».
          const line = raw.replace(/^(?:>\s?)+/, '');
          const im = line.match(IMG_RE);
          if (im) {
            // в список на проверку существования — только пути, которые вообще
            // рендерятся; недопустимый отбит рендером и молча стал бы текстом
            if (safeImgSrc(im[2])) g.images.push(im[2]);
            else warnings.push(`[${lang}] недопустимый путь картинки ${im[2]} — нужен относительный путь внутри книги (media/…)`);
            continue;
          }
          // ![](…) посреди строки: инлайн намеренно не поддержан (для схем это блок),
          // но молча оставлять голый markdown нельзя — автор не поймёт, почему «не видно»
          if (INLINE_IMG_RE.test(line)) {
            warnings.push(`[${lang}] картинка внутри абзаца не поддерживается — вынеси ![…](…) на отдельную строку`);
          }
        }
      }
    }
    maps[lang] = map;
  }

  // ── текстовые сектора: пары как в оригинале; только-перевод — после соседа ──
  const isText = (lang, id) => maps[lang].get(id)?.type === 'text';
  const order = [];
  const pos = new Map();
  for (const id of maps[orig].keys()) if (isText(orig, id)) { pos.set(id, order.length); order.push(id); }
  if (trans && maps[trans]) {
    let insertAt = 0;
    for (const id of maps[trans].keys()) {
      if (!isText(trans, id)) continue;
      if (pos.has(id)) { insertAt = pos.get(id) + 1; continue; }
      order.splice(insertAt, 0, id);
      for (const [k, v] of pos) if (v >= insertAt) pos.set(k, v + 1);
      pos.set(id, insertAt);
      insertAt++;
    }
  }

  const pairs = [];
  for (const baseId of order) {
    const o = maps[orig].get(baseId) || null;
    const t = (trans && maps[trans]) ? maps[trans].get(baseId) || null : null;
    const pair = {
      id: baseId,
      page: o ? o.page : null, // страница — только из оригинала, протягивается по id
      type: 'text',
      refs: [...new Set([...(o ? o.refs : []), ...(t ? t.refs : [])])],
      // картинки обоих языков: у каждого своя разметка, но проверять валидатору — все
      images: [...new Set([...(o ? o.images : []), ...(t ? t.images : [])])],
    };
    pair[orig] = o ? renderGroup(o, base) : null;
    if (trans) pair[trans] = t ? renderGroup(t, base) : null;
    pairs.push(pair);
    // непарные секторы — НЕ ошибка: гибридная модель намеренно их допускает
    // (ru-only = проза во всю ширину, ar-only = оригинал с меткой «идёт перевод»);
    // оба рендерятся корректно. Валидатор контракта их больше не метит.
  }
  // глава целиком на одном языке (вступление, ru-only проза) — тоже норма гибрида,
  // не предупреждаем: читателю это не ошибка.

  // ── сноски: пер-язычные, без кросс-спаривания. Авторские (цитаты, в ar) и
  //    переводческие (пояснения терминов, только в ru) — разной природы и числа;
  //    каждый язык несёт свои, ссылка [^N] ведёт к сноске того же языка ──
  for (const lang of langs) {
    if (!maps[lang]) continue;
    for (const g of maps[lang].values()) {
      if (g.type !== 'footnote') continue;
      pairs.push({ id: g.baseId, lang, type: 'footnote', page: null, refs: g.refs, images: g.images, [lang]: renderGroup(g, base) });
    }
  }

  // валидатор: сноски — ссылки без определений и висячие определения (по каждому языку)
  for (const lang of langs) {
    const refs = new Set();
    const defs = new Set();
    for (const g of maps[lang].values()) {
      if (g.type === 'footnote') defs.add(g.baseId.slice(2));
      else g.refs.forEach(r => refs.add(r));
    }
    for (const r of refs) if (!defs.has(r)) warnings.push(`[${lang}] ссылка [^${r}] без определения fn${r}`);
    for (const d of defs) if (!refs.has(d)) warnings.push(`[${lang}] сноска fn${d} без единой ссылки [^${d}]`);
  }

  return { pairs, warnings };
}

/* ═══ ПОДСТРОЧНИК: нумерация слов сектора ═══════════════════════════════════
 *
 * Подстрочник (SPEC 3.4c) поставляется вместе с книгой: на каждый сектор — список
 * строк «номер слово перевод», где НОМЕР это порядковый номер слова внутри сектора.
 *
 * ⚠️ Нумерация обязана совпадать в трёх местах: генератор готовит по ней запрос к ИИ,
 * валидатор по ней проверяет файл, читалка по ней расставляет подписи. Разойдись они
 * на одно слово — и весь рой сектора съедет. Поэтому токенизатор ровно один, здесь,
 * и работает он от РАЗМЕЧЕННОГО HTML сектора (то, что реально видит читатель), а не
 * от исходного markdown: иначе `**жирный**` дал бы лишние «слова» из звёздочек.
 */

// куда подстрочник не лезет: код и формулы (там значимы пробелы), подписи, кнопки сносок
const GLOSS_SKIP_TAGS = ['code', 'pre', 'figcaption', 'button'];

const GLOSS_SKIP_RE = new RegExp(
  '<(' + GLOSS_SKIP_TAGS.join('|') + ')\\b[^>]*>[\\s\\S]*?</\\1\\s*>', 'gi'
);

/* HTML сектора → голый текст, каким его увидит обходчик DOM в читалке. */
function glossPlainText(html) {
  return String(html || '')
    .replace(GLOSS_SKIP_RE, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');   // &amp; последним: иначе «&amp;lt;» развернулось бы дважды
}

/* Текст → слова в порядке следования. Intl.Segmenter есть и в браузере, и в Node;
   регулярка — запасной путь, набор символов тот же, что у wordAt в app.js. */
function glossWords(text) {
  const s = String(text || '');
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(s)]
      .filter(seg => seg.isWordLike)
      .map(seg => seg.segment);
  }
  return s.match(/[\p{L}\p{M}\p{N}_'’-]+/gu) || [];
}

/* HTML сектора → пронумерованные слова [{ n, word }], n с единицы. */
function glossTokens(html) {
  return glossWords(glossPlainText(html)).map((word, i) => ({ n: i + 1, word }));
}

/*
 * Разбор файла подстрочника: якоря <!-- sNNN --> и строки «номер слово перевод».
 * Возвращает { sectors: Map<id, [{ n, word, gloss }]>, warnings }.
 * Пустые строки и комментарии пропускаем, всё прочее — предупреждение: молчаливо
 * проглоченная строка означала бы потерянный перевод, а этого не видно глазами.
 */
/*
 * Хеш сектора — детектор изменений, не защита от подделки.
 *
 * Считается от ПОСЛЕДОВАТЕЛЬНОСТИ СЛОВ, а не от html. Выделили слово жирным — html
 * другой, а номера и слова прежние, и подписи остались верны; хеш от html погнал бы
 * на перегенерацию на ровном месте, а правка самого parser.js обнулила бы его разом
 * по всей библиотеке. Здесь он меняется тогда и только тогда, когда меняется то,
 * ради чего он заведён, — нумерация слов.
 *
 * cyrb53: чистый JS, одинаково в Node и в браузере, без зависимостей и без crypto
 * (в браузере тот асинхронный, а parser.js обязан остаться синхронным).
 */
function glossHash(html) {
  const key = glossTokens(html).map(t => t.word).join(' ');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // 14 знаков: cyrb53 даёт до 53 бит, и без выравнивания ширина хеша плясала бы
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// '' знаменательное · f служебное (по умолчанию не рисуется) · n имя собственное
const GLOSS_CLASSES = new Set(['', 'f', 'n']);

/*
 * Нормализация словарной формы. Она — будущий ключ, по которому слово из разных
 * книг сойдётся в одну запись («выученные», уровни), поэтому разнобой тут дороже
 * всего. Просить модель писать единообразно недостаточно: на трёх прогонах одного
 * сектора она дала и `توقع`, и `توقّع`. Что можно решить кодом — решаем кодом.
 *
 * Снимаем краткие огласовки, тануин, сукун, надстрочный алиф и татвиль.
 * Шадду (ّ) СОХРАНЯЕМ: она различает породы глагола, без неё ثبّت и ثبت сольются.
 *
 * ⚠️ Определённый артикль ال НЕ трогаем механически: в الله это не артикль, и
 * «нормализация» превратила бы имя Аллаха в له. Артикль снимает модель — у неё
 * в промпте есть примеры, и она с этим справляется.
 */
const GLOSS_HARAKAT = /[ً-ِْ-ٰٕـ]/g;

function glossNormalizeBase(base) {
  return String(base || '').replace(GLOSS_HARAKAT, '');
}

/*
 * Разбор файла подстрочника.
 *
 * Якорь сектора несёт атрибуты:   <!-- s005 h=7d3af102c1b4 ok -->
 *   h=…   хеш слов на момент генерации — по нему видно, какие секторы протухли;
 *   ok    сектор выверен человеком; нет атрибута — значит машинная генерация.
 *
 * Строка слова:  <номер><класс> <слово> <подпись> :: <словарная форма> <уровень>
 *   класс приклеен к номеру, а не стоит отдельной колонкой: колонка была бы
 *   неотличима от односимвольного слова (в английском есть «a» и «I»);
 *   подпись «->12» означает намеренно пустую — смысл несёт слово 12.
 *
 * Возвращает { sectors: Map<id, { id, entries, hash, verified }>, warnings }.
 * Всё неразобранное — предупреждение: молча проглоченная строка это потерянный
 * перевод, а такую потерю глазами не видно.
 */
function parseGlossFile(md) {
  const sectors = new Map();
  const warnings = [];
  let cur = null;
  let inComment = false;   // шапка файла — многострочный <!-- … -->
  const lines = String(md || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (!line) continue;
    if (line.startsWith('<!--') && !line.includes('-->')) { inComment = true; continue; }

    let m = line.match(/^<!--\s*(s\d+)\s*([^>]*?)\s*-->$/);
    if (m) {
      const id = m[1];
      cur = sectors.get(id);
      if (!cur) { cur = { id, entries: [], hash: null, verified: false, draft: '' }; sectors.set(id, cur); }
      for (const attr of (m[2] || '').split(/\s+/).filter(Boolean)) {
        if (attr === 'ok') cur.verified = true;
        else if (attr.startsWith('h=')) cur.hash = attr.slice(2);
        else warnings.push(`строка ${i + 1}: непонятный атрибут якоря «${attr}»`);
      }
      continue;
    }
    /* Рабочий перевод модели (такт 1), из которого разложены подписи. Читателю он
       не показывается никогда — правило «машинный перевод не попадает в поток
       секторов» цело. Нужен тому, кто выверяет сектор: без него видно подписи, но
       не видно, откуда они взяты. Читаем, чтобы он пережил перезапись файла. */
    m = line.match(/^<!--\s*ru:\s*([\s\S]*?)\s*-->$/);
    if (m && cur) { cur.draft = m[1]; continue; }
    if (/^<!--[\s\S]*-->$/.test(line)) continue;   // прочие комментарии — заметки автора

    m = line.match(/^(\d+)([a-z]?)\s+(\S+)\s+(.+)$/);
    if (!m) { warnings.push(`строка ${i + 1}: не разобрана — «${line}»`); continue; }
    if (!cur) { warnings.push(`строка ${i + 1}: слово вне сектора — «${line}»`); continue; }
    if (!GLOSS_CLASSES.has(m[2])) {
      warnings.push(`строка ${i + 1}: неизвестный класс «${m[2]}» (бывают f и n)`);
      continue;
    }

    /* Режем по первому «::», а не регуляркой с пробелами вокруг: модель охотно
       присылает строку вообще без подписи («1f A :: a 1»), и разделитель тогда
       оказывается в самом начале хвоста. Такую строку надо ОТВЕРГНУТЬ, а не
       принять пустоту за перевод — иначе под словом окажется мусор. */
    const ix = m[4].indexOf('::');
    const body = (ix >= 0 ? m[4].slice(0, ix) : m[4]).trim();
    const meta = ix >= 0 ? m[4].slice(ix + 2).trim() : '';
    if (!body) {
      warnings.push(`строка ${i + 1}: нет ни подписи, ни ссылки «->N» — «${line}»`);
      continue;
    }

    const entry = { n: parseInt(m[1], 10), cls: m[2], word: m[3], gloss: '', carrier: null };
    /* Канон — ASCII «->12», но на чтении принимаем и «→ 12»: модели упорно рисуют
       типографскую стрелку, а генератор всё равно пишет файл в каноне. Строгость
       на записи, терпимость на чтении — дешевле, чем терять целую строку. */
    const arrow = body.match(/^(?:->|→|—>|–>)\s*(\d+)$/);
    if (arrow) entry.carrier = parseInt(arrow[1], 10);
    else entry.gloss = body;
    if (meta) {
      const parts = meta.trim().split(/\s+/);
      entry.base = parts[0];
      const lvl = parseInt(parts[1], 10);
      if (lvl >= 1 && lvl <= 5) entry.level = lvl;
    }
    cur.entries.push(entry);
  }
  return { sectors, warnings };
}

/*
 * Запрос к ИИ на подстрочник одного сектора.
 *
 * Живёт здесь, а не в генераторе, нарочно: промпт опирается на ту же нумерацию слов,
 * что и всё остальное, и второй потребитель — добор по требованию прямо в читалке.
 * Одну и ту же логику Контракта в этом проекте уже писали дважды (import-tam.js и
 * pubConvert в Вычитке) — и она молча разошлась. Больше не повторяем.
 */
const GLOSS_LANG_NAMES = {
  en: 'английском', ar: 'арабском', fa: 'фарси', tr: 'турецком',
  de: 'немецком', fr: 'французском', ru: 'русском',
};

// шапка запроса: инструкции без самого текста — одна на любое число секторов
function glossPromptHead(lang) {
  return [
    'Ты готовишь ПОДСТРОЧНИК: под каждым словом оригинала — короткая русская подпись.',
    '',
    'Работай в два такта.',
    '',
    'ТАКТ 1. Переведи абзац целиком на русский: буквально, близко к оригиналу, но',
    'грамматично по-русски. Это твой рабочий перевод. В такте 2 ты раскладываешь по',
    'словам ИМЕННО ЕГО, а не переводишь слова заново.',
    'Выведи его одной первой строкой в виде: ПЕРЕВОД: <твой перевод>',
    '',
    'ТАКТ 2. Разложи свой перевод из такта 1 по словам оригинала: по строке на каждое',
    'слово из списка, в том же порядке и с теми же номерами.',
    '',
    'Правила такта 2:',
    '- Форма подписи согласуется с ролью слова во фразе, но конструкция НЕ перестраивается.',
    '  Если в твоём переводе стоит «глазами» — подпись «глазами», а не «глаза».',
    '- Не вводи слов, которых нет в твоём переводе из такта 1. Нет соответствия — не',
    '  придумывай его, поставь пустую подпись (ниже).',
    '- Не переставляй. Строки идут в порядке номеров оригинала, даже если по-русски',
    '  порядок слов другой.',
    '- По возможности одно русское слово на одно исходное. Несколько — только когда иначе',
    '  не сказать: например, одно арабское слово с приставкой и слитным местоимением.',
    '- Одно и то же слово в разных местах абзаца получает разные подписи, если в твоём',
    '  переводе оно передано по-разному.',
    '',
    'ПУСТАЯ ПОДПИСЬ. Если смысл исходного слова в твоём переводе несёт ДРУГОЕ слово',
    '(устойчивый оборот; предлог, ушедший в падеж; вспомогательный глагол), поставь',
    'подписью стрелку на номер слова-носителя: ->12',
    'Строку при этом всё равно выведи. Не пропускай её и не ставь прочерк.',
    '',
    'СТРОКУ ПОЛУЧАЕТ КАЖДОЕ СЛОВО ИЗ СПИСКА, без исключений: артикли, предлоги,',
    'вспомогательные глаголы, имена собственные — всё. Что показывать читателю, решаешь',
    'не ты.',
    '',
    'КЛАСС СЛОВА — буква сразу за номером, без пробела:',
    '  (ничего) — знаменательное слово;',
    '  f — служебное: артикль, предлог, союз, частица, вспомогательный глагол;',
    '  n — имя собственное: ЛИЦО, МЕСТО, НАРОД, НАЗВАНИЕ КНИГИ. И только это.',
    '    Да: الله → Аллах, موسى → Муса, فرعون → Фараон, قريش → курайшиты,',
    '        البخاري → аль-Бухари, مكة → Мекка, صحيح مسلم → «Сахих» Муслима.',
    '    Нет: الإسلام, التوحيد, الشرك, السنة, القرآن как понятие — это нарицательные',
    '        существительные, класс у них обычный, буквы n они не получают.',
    '',
    'Имена собственные передавай по-русски в принятой форме, не оставляй их вязью',
    'или латиницей.',
    '',
    'УРОВЕНЬ — цифра от 1 до 5, насколько слово трудно для изучающего язык:',
    '  1 базовое, знает всякий начинающий; 2 обиходное; 3 обычное книжное;',
    '  4 редкое или специальное; 5 термин, требующий пояснения.',
    'Оценивай слово в том значении, в котором оно здесь стоит.',
    '',
    'РЕЛИГИОЗНЫЙ ТЕКСТ (Коран, хадис, богословие): переводи буквально и осторожно.',
    'Сохраняй устоявшиеся термины, не сглаживай и не додумывай смысл. Где у термина есть',
    'принятая русская передача — используй её, а не описательный пересказ.',
    '',
    'Имя الله передавай как «Аллах». Не «Бог», не «Господь», не «Всевышний».',
    '',
    'СОХРАНЯЙ ТИП ВЫСКАЗЫВАНИЯ. Мольба остаётся мольбой, вопрос вопросом, повеление',
    'повелением. Если в оригинале ду\'а — «да утвердит нас Аллах», — то это и есть перевод;',
    'превратить её в сообщение о прошлом («утвердил нас Аллах») значит сказать неправду о',
    'тексте, а не просто ошибиться в грамматике.',
    '',
    'ФОРМАТ СТРОКИ:',
    '<номер><класс> <слово> <подпись> :: <словарная форма> <уровень>',
    '',
    'Номер и слово копируй из списка без изменений. После « :: » — словарная форма',
    '(инфинитив, единственное число, именительный падеж; если слово и так словарное,',
    'повтори его), затем через пробел цифра уровня. У строки с пустой подписью поле',
    '« :: » тоже ставится.',
    '',
    'СЛОВАРНАЯ ФОРМА ДЛЯ АРАБСКОГО — единообразно, иначе одно слово из разных книг не',
    'сойдётся в одну запись:',
    '  без кратких огласовок (َ ِ ُ ْ) и без определённого артикля ال;',
    '  шадду (ّ) СОХРАНЯЙ — она различает породы: ثبّت, а не ثبت;',
    '  для الإسلام это إسلام, для الرجال это رجل, для وإياهم это إياه.',
    '',
    'Пример строк — сверься с ними, прежде чем отвечать:',
    '3 reader читатель :: reader 2',
    '4f with с :: with 1',
    '6 pencil карандашом :: pencil 3',
    '5f a ->6 :: a 1',
    '',
    'В последней строке подписи нет: артикль «a» отдельным русским словом не',
    'передаётся, его смысл в слове 6. Стрелка пишется ровно двумя знаками ASCII:',
    'дефис и «больше», без пробела перед номером. Не «→», не «-> 6», не «- >6».',
    'Строка без подписи и без стрелки — брак, такую не выводи.',
    'Буква класса приклеена к НОМЕРУ, а не к слову: «5f a», а не «5 af».',
    '',
    'Ответ — строка ПЕРЕВОД и затем только строки подписей. Никакого текста до и после.',
  ].join('\n');
}

/*
 * Блок одного сектора: сам абзац и его пронумерованные слова.
 *
 * Отделён от шапки затем, что на книге в восемьсот секторов гонять по одному
 * запросу на сектор — это часы; а слать восемьсот раз одну и ту же страницу
 * инструкций — деньги на ветер. Группа секторов = одна шапка + несколько блоков.
 */
function glossSectorBlock(html, id) {
  const text = glossPlainText(html).replace(/\s+/g, ' ').trim();
  const tokens = glossTokens(html);
  return [
    id ? `=== СЕКТОР ${id} ===` : '',
    'АБЗАЦ:',
    text,
    '',
    'СЛОВА:',
    tokens.map(t => `${t.n} ${t.word}`).join('\n'),
  ].filter(Boolean).join('\n');
}

// один сектор целиком — шапка плюс его блок (прежнее поведение)
function glossPrompt(html, lang) {
  return glossPromptHead(lang) + '\n\n' + glossSectorBlock(html, null);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseFile, buildChapter, renderGroup, inlineMd, escapeHtml,
    GLOSS_SKIP_TAGS, GLOSS_CLASSES, glossPlainText, glossWords, glossTokens,
    glossHash, glossNormalizeBase, parseGlossFile,
    glossPromptHead, glossSectorBlock, glossPrompt,
  };
}
