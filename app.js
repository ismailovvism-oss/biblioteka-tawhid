'use strict';

/*
 * Приложение поверх ядра (parser.js): одна модель пар — много рендеров (SPEC, раздел 5).
 * Все режимы — состояние/CSS над единым потоком пар, никакого дублирования данных.
 */

/* ===== настройки (localStorage) ===== */
const SETTINGS_KEY = 'chitalka:settings';
const DEFAULTS = {
  theme: 'light',      // light | dark
  visibility: 'both',  // both | <lang>
  layout: 'auto',      // auto | v | h
  fnMode: 'inline',    // inline | jump
  debug: false,        // панель валидатора
  swap: false,         // менять местами оригинал/перевод в паре
  fonts: {},           // lang → { family, size(em) }
  last: {},            // bookId → { chapter, sector, page, ts }
};

/* варианты шрифтов по направлению письма; значение option = font-family стек */
const FONT_CHOICES = {
  rtl: [
    { label: 'Scheherazade New (насх)', stack: '"Scheherazade New", "Noto Naskh Arabic", serif' },
    { label: 'Amiri', stack: '"Amiri", "Scheherazade New", serif' },
    { label: 'Noto Naskh Arabic', stack: '"Noto Naskh Arabic", serif' },
    { label: 'Noto Sans Arabic', stack: '"Noto Sans Arabic", sans-serif' },
    { label: 'Traditional Arabic', stack: '"Traditional Arabic", "Noto Naskh Arabic", serif' },
  ],
  ltr: [
    { label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
    { label: 'PT Serif', stack: '"PT Serif", Georgia, serif' },
    { label: 'Literata', stack: '"Literata", Georgia, serif' },
    { label: 'PT Sans', stack: '"PT Sans", system-ui, sans-serif' },
    { label: 'Системный', stack: 'system-ui, -apple-system, sans-serif' },
  ],
};
const LANG_NAMES = { ar: 'Арабский', ru: 'Русский', en: 'Английский', fa: 'Фарси', tr: 'Турецкий' };
const langName = l => LANG_NAMES[l] || l.toUpperCase();

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* приватный режим */ }
}

const settings = loadSettings();

/* позиция чтения по книге (со старого формата, где было просто число главы) */
function getLast(id) {
  const v = settings.last[id];
  if (typeof v === 'number') return { chapter: v };
  return v || null;
}
function setLast(id, data) {
  settings.last[id] = Object.assign(getLast(id) || {}, data);
}

/* ===== состояние ===== */
let library = [];         // авторский список книг (books/index.json)
let bookId = null;        // id выбранной книги
let base = '';            // префикс путей книги: локальный путь или URL, с «/» на конце
let book = null;          // манифест book.json
let chapterIndex = 0;
let pairs = [];           // модель текущей главы
let warnings = [];
let activeEl = null;      // DOM активной пары
let fnJump = null;        // { originId, fn } для механики «скачок-возврат»
const chapterCache = new Map(); // "<bookId>/<file>" → { pairs, warnings }

const $ = s => document.querySelector(s);
const stream = $('#stream');

/* ===== загрузка ===== */
async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

function showLoadError(msg) {
  stream.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'load-error';
  div.textContent = msg;
  stream.appendChild(div);
}

async function loadChapterData(i) {
  const file = book.chapters[i].file;
  const key = bookId + '/' + file;
  if (!chapterCache.has(key)) {
    const texts = {};
    await Promise.all(book.languages.map(async lang => {
      texts[lang] = await fetchText(`${base}${lang}/${file}`);
    }));
    chapterCache.set(key, buildChapter(texts, book.languages));
  }
  return chapterCache.get(key);
}

function pickTitle(t) {
  const [orig, trans] = book.languages;
  if (t[trans] && t[orig]) return `${t[trans]} · ${t[orig]}`;
  return t[trans] || t[orig] || '';
}

