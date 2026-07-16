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

/* Inline-markdown внутри сектора: подчёркивание, жирный, курсив, маркеры сносок [^N]. */
function inlineMd(text) {
  let h = escapeHtml(text);
  h = h.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>'); // подчёркивание <u>…</u>
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/\[\^(\d+)\]/g, '<button class="fnref" data-fn="$1" type="button">$1</button>');
  h = h.replace(/\n/g, '<br>');
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
function renderBlocks(lines, base) {
  base = base || '';
  const isQuote = l => /^>\s?/.test(l);
  const isUl = l => /^[-*]\s+/.test(l);
  const isOl = l => /^\d+\.\s+/.test(l);
  const out = [];
  let i = 0;
  while (i < lines.length) {
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
      cur = { id: m[1] + m[2], baseId: m[1], type: 'text', page, paras: [''] };
      continue;
    }
    if ((m = line.match(/^<!--\s*fn(\d+)\s*-->$/))) {
      flush();
      cur = { id: 'fn' + m[1], baseId: 'fn' + m[1], type: 'footnote', page, paras: [''] };
      continue;
    }
    if (!cur) continue; // текст вне якорей игнорируется
    if (line === '') {
      if (cur.type === 'text') {
        flush(); // сектор заканчивается на пустой строке
      } else if (cur.paras[cur.paras.length - 1] !== '') {
        cur.paras.push(''); // многоабзацная сноска: новый абзац
      }
      continue;
    }
    const last = cur.paras.length - 1;
    cur.paras[last] = cur.paras[last] ? cur.paras[last] + '\n' + line : line;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseFile, buildChapter, renderGroup, inlineMd, escapeHtml };
}
