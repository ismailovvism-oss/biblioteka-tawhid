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
  last: {},            // bookId → индекс последней главы
};

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

/* ===== состояние ===== */
const bookId = new URLSearchParams(location.search).get('book') || '_sample';
let book = null;          // манифест book.json
let chapterIndex = 0;
let pairs = [];           // модель текущей главы
let warnings = [];
let activeEl = null;      // DOM активной пары
let fnJump = null;        // { originId, fn } для механики «скачок-возврат»
const chapterCache = new Map(); // file → { pairs, warnings }

const $ = s => document.querySelector(s);
const stream = $('#stream');

/* ===== загрузка ===== */
async function fetchText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

async function loadChapterData(i) {
  const file = book.chapters[i].file;
  if (!chapterCache.has(file)) {
    const texts = {};
    await Promise.all(book.languages.map(async lang => {
      texts[lang] = await fetchText(`books/${bookId}/${lang}/${file}`);
    }));
    chapterCache.set(file, buildChapter(texts, book.languages));
  }
  return chapterCache.get(file);
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
    stream.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'load-error';
    div.textContent = 'Не удалось загрузить главу: ' + err.message;
    stream.appendChild(div);
    $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
    return;
  }
  $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
  if (warnings.length) console.warn(`Контракт, ${book.chapters[i].file}:`, warnings);
  renderChapter();
  renderDebug();
  markTocCurrent();
  settings.last[bookId] = i;
  saveSettings();
  if (targetSelector) {
    const el = stream.querySelector(targetSelector);
    if (el) { el.scrollIntoView({ block: 'start' }); flash(el); }
  } else {
    window.scrollTo(0, 0);
  }
  updateActive();
}

/* ===== рендер единого потока пар ===== */
function buildMembers(pair, target) {
  for (const lang of book.languages) {
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
  applyVisibility();
}

/* ===== видимость языков: both → <orig> → <trans> ===== */
function applyVisibility() {
  if (!book) return;
  const vis = settings.visibility;
  document.querySelectorAll('.member').forEach(m => {
    m.classList.toggle('lang-hidden', vis !== 'both' && m.getAttribute('lang') !== vis);
  });
  $('#btn-vis').textContent =
    vis === 'both' ? book.languages.map(l => l.toUpperCase()).join('+') : vis.toUpperCase();
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
  if (back) returnFromFn(back);
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
  img.src = `books/${bookId}/` + book.imagePattern.replace('{page}', p);
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

/* ===== настройки: панель ===== */
function bindSettings() {
  const theme = $('#set-theme');
  const layout = $('#set-layout');
  const fnmode = $('#set-fnmode');
  const debug = $('#set-debug');
  theme.value = settings.theme;
  layout.value = settings.layout;
  fnmode.value = settings.fnMode;
  debug.checked = settings.debug;
  theme.addEventListener('change', () => { settings.theme = theme.value; saveSettings(); applyTheme(); });
  layout.addEventListener('change', () => { settings.layout = layout.value; saveSettings(); applyLayout(); updateActive(); });
  fnmode.addEventListener('change', () => { settings.fnMode = fnmode.value; saveSettings(); });
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

/* ===== старт ===== */
async function init() {
  applyTheme();
  applyLayout();
  bindSettings();
  try {
    book = JSON.parse(await fetchText(`books/${bookId}/book.json`));
  } catch (err) {
    stream.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'load-error';
    div.textContent = `Не удалось загрузить книгу «${bookId}»: ${err.message}`;
    stream.appendChild(div);
    $('#chapter-title').textContent = 'Ошибка';
    return;
  }
  if (!['both', ...book.languages].includes(settings.visibility)) settings.visibility = 'both';
  document.title = pickTitle(book.title);
  buildToc();
  const last = Number.isInteger(settings.last[bookId]) ? settings.last[bookId] : 0;
  await loadChapter(Math.min(Math.max(last, 0), book.chapters.length - 1));
}

init();