async function loadChapter(i, targetSelector) {
  chapterIndex = i;
  $('#chapter-title').textContent = 'Загрузка…';
  try {
    const data = await loadChapterData(i);
    pairs = data.pairs;
    warnings = data.warnings;
  } catch (err) {
    showLoadError('Не удалось загрузить главу: ' + err.message);
    $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
    return;
  }
  $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
  if (warnings.length) console.warn(`Контракт, ${book.chapters[i].file}:`, warnings);
  renderChapter();
  renderDebug();
  markTocCurrent();
  setLast(bookId, { chapter: i });
  saveSettings();
  if (targetSelector) {
    const el = stream.querySelector(targetSelector);
    if (el) { el.scrollIntoView({ block: 'start' }); flash(el); }
  } else {
    window.scrollTo(0, 0);
  }
  updateActive();
}

/* порядок языков в паре: канонический [orig, trans] или перевёрнутый (настройка) */
function displayLangs() {
  return settings.swap ? book.languages.slice().reverse() : book.languages;
}

/* ===== рендер единого потока пар ===== */
function buildMembers(pair, target) {
  for (const lang of displayLangs()) {
    if (pair[lang] == null) continue;
    const mem = document.createElement('div');
    mem.className = 'member lang-' + lang;
    mem.setAttribute('lang', lang);
    mem.dir = book.rtl.includes(lang) ? 'rtl' : 'ltr'; // направление — из языка контента
    mem.innerHTML = pair[lang];
    target.appendChild(mem);
  }
}

function renderChapter() {
  stream.innerHTML = '';
  activeEl = null;
  fnJump = null;
  let fnDividerDone = false;
  for (const pair of pairs) {
    if (pair.type === 'footnote' && !fnDividerDone) {
      const h = document.createElement('h2');
      h.className = 'fn-divider';
      h.textContent = 'Сноски';
      stream.appendChild(h);
      fnDividerDone = true;
    }
    const el = document.createElement('article');
    el.className = 'pair' + (pair.type === 'footnote' ? ' is-footnote' : '');
    el.dataset.id = pair.id;
    if (pair.page != null) el.dataset.page = pair.page;
    if (pair.type === 'footnote') {
      const label = document.createElement('div');
      label.className = 'fn-label';
      const num = document.createElement('span');
      num.textContent = `[${pair.id.slice(2)}]`;
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'fn-back';
      back.textContent = '← вернуться к тексту';
      back.hidden = true;
      label.append(num, ' ', back);
      el.appendChild(label);
    }
    buildMembers(pair, el);
    stream.appendChild(el);
  }
  if (!pairs.length) {
    const note = document.createElement('div');
    note.className = 'load-error';
    note.textContent =
      'Глава пуста: книга не размечена секторами Контракта (нет якорей <!-- sNNN -->). См. SPEC, раздел 3.';
    stream.appendChild(note);
  }
  applyVisibility();
}

/* ===== видимость языков: both → <orig> → <trans> ===== */
function applyVisibility() {
  if (!book) return;
  const vis = settings.visibility;
  document.querySelectorAll('.member').forEach(m => {
    m.classList.toggle('lang-hidden', vis !== 'both' && m.getAttribute('lang') !== vis);
  });
  // в одноязычном режиме можно «подсмотреть» второй язык тапом по паре
  document.body.toggleAttribute('data-peek', vis !== 'both');
  if (vis === 'both') stream.querySelectorAll('.pair.peek').forEach(p => p.classList.remove('peek'));
  $('#btn-vis').textContent =
    vis === 'both' ? displayLangs().map(l => l.toUpperCase()).join('+') : vis.toUpperCase();
}

function cycleVisibility() {
  const order = ['both', ...book.languages];
  const cur = order.indexOf(settings.visibility);
  settings.visibility = order[(cur + 1) % order.length];
  saveSettings();
  applyVisibility();
  updateActive();
}

/* ===== активная пара (ближайшая к центру вьюпорта) ===== */
function updateActive() {
  const center = window.innerHeight / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of stream.querySelectorAll('.pair')) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const d = r.top <= center && r.bottom >= center
      ? 0
      : Math.min(Math.abs(r.top - center), Math.abs(r.bottom - center));
    if (d < bestDist) { bestDist = d; best = el; }
  }
  if (best !== activeEl) {
    if (activeEl) activeEl.classList.remove('active');
    activeEl = best;
    if (activeEl) activeEl.classList.add('active');
  }
  updatePageIndicator();
  rememberPosition();
}

