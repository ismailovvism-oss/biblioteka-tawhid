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

/* Inline-markdown внутри сектора: жирный, курсив, маркеры сносок [^N]. */
function inlineMd(text) {
  let h = escapeHtml(text);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/\[\^(\d+)\]/g, '<button class="fnref" data-fn="$1" type="button">$1</button>');
  h = h.replace(/\n/g, '<br>');
  return h;
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
function renderGroup(group) {
  const out = [];
  for (const part of group.parts) {
    for (const para of part.paras) out.push('<p>' + inlineMd(para) + '</p>');
  }
  return out.join('');
}

/*
 * Ядро: два файла главы → массив пар + предупреждения валидатора.
 * texts — { ar: "...", ru: "..." }, langs — manifest.languages,
 * первый язык считается оригиналом (источник страниц).
 */
function buildChapter(texts, langs) {
  const orig = langs[0];
  const trans = langs[1];
  const warnings = [];

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
        g = { baseId: it.baseId, type: it.type, page: it.page, parts: [], refs: [] };
        map.set(it.baseId, g);
      }
      g.parts.push(it);
      if (g.page == null && it.page != null) g.page = it.page;
      for (const para of it.paras) {
        const re = /\[\^(\d+)\]/g;
        let m;
        while ((m = re.exec(para))) g.refs.push(m[1]);
      }
    }
    maps[lang] = map;
  }

  // порядок: как в оригинале; сектора только-перевода — после своего соседа
  const order = [];
  const pos = new Map();
  for (const id of maps[orig].keys()) {
    pos.set(id, order.length);
    order.push(id);
  }
  if (trans && maps[trans]) {
    let insertAt = 0;
    for (const id of maps[trans].keys()) {
      if (pos.has(id)) {
        insertAt = pos.get(id) + 1;
        continue;
      }
      order.splice(insertAt, 0, id);
      for (const [k, v] of pos) if (v >= insertAt) pos.set(k, v + 1);
      pos.set(id, insertAt);
      insertAt++;
    }
  }

  // если глава целиком односторонняя (один язык не содержит ни одного текст-сектора),
  // это не рассинхрон, а ещё не подключённый язык — не сорим пер-секторными варнингами
  const textCount = lang => [...(maps[lang]?.values() || [])].filter(g => g.type === 'text').length;
  const oneSided = trans && maps[trans] && (textCount(orig) === 0 || textCount(trans) === 0)
    && (textCount(orig) > 0 || textCount(trans) > 0);

  // пары
  const pairs = [];
  for (const baseId of order) {
    const o = maps[orig].get(baseId) || null;
    const t = (trans && maps[trans]) ? maps[trans].get(baseId) || null : null;
    const any = o || t;
    const pair = {
      id: baseId,
      page: o ? o.page : null, // страница — только из оригинала, протягивается по id
      type: any.type,
      refs: [...new Set([...(o ? o.refs : []), ...(t ? t.refs : [])])],
    };
    pair[orig] = o ? renderGroup(o) : null;
    if (trans) pair[trans] = t ? renderGroup(t) : null;
    pairs.push(pair);

    // валидатор: рассинхрон id (только для двуязычной, не односторонней главы)
    if (trans && !oneSided) {
      const label = any.type === 'footnote' ? 'сноска' : 'сектор';
      if (o && !t) warnings.push(`${label} ${baseId}: есть в ${orig}, нет пары в ${trans}`);
      if (t && !o) {
        warnings.push(
          `${label} ${baseId}: есть в ${trans}, нет пары в ${orig}` +
            (any.type === 'text' ? ' (страница неизвестна)' : '')
        );
      }
    }
  }
  if (oneSided) {
    const present = textCount(orig) > 0 ? orig : trans;
    warnings.push(`глава целиком только в ${present} — второй язык ещё не подключён`);
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