/* позиция чтения сохраняется с задержкой — не дёргать localStorage на каждый кадр */
let posSaveTick = null;
function rememberPosition() {
  if (!book || !activeEl) return;
  setLast(bookId, { chapter: chapterIndex, sector: activeEl.dataset.id, page: currentPage(), ts: Date.now() });
  if (posSaveTick) clearTimeout(posSaveTick);
  posSaveTick = setTimeout(saveSettings, 500);
}

function currentPage() {
  let el = activeEl;
  while (el && el.dataset.page == null) el = el.previousElementSibling;
  return el ? Number(el.dataset.page) : null;
}

function updatePageIndicator() {
  const p = currentPage();
  $('#page-indicator').textContent = p != null ? 'стр. ' + p : 'стр. —';
  $('#btn-scan').hidden = !(book && book.hasImages && p != null);
}

let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => { scrollTick = false; updateActive(); });
}, { passive: true });
window.addEventListener('resize', () => { applyLayout(); updateActive(); });

/* ===== сноски: две механики над одним источником ===== */
function findPairElBack(el) {
  // ближайшая .pair: сам элемент или предыдущие соседи (для клика внутри .fn-inline)
  while (el && !(el.classList && el.classList.contains('pair'))) el = el.previousElementSibling;
  return el;
}

stream.addEventListener('click', e => {
  const ref = e.target.closest('.fnref');
  if (ref) {
    const block = ref.closest('.pair, .fn-inline');
    if (settings.fnMode === 'jump') jumpToFn(block, ref.dataset.fn);
    else toggleInlineFn(block, ref.dataset.fn);
    return;
  }
  const back = e.target.closest('.fn-back');
  if (back) { returnFromFn(back); return; }
  // одноязычный режим: тап по паре раскрывает/прячет второй язык
  if (settings.visibility !== 'both' && !window.getSelection().toString()) {
    const pairEl = e.target.closest('.pair');
    if (pairEl) pairEl.classList.toggle('peek');
  }
});

function toggleInlineFn(afterEl, n) {
  // повторный тап — свернуть
  let sib = afterEl.nextElementSibling;
  while (sib && sib.classList.contains('fn-inline')) {
    if (sib.dataset.fn === n) { sib.remove(); return; }
    sib = sib.nextElementSibling;
  }
  const fnPair = pairs.find(p => p.id === 'fn' + n);
  const box = document.createElement('aside');
  box.className = 'fn-inline';
  box.dataset.fn = n;
  if (!fnPair) {
    const div = document.createElement('div');
    div.className = 'fn-missing';
    div.textContent = `Сноска ${n} не найдена — битая ссылка (см. валидатор)`;
    box.appendChild(div);
  } else {
    const label = document.createElement('div');
    label.className = 'fn-label';
    label.textContent = `[${n}]`;
    box.appendChild(label);
    buildMembers(fnPair, box); // раскрывается в текущей видимости языков
  }
  let anchor = afterEl;
  while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('fn-inline')) {
    anchor = anchor.nextElementSibling;
  }
  anchor.after(box);
  applyVisibility();
}

function jumpToFn(originBlock, n) {
  const target = stream.querySelector(`.pair[data-id="fn${n}"]`);
  if (!target) { toggleInlineFn(originBlock, n); return; } // битая ссылка — покажем сообщение
  const originPair = findPairElBack(originBlock);
  fnJump = { originId: originPair ? originPair.dataset.id : null, fn: n };
  stream.querySelectorAll('.fn-back').forEach(b => { b.hidden = true; });
  const back = target.querySelector('.fn-back');
  if (back) back.hidden = false;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flash(target);
}

function returnFromFn(btn) {
  btn.hidden = true;
  if (!fnJump || !fnJump.originId) return;
  const origin = stream.querySelector(`.pair[data-id="${fnJump.originId}"]`);
  if (origin) {
    origin.scrollIntoView({ behavior: 'smooth', block: 'center' });
    origin.querySelectorAll(`.fnref[data-fn="${fnJump.fn}"]`).forEach(flash);
  }
  fnJump = null;
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // перезапуск анимации
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

/* ===== навигация: оглавление, главы, страницы ===== */
function buildToc() {
  $('#toc-book-title').textContent = pickTitle(book.title);
  const ul = $('#toc-list');
  ul.innerHTML = '';
  book.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = pickTitle(ch.title);
    btn.addEventListener('click', () => { $('#toc').hidden = true; loadChapter(i); });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function markTocCurrent() {
  document.querySelectorAll('#toc-list li').forEach((li, i) => {
    li.classList.toggle('current', i === chapterIndex);
  });
}

async function gotoPage(n) {
  const local = pairs.find(p => p.page === n);
  if (local) {
    const el = stream.querySelector(`.pair[data-id="${local.id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flash(el); }
    return;
  }
  // нумерация сквозная по тому — ищем по остальным главам
  for (let i = 0; i < book.chapters.length; i++) {
    if (i === chapterIndex) continue;
    let data;
    try { data = await loadChapterData(i); } catch { continue; }
    const hit = data.pairs.find(p => p.page === n);
    if (hit) {
      await loadChapter(i, `.pair[data-id="${hit.id}"]`);
      return;
    }
  }
  toast(`Страница ${n} не найдена`);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

/* ===== скан страницы ===== */
function openScan() {
  const p = currentPage();
  if (p == null || !book.hasImages) return;
  const img = $('#img-scan');
  img.src = base + book.imagePattern.replace('{page}', p);
  img.classList.remove('zoom');
  $('#img-overlay').hidden = false;
}

$('#btn-scan').addEventListener('click', openScan);
$('#img-overlay').addEventListener('click', e => {
  if (e.target.id === 'img-scan') e.target.classList.toggle('zoom');
  else $('#img-overlay').hidden = true;
});

/* ===== панель валидатора ===== */
function renderDebug() {
  const btn = $('#btn-warn');
  btn.hidden = warnings.length === 0;
  btn.textContent = `⚠ ${warnings.length}`;
  const panel = $('#debug-panel');
  panel.hidden = !settings.debug;
  panel.innerHTML = '';
  if (!settings.debug) return;
  const head = document.createElement('div');
  if (!warnings.length) {
    head.className = 'ok';
    head.textContent = 'Контракт: ошибок не найдено ✓';
    panel.appendChild(head);
    return;
  }
  head.className = 'bad';
  head.textContent = `Ошибки контракта (${warnings.length}):`;
  panel.appendChild(head);
  const ul = document.createElement('ul');
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    ul.appendChild(li);
  }
  panel.appendChild(ul);
}

$('#btn-warn').addEventListener('click', () => {
  settings.debug = true;
  $('#set-debug').checked = true;
  saveSettings();
  renderDebug();
});

/* ===== тема и раскладка ===== */
function applyTheme() {
  document.body.dataset.theme = settings.theme;
}

const landscapeMq = window.matchMedia('(orientation: landscape)');
function applyLayout() {
  document.body.dataset.layout =
    settings.layout === 'auto' ? (landscapeMq.matches ? 'h' : 'v') : settings.layout;
}
landscapeMq.addEventListener('change', applyLayout);

/* ===== шрифты: размер и гарнитура на каждый язык ===== */
function fontChoicesFor(lang) {
  return FONT_CHOICES[book.rtl.includes(lang) ? 'rtl' : 'ltr'];
}

function ensureFontDefaults() {
  for (const lang of book.languages) {
    const cur = settings.fonts[lang] || {};
    const defSize = book.rtl.includes(lang) ? 1.35 : 1; // арабский крупнее по умолчанию
    settings.fonts[lang] = {
      family: cur.family || fontChoicesFor(lang)[0].stack,
      size: typeof cur.size === 'number' ? cur.size : defSize,
    };
  }
}

// один <style> с правилами .member.lang-XX, приоритетнее style.css (добавлен позже в head)
function applyFonts() {
  if (!book) return;
  let css = '';
  for (const lang of book.languages) {
    const f = settings.fonts[lang];
    if (f) css += `.member.lang-${lang}{font-family:${f.family};font-size:${f.size}em;}\n`;
  }
  let el = document.getElementById('dyn-fonts');
  if (!el) {
    el = document.createElement('style');
    el.id = 'dyn-fonts';
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// контролы строятся под языки текущей книги (rtl/ltr → разный список гарнитур)
function setupFontSettings() {
  const wrap = $('#set-fonts');
  wrap.innerHTML = '';
  for (const lang of book.languages) {
    const f = settings.fonts[lang];
    const group = document.createElement('div');
    group.className = 'font-group';
    const head = document.createElement('div');
    head.className = 'font-lang';
    head.textContent = `${langName(lang)} (${lang.toUpperCase()})`;
    group.appendChild(head);

    const famLabel = document.createElement('label');
    famLabel.append('Шрифт');
    const sel = document.createElement('select');
    for (const ch of fontChoicesFor(lang)) {
      const o = document.createElement('option');
      o.value = ch.stack;
      o.textContent = ch.label;
      sel.appendChild(o);
    }
    sel.value = f.family;
    if (sel.selectedIndex < 0) { sel.selectedIndex = 0; settings.fonts[lang].family = sel.value; applyFonts(); }
    sel.addEventListener('change', () => {
      settings.fonts[lang].family = sel.value;
      saveSettings();
      applyFonts();
    });
    famLabel.appendChild(sel);
    group.appendChild(famLabel);

    const sizeLabel = document.createElement('label');
    sizeLabel.append('Размер');
    const rng = document.createElement('input');
    rng.type = 'range';
    rng.min = '0.7';
    rng.max = '2.4';
    rng.step = '0.05';
    rng.value = String(f.size);
    const val = document.createElement('span');
    val.className = 'font-size-val';
    const showVal = () => { val.textContent = Math.round(f.size * 100) + '%'; };
    showVal();
    rng.addEventListener('input', () => {
      settings.fonts[lang].size = Number(rng.value);
      showVal();
      applyFonts();
    });
    rng.addEventListener('change', saveSettings);
    sizeLabel.append(rng, val);
    group.appendChild(sizeLabel);

    wrap.appendChild(group);
  }
}

/* ===== настройки: панель ===== */
function bindSettings() {
  const theme = $('#set-theme');
  const layout = $('#set-layout');
  const fnmode = $('#set-fnmode');
  const order = $('#set-order');
  const debug = $('#set-debug');
  theme.value = settings.theme;
  layout.value = settings.layout;
  fnmode.value = settings.fnMode;
  order.value = settings.swap ? '1' : '0';
  debug.checked = settings.debug;
  theme.addEventListener('change', () => { settings.theme = theme.value; saveSettings(); applyTheme(); });
  layout.addEventListener('change', () => { settings.layout = layout.value; saveSettings(); applyLayout(); updateActive(); });
  fnmode.addEventListener('change', () => { settings.fnMode = fnmode.value; saveSettings(); });
  order.addEventListener('change', () => {
    settings.swap = order.value === '1';
    saveSettings();
    if (book) { renderChapter(); updateActive(); }
  });
  debug.addEventListener('change', () => { settings.debug = debug.checked; saveSettings(); renderDebug(); });
}

/* ===== прочие обработчики ===== */
$('#btn-toc').addEventListener('click', () => { $('#toc').hidden = false; });
$('#btn-settings').addEventListener('click', () => { $('#settings').hidden = false; });
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
});
$('#btn-vis').addEventListener('click', () => { if (book) cycleVisibility(); });
$('#btn-prev').addEventListener('click', () => { if (chapterIndex > 0) loadChapter(chapterIndex - 1); });
$('#btn-next').addEventListener('click', () => {
  if (book && chapterIndex < book.chapters.length - 1) loadChapter(chapterIndex + 1);
});
$('#page-indicator').addEventListener('click', () => {
  const p = $('#page-popover');
  p.hidden = !p.hidden;
  if (!p.hidden) $('#page-input').focus();
});
$('#page-form').addEventListener('submit', e => {
  e.preventDefault();
  const n = Number($('#page-input').value);
  $('#page-popover').hidden = true;
  if (n >= 1) gotoPage(n);
});

/* ===== поиск по книге ===== */
// диакритика/татвиль арабского — убираем при поиске
const AR_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/;
const AR_FOLD = { 'آ': 'ا', 'أ': 'ا', 'إ': 'ا', 'ى': 'ي', 'ئ': 'ي', 'ؤ': 'و', 'ة': 'ه' };
function foldChar(ch) {
  if (AR_FOLD[ch]) return AR_FOLD[ch];
  return ch.toLowerCase().replace('ё', 'е');
}
// нормализованная строка + карта: норм-индекс → исходный индекс (для сниппета)
function normalizeWithMap(str) {
  let norm = '';
  const map = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (AR_DIACRITICS.test(ch)) continue; // огласовки/татвиль выкидываем
    norm += foldChar(ch);
    map.push(i);
  }
  return { norm, map };
}
function normalize(str) {
  return normalizeWithMap(str).norm;
}

const htmlToText = (() => {
  const tmp = document.createElement('div');
  return html => { tmp.innerHTML = html; return tmp.textContent || ''; };
})();

let searchSeq = 0;
async function runSearch(raw) {
  const q = normalize(raw).trim();
  const box = $('#search-results');
  if (q.length < 2) { box.textContent = 'Введите минимум 2 символа.'; return; }
  const seq = ++searchSeq;
  box.textContent = 'Поиск…';
  const results = [];
  for (let ci = 0; ci < book.chapters.length; ci++) {
    let data;
    try { data = await loadChapterData(ci); } catch { continue; }
    if (seq !== searchSeq) return; // запущен новый поиск — бросаем этот
    for (const pair of data.pairs) {
      for (const lang of book.languages) {
        if (pair[lang] == null) continue;
        const text = htmlToText(pair[lang]);
        const { norm, map } = normalizeWithMap(text);
        const idx = norm.indexOf(q);
        if (idx >= 0) {
          results.push({ ci, id: pair.id, lang, text, start: map[idx], end: map[idx + q.length - 1] + 1 });
        }
      }
    }
    if (results.length > 200) break;
  }
  if (seq !== searchSeq) return;
  renderResults(results, raw.trim());
}

function renderResults(results, label) {
  const box = $('#search-results');
  box.innerHTML = '';
  if (!results.length) { box.textContent = `Ничего не найдено: «${label}».`; return; }
  const head = document.createElement('div');
  head.className = 'search-count';
  head.textContent = `Найдено: ${results.length}`;
  box.appendChild(head);
  for (const r of results) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-item';

    const meta = document.createElement('span');
    meta.className = 'search-meta';
    meta.textContent = `${pickTitle(book.chapters[r.ci].title)} · ${r.lang.toUpperCase()}`;
    item.appendChild(meta);

    const snip = document.createElement('span');
    snip.className = 'search-snip';
    snip.dir = book.rtl.includes(r.lang) ? 'rtl' : 'ltr';
    const from = Math.max(0, r.start - 40);
    const to = Math.min(r.text.length, r.end + 40);
    snip.append(
      (from > 0 ? '…' : '') + r.text.slice(from, r.start),
    );
    const mark = document.createElement('mark');
    mark.textContent = r.text.slice(r.start, r.end);
    snip.append(mark, r.text.slice(r.end, to) + (to < r.text.length ? '…' : ''));
    item.appendChild(snip);

    item.addEventListener('click', () => {
      $('#search').hidden = true;
      const target = `.pair[data-id="${r.id}"]`;
      if (r.ci === chapterIndex) {
        const el = stream.querySelector(target);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flash(el); }
      } else {
        loadChapter(r.ci, target);
      }
    });
    box.appendChild(item);
  }
}

$('#btn-search').addEventListener('click', () => {
  if (!book) return;
  $('#search').hidden = false;
  $('#search-input').focus();
});
$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  runSearch($('#search-input').value);
});

/* ===== библиотека (авторский список книг) ===== */
function entryLabel(e) {
  return (e.title && (e.title.ru || e.title.ar)) || e.id;
}

function renderLibrary() {
  document.body.dataset.view = 'library';
  book = null;
  document.title = 'Параллельная читалка';
  $('#chapter-title').textContent = library.length ? 'Библиотека' : 'Список книг пуст';
  stream.innerHTML = '';

  const open = e => () => { history.pushState({}, '', '?book=' + encodeURIComponent(e.id)); openBook(e); };

  // карточка «Продолжить» для самой недавно открытой книги
  let recent = null;
  for (const e of library) {
    const l = getLast(e.id);
    if (l && l.ts && (!recent || l.ts > recent.ts)) recent = { entry: e, ts: l.ts, page: l.page };
  }
  if (recent) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'continue-card';
    const cap = document.createElement('span');
    cap.className = 'continue-cap';
    cap.textContent = 'Продолжить чтение';
    const t = document.createElement('span');
    t.className = 'continue-title';
    t.textContent = entryLabel(recent.entry) + (recent.page != null ? ` · стр. ${recent.page}` : '');
    card.append(cap, t);
    card.addEventListener('click', open(recent.entry));
    stream.appendChild(card);
  }

  const ul = document.createElement('ul');
  ul.className = 'book-list';
  for (const e of library) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const title = document.createElement('span');
    title.className = 'book-title';
    title.textContent = entryLabel(e);
    btn.appendChild(title);
    const ar = e.title && e.title.ar;
    if (ar && ar !== entryLabel(e)) {
      const sub = document.createElement('span');
      sub.className = 'book-sub';
      sub.dir = 'rtl';
      sub.textContent = ar;
      btn.appendChild(sub);
    }
    const l = getLast(e.id);
    if (l && (l.page != null || l.sector)) {
      const note = document.createElement('span');
      note.className = 'book-note';
      note.textContent = l.page != null ? `продолжить · стр. ${l.page}` : 'продолжить';
      btn.appendChild(note);
    }
    btn.addEventListener('click', open(e));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  stream.appendChild(ul);
  window.scrollTo(0, 0);
}

async function openBook(entry) {
  bookId = entry.id;
  base = entry.base.endsWith('/') ? entry.base : entry.base + '/';
  chapterCache.clear();
  document.body.dataset.view = 'reading';
  $('#chapter-title').textContent = 'Загрузка…';
  try {
    book = JSON.parse(await fetchText(base + 'book.json'));
  } catch (err) {
    showLoadError(`Не удалось загрузить книгу «${entry.id}»: ${err.message}`);
    $('#chapter-title').textContent = 'Ошибка';
    return;
  }
  if (!['both', ...book.languages].includes(settings.visibility)) settings.visibility = 'both';
  ensureFontDefaults();
  applyFonts();
  setupFontSettings();
  document.title = pickTitle(book.title);
  buildToc();
  const last = getLast(bookId);
  const ci = last && Number.isInteger(last.chapter) ? last.chapter : 0;
  const target = last && last.sector ? `.pair[data-id="${last.sector}"]` : null;
  await loadChapter(Math.min(Math.max(ci, 0), book.chapters.length - 1), target);
}

/* маршрут по ?book=<id>: книга из списка — читаем, иначе — библиотека */
function route() {
  const wanted = new URLSearchParams(location.search).get('book');
  const entry = wanted ? library.find(b => b.id === wanted) : null;
  if (entry) openBook(entry);
  else renderLibrary();
}
window.addEventListener('popstate', route);

$('#btn-home').addEventListener('click', () => {
  history.pushState({}, '', location.pathname);
  renderLibrary();
});

/* ===== старт ===== */
async function init() {
  applyTheme();
  applyLayout();
  bindSettings();
  try {
    const idx = JSON.parse(await fetchText('books/index.json'));
    library = Array.isArray(idx) ? idx : (idx.books || []);
  } catch (err) {
    document.body.dataset.view = 'library';
    showLoadError('Не удалось загрузить список книг (books/index.json): ' + err.message);
    $('#chapter-title').textContent = 'Ошибка';
    return;
  }
  route();
}

init();

/* ===== PWA: офлайн через service worker ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW не зарегистрирован:', err));
  });
}
