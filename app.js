'use strict';

/*
 * Приложение поверх ядра (parser.js): одна модель пар — много рендеров (SPEC, раздел 5).
 * Все режимы — состояние/CSS над единым потоком пар, никакого дублирования данных.
 */

/* ===== настройки (localStorage) ===== */
const SETTINGS_KEY = 'chitalka:settings';
const DEFAULTS = {
  theme: 'light',      // light | dark
  visibility: 'both',  // both | <lang> | quiz:<lang> (самопроверка: виден <lang>, второй язык по тапу)
  layout: 'auto',      // auto | v | h
  fnMode: 'inline',    // inline | jump
  align: 'start',      // start | justify — выравнивание текста
  debug: false,        // панель валидатора
  swap: false,         // менять местами оригинал/перевод в паре
  fonts: {},           // lang → { family, size(em), line(line-height) }
  margin: 0.8,         // боковые поля колонки чтения, rem
  colRatio: 1,         // доля ширины оригинала в две колонки (перевод = 2 - colRatio)
  colRtl: true,        // в две колонки RTL-язык справа
  shelfCat: [],        // выбранный путь в дереве категорий ([] = корень)
  shelfFacets: {},     // активные фасеты: { langs:[], authors:[], era:[], tags:[] }
  highlights: {},      // bookId → [ { chapter, id, lang, start, end, ts } ]
  last: {},            // bookId → { chapter, sector, page, ts }
  bookmarks: {},       // bookId → [ { id, chapter, page, note, ts } ]
  readDays: [],        // ['YYYY-MM-DD', …] — дни, когда что-то читали
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
let catalogTree = [];     // пути-массивы всех узлов дерева (из taxonomy) — показываем даже пустые
let taxNodes = [];        // дерево категорий: плоский список { id, name, parent?, hue?, shade? } (books/taxonomy.json)
let taxById = new Map();  // id → узел
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
      // нет файла для языка (гибрид: глава только на одном языке) — не падаем, пусто
      try { texts[lang] = await fetchText(`${base}${lang}/${file}`); }
      catch { texts[lang] = ''; }
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

// поиск пары по id сравнением dataset (без построения CSS-селектора из данных)
function pairById(id) {
  if (!id) return null;
  for (const el of stream.querySelectorAll('.pair')) if (el.dataset.id === id) return el;
  return null;
}
function scrollToPair(id, smooth) {
  const el = pairById(id);
  if (el) { el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }); flash(el); }
  return el;
}

let loading = false; // глава грузится/перерисовывается — не сохранять промежуточную позицию
// стрелки разделов: прячем ‹ на первой главе и › на последней (видимость, чтобы
// индикатор страницы не съезжал)
function updateChapterNav() {
  $('#btn-prev').classList.toggle('nav-hidden', !book || nextReadable(chapterIndex, -1) < 0);
  $('#btn-next').classList.toggle('nav-hidden', !book || nextReadable(chapterIndex, 1) < 0);
}
async function loadChapter(i, targetId) {
  // запись-группа (без файла) не читается — перейти к ближайшей читаемой
  if (book.chapters[i] && !chHasFile(book.chapters[i])) {
    const r = nextReadable(i, 1); i = r >= 0 ? r : nextReadable(i, -1);
    if (i < 0) return;
  }
  chapterIndex = i;
  updateChapterNav();
  loading = true;
  $('#chapter-title').textContent = 'Загрузка…';
  try {
    const data = await loadChapterData(i);
    pairs = data.pairs;
    warnings = data.warnings;
  } catch (err) {
    showLoadError('Не удалось загрузить главу: ' + err.message);
    $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
    loading = false;
    return;
  }
  $('#chapter-title').textContent = pickTitle(book.chapters[i].title);
  if (warnings.length) console.warn(`Контракт, ${book.chapters[i].file}:`, warnings);
  renderChapter();
  renderDebug();
  markTocCurrent();
  setLast(bookId, { chapter: i });
  recordReadDay();
  saveSettings();
  if (targetId) scrollToPair(targetId, false);
  else window.scrollTo(0, 0);
  loading = false;
  applyPendingHit();
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
    el.dataset.id = pair.id + (pair.lang ? '@' + pair.lang : ''); // сноски пер-язычные → id уникален
    if (pair.page != null) el.dataset.page = pair.page;
    if (pair.type === 'footnote') {
      el.dataset.fn = pair.id.slice(2);
      if (pair.lang) el.dataset.fnlang = pair.lang;
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
    // односторонние текст-сектора — во всю ширину: основной текст книги (есть
    // только перевод) ИЛИ оригинал, перевод которого ещё не готов («awaiting»).
    // Помечаем структурно (по наличию контента), чтобы пережить смену видимости;
    // саму метку «идёт перевод» показывает CSS только в параллельном режиме.
    if (pair.type === 'text') {
      const present = book.languages.filter(l => pair[l] != null);
      if (present.length === 1) {
        el.classList.add('solo');
        if (present[0] === book.languages[0] && book.languages.length > 1) {
          el.classList.add('awaiting');
          el.title = 'Перевод готовится';
        }
      }
    }
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
  markBookmarks();
  applyHighlights();
}

/* ===== видимость языков: both → <orig> → <trans> → quiz:<orig> → quiz:<trans> ===== */
// фактически показанный язык: в самопроверке 'quiz:<lang>' виден <lang>
function visibleLang() {
  return settings.visibility.startsWith('quiz:') ? settings.visibility.slice(5) : settings.visibility;
}

function applyVisibility() {
  if (!book) return;
  const quiz = settings.visibility.startsWith('quiz:');
  const vis = visibleLang();
  document.querySelectorAll('.member').forEach(m => {
    m.classList.toggle('lang-hidden', vis !== 'both' && m.getAttribute('lang') !== vis);
  });
  // сноски пер-язычные: целиком прячем сноску языка, который сейчас скрыт
  document.querySelectorAll('.pair.is-footnote[data-fnlang]').forEach(p => {
    p.classList.toggle('fn-hidden', vis !== 'both' && p.dataset.fnlang !== vis);
  });
  // в одноязычном режиме можно «подсмотреть» второй язык тапом по паре;
  // самопроверка — то же, но скрытый перевод обозначен заглушкой (CSS по data-quiz)
  document.body.toggleAttribute('data-peek', vis !== 'both');
  document.body.toggleAttribute('data-quiz', quiz);
  if (vis === 'both') clearPeeks();
  $('#btn-vis').textContent =
    quiz ? vis.toUpperCase() + '+?' :
    vis === 'both' ? displayLangs().map(l => l.toUpperCase()).join('+') : vis.toUpperCase();
}

function clearPeeks() {
  stream.querySelectorAll('.pair.peek').forEach(p => p.classList.remove('peek'));
}

function cycleVisibility() {
  // самопроверка есть только у двуязычных книг и работает в обе стороны
  const order = book.languages.length > 1
    ? ['both', ...book.languages, ...book.languages.map(l => 'quiz:' + l)]
    : ['both', ...book.languages];
  const cur = order.indexOf(settings.visibility);
  settings.visibility = order[(cur + 1) % order.length];
  saveSettings();
  clearPeeks(); // сменили язык — прежние подсмотры показывали бы теперь-скрытый
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
    updateBookmarkBtn();
  }
  updateProgress();
  updatePageIndicator();
  rememberPosition();
}

let bookPct = 0;
function updateProgress() {
  if (!book || !book.chapters.length) { bookPct = 0; return; }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const cf = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  bookPct = Math.round(((chapterIndex + cf) / book.chapters.length) * 100);
  document.body.style.setProperty('--progress', bookPct + '%');
}

/* позиция чтения сохраняется с задержкой — не дёргать localStorage на каждый кадр */
let posSaveTick = null;
function rememberPosition() {
  if (!book || !activeEl || loading) return; // во время загрузки activeEl может быть из старой главы
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
  // нет маркера страницы (статьи, главы без <!-- pN -->) — не показываем «стр. —»
  const pg = p != null ? 'стр. ' + p : null;
  $('#page-indicator').textContent = book
    ? (pg ? `${pg} · ${bookPct}%` : `${bookPct}%`)
    : (pg || '');
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
    const lang = ref.closest('.member')?.getAttribute('lang') || displayLangs()[0];
    if (settings.fnMode === 'jump') jumpToFn(block, ref.dataset.fn, lang);
    else toggleInlineFn(block, ref.dataset.fn, lang);
    return;
  }
  const back = e.target.closest('.fn-back');
  if (back) { returnFromFn(back); return; }
  const hl = e.target.closest('mark.hl');
  if (hl && window.getSelection().isCollapsed) { removeHighlight(hl.dataset.ts); return; }
  // одноязычный режим: тап по паре раскрывает/прячет второй язык (не мешаем выделению)
  if (settings.visibility !== 'both' && window.getSelection().isCollapsed) {
    const pairEl = e.target.closest('.pair');
    if (pairEl) pairEl.classList.toggle('peek');
  }
});

function toggleInlineFn(afterEl, n, lang) {
  // повторный тап — свернуть
  let sib = afterEl.nextElementSibling;
  while (sib && sib.classList.contains('fn-inline')) {
    if (sib.dataset.fn === n && sib.dataset.fnlang === lang) { sib.remove(); return; }
    sib = sib.nextElementSibling;
  }
  const fnPair = pairs.find(p => p.type === 'footnote' && p.id === 'fn' + n && p.lang === lang);
  const box = document.createElement('aside');
  box.className = 'fn-inline';
  box.dataset.fn = n;
  box.dataset.fnlang = lang;
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

function jumpToFn(originBlock, n, lang) {
  const target = stream.querySelector(`.pair.is-footnote[data-fn="${n}"][data-fnlang="${lang}"]`)
    || stream.querySelector(`.pair.is-footnote[data-fn="${n}"]`);
  if (!target) { toggleInlineFn(originBlock, n, lang); return; } // битая ссылка — покажем сообщение
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
  const origin = pairById(fnJump.originId);
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
let tocRangesFilled = false;
// заголовок главы/группы для оглавления: в режиме одного языка — этот язык,
// иначе двуязычно (важно для групп-заголовков {ar,ru})
function tocTitle(t) {
  if (!t) return '';
  const v = visibleLang();
  if (v !== 'both' && t[v]) return t[v];
  return pickTitle(t);
}
function chHasFile(ch) { return !!(ch && ch.file); }            // header-запись — без file
function chLevel(ch) { return Math.max(0, Math.min(3, (ch && ch.level) | 0)); }
// глава является группой, если следующая запись глубже неё
function isTocGroup(i) {
  const next = book.chapters[i + 1];
  return !!next && chLevel(next) > chLevel(book.chapters[i]);
}
// ближайшая читаемая (с файлом) глава в направлении dir, пропуская header-записи
function nextReadable(from, dir) {
  for (let i = from + dir; i >= 0 && i < book.chapters.length; i += dir)
    if (chHasFile(book.chapters[i])) return i;
  return -1;
}
let tocCollapsed = new Set();   // индексы свёрнутых групп текущей книги
function buildToc() {
  tocCollapsed = new Set();
  $('#toc-book-title').textContent = pickTitle(book.title);
  tocRangesFilled = false;
  renderTocList();
}
function renderTocList() {
  const ul = $('#toc-list');
  ul.innerHTML = '';
  let hideBelow = Infinity;
  book.chapters.forEach((ch, i) => {
    const lvl = chLevel(ch);
    if (lvl > hideBelow) return;            // внутри свёрнутой группы — скрыта
    hideBelow = Infinity;
    const group = isTocGroup(i);
    const collapsed = group && tocCollapsed.has(i);
    if (collapsed) hideBelow = lvl;         // прятать глубже до уровня ≤ lvl
    const li = document.createElement('li');
    li.className = 'toc-li toc-l' + lvl + (chHasFile(ch) ? '' : ' toc-header');
    li.dataset.ci = i;
    li.style.paddingInlineStart = (0.3 + lvl * 0.9) + 'rem';
    const tw = document.createElement('button');
    tw.type = 'button';
    tw.className = 'toc-twist' + (group ? '' : ' leaf');
    tw.textContent = group ? (collapsed ? '▸' : '▾') : '';
    if (group) tw.addEventListener('click', e => {
      e.stopPropagation();
      tocCollapsed.has(i) ? tocCollapsed.delete(i) : tocCollapsed.add(i);
      renderTocList();
    });
    li.appendChild(tw);
    if (chHasFile(ch)) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'toc-link';
      const title = document.createElement('span'); title.className = 'toc-title'; title.textContent = tocTitle(ch.title);
      const pages = document.createElement('span'); pages.className = 'toc-pages'; pages.dataset.ci = i;
      btn.append(title, pages);
      btn.addEventListener('click', () => { $('#toc').hidden = true; consumeOverlayMark(); loadChapter(i); });
      li.appendChild(btn);
    } else {
      const hd = document.createElement('span'); hd.className = 'toc-grouptitle'; hd.textContent = tocTitle(ch.title);
      li.appendChild(hd);
    }
    ul.appendChild(li);
  });
  markTocCurrent();
}

// диапазоны страниц по главам считаем лениво (грузим главы фоном при первом открытии TOC)
async function fillPageRanges() {
  if (tocRangesFilled || !book) return;
  tocRangesFilled = true;
  const myBook = bookId;
  const items = {};
  $('#toc-list').querySelectorAll('.toc-pages').forEach(el => { items[el.dataset.ci] = el; });
  for (let i = 0; i < book.chapters.length; i++) {
    if (!chHasFile(book.chapters[i])) continue;   // группы-заголовки без файла
    let data;
    try { data = await loadChapterData(i); } catch { continue; }
    if (myBook !== bookId) { tocRangesFilled = false; return; } // книгу сменили
    const ps = data.pairs.map(p => p.page).filter(p => p != null);
    if (!ps.length || !items[i]) continue;
    const a = Math.min(...ps), b = Math.max(...ps);
    items[i].textContent = a === b ? `стр. ${a}` : `стр. ${a}–${b}`;
  }
}

function markTocCurrent() {
  document.querySelectorAll('#toc-list li').forEach(li => {
    li.classList.toggle('current', Number(li.dataset.ci) === chapterIndex);
  });
}

/* ===== закладки на сектор (с заметкой) ===== */
function getBookmarks(id = bookId) {
  return settings.bookmarks[id] || []; // чистый геттер — не плодим пустые записи в localStorage
}
function findBookmark(secId) {
  return getBookmarks().find(b => b.id === secId);
}

function toggleActiveBookmark() {
  if (!book || !activeEl) return;
  const secId = activeEl.dataset.id;
  const list = settings.bookmarks[bookId] || (settings.bookmarks[bookId] = []);
  const i = list.findIndex(b => b.id === secId);
  if (i >= 0) list.splice(i, 1);
  else list.push({ id: secId, chapter: chapterIndex, page: currentPage(), note: '', ts: Date.now() });
  saveSettings();
  markBookmarks();
  updateBookmarkBtn();
  buildBookmarks();
  toast(i >= 0 ? 'Закладка снята' : 'Закладка добавлена');
}

// метка на абзацах текущей главы
function markBookmarks() {
  const ids = new Set(getBookmarks().filter(b => b.chapter === chapterIndex).map(b => b.id));
  stream.querySelectorAll('.pair').forEach(el => {
    el.classList.toggle('bookmarked', ids.has(el.dataset.id));
  });
}

function updateBookmarkBtn() {
  const btn = $('#btn-bookmark');
  const on = !!(book && activeEl && findBookmark(activeEl.dataset.id));
  btn.classList.toggle('active-mark', on);
  btn.title = on ? 'Убрать закладку' : 'Закладка на текущем месте';
}

function gotoSector(secId, chapter) {
  $('#toc').hidden = true;
  consumeOverlayMark();
  if (chapter === chapterIndex) scrollToPair(secId, true);
  else loadChapter(chapter, secId);
}

function shareSector(secId) {
  const url = location.origin + location.pathname + '?book=' + encodeURIComponent(bookId) + '&s=' + encodeURIComponent(secId);
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Ссылка скопирована'), () => toast(url));
  else toast(url);
}

// список закладок в оглавлении
function buildBookmarks() {
  const section = $('#bm-section');
  const ul = $('#bm-list');
  ul.innerHTML = '';
  const list = getBookmarks().slice().sort((a, b) => a.chapter - b.chapter || a.id.localeCompare(b.id));
  section.hidden = list.length === 0;
  for (const b of list) {
    const li = document.createElement('li');
    li.className = 'bm-item';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'bm-go';
    const meta = document.createElement('span');
    meta.className = 'bm-meta';
    const chTitle = book.chapters[b.chapter] ? pickTitle(book.chapters[b.chapter].title) : `гл. ${b.chapter + 1}`;
    meta.textContent = chTitle + (b.page != null ? ` · стр. ${b.page}` : '');
    go.appendChild(meta);
    if (b.note) {
      const note = document.createElement('span');
      note.className = 'bm-note';
      note.textContent = b.note;
      go.appendChild(note);
    }
    go.addEventListener('click', () => gotoSector(b.id, b.chapter));
    li.appendChild(go);

    const actions = document.createElement('span');
    actions.className = 'bm-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = 'Заметка';
    edit.textContent = '✎';
    edit.addEventListener('click', () => {
      const text = prompt('Заметка к закладке:', b.note || '');
      if (text === null) return;
      b.note = text.trim();
      saveSettings();
      buildBookmarks();
    });
    const share = document.createElement('button');
    share.type = 'button';
    share.title = 'Скопировать ссылку';
    share.textContent = '↗';
    share.addEventListener('click', () => shareSector(b.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Удалить';
    del.textContent = '🗑';
    del.addEventListener('click', () => {
      const arr = getBookmarks();
      const i = arr.findIndex(x => x.id === b.id);
      if (i >= 0) arr.splice(i, 1);
      saveSettings();
      buildBookmarks();
      markBookmarks();
      updateBookmarkBtn();
    });
    actions.append(edit, share, del);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

$('#btn-bookmark').addEventListener('click', toggleActiveBookmark);

/* ===== текстовые выделения ===== */
function getHighlights(id = bookId) {
  return settings.highlights[id] || [];
}

// нанести сохранённые выделения текущей главы поверх отрендеренных пар
function applyHighlights() {
  for (const h of getHighlights()) {
    if (h.chapter !== chapterIndex) continue;
    const pairEl = pairById(h.id);
    const member = pairEl && pairEl.querySelector(`.member.lang-${h.lang}`);
    if (member) highlightRange(member, h.start, h.end, 'hl', { ts: String(h.ts) });
  }
}

// смещения выделения относительно textContent члена (как у поиска)
function selectionOffsets(member, range) {
  if (!member.contains(range.startContainer) || !member.contains(range.endContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(member);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  return end > start ? { start, end } : null;
}

function addHighlight() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const member = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)
    .closest('.member');
  const pairEl = member && member.closest('.pair');
  if (!member || !pairEl) return;
  const off = selectionOffsets(member, range);
  if (!off) return;
  const lang = member.getAttribute('lang');
  const list = settings.highlights[bookId] || (settings.highlights[bookId] = []);
  list.push({ chapter: chapterIndex, id: pairEl.dataset.id, lang, start: off.start, end: off.end, ts: Date.now() });
  saveSettings();
  sel.removeAllRanges();
  hideSelToolbar();
  // перерисуем выделения главы (проще, чем точечно вставлять поверх возможных пересечений)
  stream.querySelectorAll('mark.hl').forEach(unwrap);
  applyHighlights();
}

function removeHighlight(ts) {
  const list = settings.highlights[bookId];
  if (!list) return;
  const i = list.findIndex(h => String(h.ts) === String(ts));
  if (i >= 0) { list.splice(i, 1); saveSettings(); }
  stream.querySelectorAll('mark.hl').forEach(unwrap);
  applyHighlights();
}

/* плавающая кнопка над выделением */
function showSelToolbar(range) {
  const bar = $('#sel-toolbar');
  $('#sel-err').hidden = !(book && book.feedbackEmail);
  const r = range.getBoundingClientRect();
  bar.hidden = false;
  bar.style.top = Math.max(4, r.top - bar.offsetHeight - 6) + 'px';
  bar.style.left = Math.min(window.innerWidth - bar.offsetWidth - 6,
    Math.max(6, r.left + r.width / 2 - bar.offsetWidth / 2)) + 'px';
}
function hideSelToolbar() { $('#sel-toolbar').hidden = true; }

document.addEventListener('selectionchange', () => {
  if (document.body.dataset.view !== 'reading') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { hideSelToolbar(); return; }
  const range = sel.getRangeAt(0);
  const member = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)
    .closest('.member');
  if (member && stream.contains(member) && member.contains(range.endContainer)) showSelToolbar(range);
  else hideSelToolbar();
});

$('#sel-hl').addEventListener('mousedown', e => { e.preventDefault(); addHighlight(); });
$('#sel-hl').addEventListener('touchstart', e => { e.preventDefault(); addHighlight(); }, { passive: false });

/* «Сообщить об ошибке»: выделенный фрагмент → письмо с местом (глава/сектор/страница/язык).
   Адрес берётся из book.json (feedbackEmail) — у книг без адреса кнопка скрыта. */
function reportError() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const member = el.closest('.member');
  const pairEl = el.closest('.pair');
  if (!member || !pairEl || !book || !book.feedbackEmail) return;
  const frag = sel.toString().trim().slice(0, 400);
  const ch = book.chapters[chapterIndex];
  const subject = `Правка: ${pickTitle(book.title)}`;
  const body = [
    `Книга: ${pickTitle(book.title)} (${bookId})`,
    `Глава: ${ch.file} — ${pickTitle(ch.title)}`,
    `Сектор: ${pairEl.dataset.id}${pairEl.dataset.page ? ` (стр. ${pairEl.dataset.page})` : ''}, язык: ${member.getAttribute('lang')}`,
    '',
    'Фрагмент с ошибкой:',
    `«${frag}»`,
    '',
    'Как должно быть:',
    '',
  ].join('\n');
  location.href = `mailto:${book.feedbackEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  hideSelToolbar();
}
$('#sel-err').addEventListener('mousedown', e => { e.preventDefault(); reportError(); });
$('#sel-err').addEventListener('touchstart', e => { e.preventDefault(); reportError(); }, { passive: false });

async function gotoPage(n) {
  const local = pairs.find(p => p.page === n);
  if (local) {
    scrollToPair(local.id, true);
    return;
  }
  // нумерация сквозная по тому — ищем по остальным главам
  for (let i = 0; i < book.chapters.length; i++) {
    if (i === chapterIndex) continue;
    let data;
    try { data = await loadChapterData(i); } catch { continue; }
    const hit = data.pairs.find(p => p.page === n);
    if (hit) {
      await loadChapter(i, hit.id);
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
  openOverlay($('#img-overlay'));
}

$('#btn-scan').addEventListener('click', openScan);
$('#img-overlay').addEventListener('click', e => {
  if (e.target.id === 'img-scan') e.target.classList.toggle('zoom');
  else { $('#img-overlay').hidden = true; consumeOverlayMark(); }
});

/* ===== панель валидатора ===== */
function renderDebug() {
  const btn = $('#btn-warn');
  // значок валидатора — инструмент автора, не для читателя: только в debug и при варнингах
  btn.hidden = !settings.debug || warnings.length === 0;
  btn.textContent = `⚠ ${warnings.length}`;
  const panel = $('#debug-panel');
  panel.innerHTML = '';
  // панель валидатора — только в debug И только когда есть что показать
  // (зелёную «ошибок не найдено» не рисуем — она лишь занимала место)
  if (!settings.debug || !warnings.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const head = document.createElement('div');
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
const THEME_COLORS = { light: '#f4f1e8', sepia: '#eaddc2', dark: '#222326' };
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() {
  return settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : settings.theme;
}
function applyTheme() {
  const t = resolvedTheme();
  document.body.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && THEME_COLORS[t]) meta.content = THEME_COLORS[t];
}
darkMq.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

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
    const rtl = book.rtl.includes(lang);
    settings.fonts[lang] = {
      family: cur.family || fontChoicesFor(lang)[0].stack,
      size: typeof cur.size === 'number' ? cur.size : (rtl ? 1.35 : 1),     // арабский крупнее
      line: typeof cur.line === 'number' ? cur.line : (rtl ? 1.95 : 1.65),  // и просторнее
    };
  }
}

// один <style> с правилами .member.lang-XX, приоритетнее style.css (добавлен позже в head)
function applyFonts() {
  if (!book) return;
  let css = '';
  for (const lang of book.languages) {
    const f = settings.fonts[lang];
    if (f) css += `.member.lang-${lang}{font-family:${f.family};font-size:${f.size}em;line-height:${f.line};}\n`;
  }
  // ширина колонок (две колонки): доля оригинала vs перевода
  const [orig, trans] = book.languages;
  const r = settings.colRatio;
  css += `body[data-layout="h"] .pair>.member.lang-${orig}{flex-grow:${r};}\n`;
  if (trans) css += `body[data-layout="h"] .pair>.member.lang-${trans}{flex-grow:${(2 - r).toFixed(2)};}\n`;
  let el = document.getElementById('dyn-fonts');
  if (!el) {
    el = document.createElement('style');
    el.id = 'dyn-fonts';
    document.head.appendChild(el);
  }
  el.textContent = css;
  document.body.style.setProperty('--read-pad', settings.margin + 'rem');
  // RTL-язык справа имеет смысл только если в книге есть rtl-язык
  document.body.toggleAttribute('data-colrtl', !!settings.colRtl && book.rtl.length > 0);
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

    group.appendChild(makeSlider('Размер', f.size, 0.7, 2.4, 0.05,
      v => Math.round(v * 100) + '%',
      v => { settings.fonts[lang].size = v; applyFonts(); }));
    group.appendChild(makeSlider('Интервал', f.line, 1.1, 2.6, 0.05,
      v => v.toFixed(2),
      v => { settings.fonts[lang].line = v; applyFonts(); }));

    wrap.appendChild(group);
  }

  // общие поля колонки чтения
  const mg = document.createElement('div');
  mg.className = 'font-group';
  const mh = document.createElement('div');
  mh.className = 'font-lang';
  mh.textContent = 'Поля страницы';
  mg.appendChild(mh);
  mg.appendChild(makeSlider('Ширина полей', settings.margin, 0.2, 3, 0.1,
    v => v.toFixed(1) + ' rem',
    v => { settings.margin = v; applyFonts(); }));
  wrap.appendChild(mg);

  // настройки режима «две колонки»
  const cg = document.createElement('div');
  cg.className = 'font-group';
  const ch = document.createElement('div');
  ch.className = 'font-lang';
  ch.textContent = 'Две колонки';
  cg.appendChild(ch);
  cg.appendChild(makeSlider('Ширина: ориг./перевод', settings.colRatio, 0.5, 1.5, 0.05,
    v => `${v.toFixed(2)} / ${(2 - v).toFixed(2)}`,
    v => { settings.colRatio = v; applyFonts(); }));
  if (book.rtl.length) {
    const lbl = document.createElement('label');
    lbl.className = 'row';
    lbl.append('RTL-язык справа');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.colRtl;
    cb.addEventListener('change', () => { settings.colRtl = cb.checked; saveSettings(); applyFonts(); });
    lbl.appendChild(cb);
    cg.appendChild(lbl);
  }
  wrap.appendChild(cg);
}

// слайдер с живой подписью значения; onInput применяет, change сохраняет
function makeSlider(caption, value, min, max, step, fmt, onInput) {
  const label = document.createElement('label');
  label.append(caption);
  const rng = document.createElement('input');
  rng.type = 'range';
  rng.min = String(min);
  rng.max = String(max);
  rng.step = String(step);
  rng.value = String(value);
  const val = document.createElement('span');
  val.className = 'font-size-val';
  const show = () => { val.textContent = fmt(Number(rng.value)); };
  show();
  rng.addEventListener('input', () => { onInput(Number(rng.value)); show(); });
  rng.addEventListener('change', saveSettings);
  label.append(rng, val);
  return label;
}

/* ===== настройки: панель ===== */
function applyAlign() {
  document.body.dataset.align = settings.align;
}

function syncSettingControls() {
  $('#set-theme').value = settings.theme;
  $('#set-layout').value = settings.layout;
  $('#set-fnmode').value = settings.fnMode;
  $('#set-order').value = settings.swap ? '1' : '0';
  $('#set-align').value = settings.align;
  $('#set-debug').checked = settings.debug;
}

function bindSettings() {
  const theme = $('#set-theme');
  const layout = $('#set-layout');
  const fnmode = $('#set-fnmode');
  const order = $('#set-order');
  const align = $('#set-align');
  const debug = $('#set-debug');
  syncSettingControls();
  theme.addEventListener('change', () => { settings.theme = theme.value; saveSettings(); applyTheme(); });
  layout.addEventListener('change', () => { settings.layout = layout.value; saveSettings(); applyLayout(); updateActive(); });
  fnmode.addEventListener('change', () => { settings.fnMode = fnmode.value; saveSettings(); });
  align.addEventListener('change', () => { settings.align = align.value; saveSettings(); applyAlign(); });
  $('#set-reset').addEventListener('click', () => {
    settings.fonts = {};
    settings.margin = DEFAULTS.margin;
    settings.colRatio = DEFAULTS.colRatio;
    settings.align = DEFAULTS.align;
    saveSettings();
    if (book) { ensureFontDefaults(); applyFonts(); setupFontSettings(); }
    applyAlign();
    syncSettingControls();
    toast('Оформление сброшено к значениям по умолчанию');
  });
  order.addEventListener('change', () => {
    settings.swap = order.value === '1';
    saveSettings();
    if (book) { renderChapter(); updateActive(); }
  });
  debug.addEventListener('change', () => { settings.debug = debug.checked; saveSettings(); renderDebug(); });
}

/* ===== резервная копия настроек и закладок ===== */
function exportSettings() {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `chitalka-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast('Не удалось прочитать файл'); return; }
    if (!data || typeof data !== 'object') { toast('Файл не похож на резервную копию'); return; }
    Object.assign(settings, data);
    saveSettings();
    applyTheme();
    applyLayout();
    applyAlign();
    syncSettingControls();
    if (book) {
      // видимость из бэкапа могла быть с языком другой книги — иначе глава станет пустой
      if (!['both', ...book.languages, ...(book.languages.length > 1 ? book.languages.map(l => 'quiz:' + l) : [])].includes(settings.visibility)) settings.visibility = 'both';
      ensureFontDefaults();
      applyFonts();
      setupFontSettings();
      buildBookmarks();
      renderChapter();
      updateActive();
    }
    toast('Импортировано');
  };
  reader.readAsText(file);
}

$('#btn-help').addEventListener('click', () => { $('#settings').hidden = true; openOverlay($('#help')); });
$('#btn-about').addEventListener('click', () => { $('#settings').hidden = true; openOverlay($('#about')); });

/* ===== статистика чтения ===== */
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function recordReadDay() {
  const today = localDay(new Date());
  if (!settings.readDays.includes(today)) settings.readDays.push(today);
}
function readingStreak() {
  const set = new Set(settings.readDays || []);
  const d = new Date();
  if (!set.has(localDay(d))) d.setDate(d.getDate() - 1); // сегодня ещё не читал — считаем от вчера
  let s = 0;
  while (set.has(localDay(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
function sumOver(map) {
  return Object.values(map || {}).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function buildStats() {
  const rows = [
    ['Дней подряд', `${readingStreak()}`],
    ['Дней с чтением', `${(settings.readDays || []).length}`],
    ['Книг начато', `${library.filter(e => getLast(e.id)).length} из ${library.length}`],
    ['Закладок', `${sumOver(settings.bookmarks)}`],
    ['Выделений', `${sumOver(settings.highlights)}`],
  ];
  const box = $('#stats-body');
  box.innerHTML = '';
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const key = document.createElement('span');
    key.textContent = k;
    const val = document.createElement('b');
    val.textContent = v;
    row.append(key, val);
    box.appendChild(row);
  }
  const streak = readingStreak();
  const note = document.createElement('p');
  note.className = 'stat-note';
  note.textContent = streak > 0
    ? `${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд — так держать!`
    : 'Почитайте сегодня, чтобы начать серию.';
  box.appendChild(note);
}

$('#btn-stats').addEventListener('click', () => { $('#settings').hidden = true; buildStats(); openOverlay($('#stats')); });

$('#set-export').addEventListener('click', exportSettings);
$('#set-import-btn').addEventListener('click', () => $('#set-import').click());
$('#set-import').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) importSettings(file);
  e.target.value = '';
});

/* ===== прочие обработчики ===== */
/* системная «назад» (мобайл) закрывает открытую панель, а не уходит из книги:
   при открытии панели кладём в историю маркер; popstate с маркером = закрыть панель */
let overlayMark = false;   // наш маркер лежит в истории
let suppressPop = false;   // свой history.back() при закрытии из UI — съесть без route()
function openOverlay(el) {
  el.hidden = false;
  if (!overlayMark) { overlayMark = true; history.pushState({ overlay: true }, ''); }
}
// вызвать после закрытия панели из UI (Esc, тап мимо, выбор пункта) — убрать маркер
function consumeOverlayMark() {
  if (overlayMark && !anyPopupOpen()) { overlayMark = false; suppressPop = true; history.back(); }
}
$('#btn-toc').addEventListener('click', () => { openOverlay($('#toc')); fillPageRanges(); });
$('#btn-settings').addEventListener('click', () => { openOverlay($('#settings')); });
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) { ov.hidden = true; consumeOverlayMark(); } });
});
$('#btn-vis').addEventListener('click', () => { if (book) cycleVisibility(); });
$('#btn-prev').addEventListener('click', () => { const p = book && nextReadable(chapterIndex, -1); if (p >= 0) loadChapter(p); });
$('#btn-next').addEventListener('click', () => { const n = book && nextReadable(chapterIndex, 1); if (n >= 0) loadChapter(n); });
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

/* ===== клавиатура: стрелки — главы, Esc — закрыть ===== */
function anyPopupOpen() {
  return [...document.querySelectorAll('.overlay')].some(o => !o.hidden) ||
    !$('#img-overlay').hidden || !$('#page-popover').hidden;
}
function closeTopPopup() {
  if (!$('#img-overlay').hidden) { $('#img-overlay').hidden = true; return true; }
  if (!$('#page-popover').hidden) { $('#page-popover').hidden = true; return true; }
  let closed = false;
  document.querySelectorAll('.overlay').forEach(ov => { if (!ov.hidden) { ov.hidden = true; closed = true; } });
  return closed;
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (closeTopPopup()) consumeOverlayMark(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.body.dataset.view !== 'reading' || !book || anyPopupOpen()) return;
  if (e.key === 'ArrowRight') {
    const n = nextReadable(chapterIndex, 1); if (n >= 0) { loadChapter(n); e.preventDefault(); }
  } else if (e.key === 'ArrowLeft') {
    const p = nextReadable(chapterIndex, -1); if (p >= 0) { loadChapter(p); e.preventDefault(); }
  }
});

/* ===== свайп влево/вправо — смена глав (тач) ===== */
let swipeX = null, swipeY = null, swipeT = 0;
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { swipeX = null; return; }
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
  swipeT = Date.now();
}, { passive: true });
document.addEventListener('touchend', e => {
  if (swipeX == null) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeX, dy = t.clientY - swipeY, dt = Date.now() - swipeT;
  swipeX = null;
  if (document.body.dataset.view !== 'reading' || !book || anyPopupOpen()) return;
  if (dt > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return; // не горизонтальный свайп
  if (dx < 0) { const n = nextReadable(chapterIndex, 1); if (n >= 0) loadChapter(n); }
  else { const p = nextReadable(chapterIndex, -1); if (p >= 0) loadChapter(p); }
}, { passive: true });

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
let pendingHit = null; // { ci, id, lang, start, end } — подсветить после перехода

function jumpToHit(r) {
  $('#search').hidden = true;
  consumeOverlayMark();
  if (r.bookId && r.bookId !== bookId) { // попадание в другой книге — открываем её
    const entry = library.find(e => e.id === r.bookId);
    if (entry) {
      history.pushState({}, '', '?book=' + encodeURIComponent(entry.id));
      openBook(entry, { hit: r });
      return;
    }
  }
  pendingHit = r;
  if (r.ci === chapterIndex) applyPendingHit();
  else loadChapter(r.ci, r.id);
}

// подсветить найденный фрагмент в нужном члене пары; раскрыть язык, если скрыт
function applyPendingHit() {
  const r = pendingHit;
  pendingHit = null;
  stream.querySelectorAll('mark.search-hit').forEach(unwrap);
  if (!r || r.ci !== chapterIndex) return;
  const pairEl = pairById(r.id + '@' + r.lang) || pairById(r.id); // сноски пер-язычные → id@lang
  if (!pairEl) return;
  pairEl.classList.remove('fn-hidden'); // если это сноска скрытого языка — раскроем под подсветку
  const vl = visibleLang();
  if (vl !== 'both' && vl !== r.lang) pairEl.classList.add('peek');
  const member = pairEl.querySelector(`.member.lang-${r.lang}`);
  if (member) highlightRange(member, r.start, r.end);
  pairEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flash(pairEl);
}

function unwrap(el) {
  const parent = el.parentNode;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
  parent.normalize();
}

// обернуть текстовый диапазон [start,end) (по textContent корня) в <mark class=cls>
function highlightRange(root, start, end, cls = 'search-hit', data) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0, startNode = null, startOff = 0, endNode = null, endOff = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (startNode === null && pos + len > start) { startNode = n; startOff = start - pos; }
    if (pos + len >= end) { endNode = n; endOff = end - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return false;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const mark = document.createElement('mark');
    mark.className = cls;
    if (data) Object.assign(mark.dataset, data);
    range.surroundContents(mark); // бросает, если диапазон пересекает границы элементов
    return true;
  } catch {
    return false; // диапазон пересекает разметку (напр. сноску) — пропускаем
  }
}

/* ===== поиск: внутри книги или по всей библиотеке ===== */
// загрузчики, не трогающие глобалы текущей книги (своя кеш-карта)
const searchManifests = new Map(); // id → manifest (+ _base)
const searchChapters = new Map();  // `${id}/${file}` → данные главы
async function searchManifest(entry) {
  if (!searchManifests.has(entry.id)) {
    const b = entry.base.endsWith('/') ? entry.base : entry.base + '/';
    const m = JSON.parse(await fetchText(b + 'book.json'));
    if (!Array.isArray(m.languages) || !Array.isArray(m.chapters)) throw new Error('bad manifest');
    if (!Array.isArray(m.rtl)) m.rtl = [];
    m._base = b;
    searchManifests.set(entry.id, m);
  }
  return searchManifests.get(entry.id);
}
async function searchChapter(entry, m, ci) {
  const key = entry.id + '/' + m.chapters[ci].file;
  if (!searchChapters.has(key)) {
    const texts = {};
    await Promise.all(m.languages.map(async lang => {
      try { texts[lang] = await fetchText(`${m._base}${lang}/${m.chapters[ci].file}`); }
      catch { texts[lang] = ''; }
    }));
    searchChapters.set(key, buildChapter(texts, m.languages));
  }
  return searchChapters.get(key);
}
function searchChapterTitle(m, ci) {
  const t = m.chapters[ci].title || {};
  return t.ru || Object.values(t).find(Boolean) || `Глава ${ci + 1}`;
}

let searchScopeMode = 'library'; // 'book' | 'library'
function setSearchScope(mode) {
  searchScopeMode = mode;
  $('#search-scope').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.scope === mode));
  $('#search-input').placeholder = mode === 'library' ? 'Поиск по всей библиотеке…' : 'Поиск по книге…';
}

const SEARCH_CAP = 300;
async function runSearch(raw) {
  const q = normalize(raw).trim();
  const box = $('#search-results');
  if (q.length < 2) { box.textContent = 'Введите минимум 2 символа.'; return; }
  const seq = ++searchSeq;
  box.textContent = 'Поиск…';
  const libraryScope = searchScopeMode === 'library' || !bookId;
  const entries = libraryScope ? library : library.filter(e => e.id === bookId);
  const results = [];
  let capped = false;
  for (const entry of entries) {
    let m;
    try { m = await searchManifest(entry); } catch { continue; }
    if (seq !== searchSeq) return; // запущен новый поиск — бросаем этот
    for (let ci = 0; ci < m.chapters.length; ci++) {
      let data;
      try { data = await searchChapter(entry, m, ci); } catch { continue; }
      if (seq !== searchSeq) return;
      for (const pair of data.pairs) {
        for (const lang of m.languages) {
          if (pair[lang] == null) continue;
          const text = htmlToText(pair[lang]);
          const { norm, map } = normalizeWithMap(text);
          const idx = norm.indexOf(q);
          if (idx >= 0) results.push({
            bookId: entry.id, bookTitle: entryLabel(entry),
            ci, chTitle: searchChapterTitle(m, ci),
            id: pair.id, lang, rtl: m.rtl.includes(lang),
            text, start: map[idx], end: map[idx + q.length - 1] + 1,
          });
        }
      }
      if (results.length >= SEARCH_CAP) { capped = true; break; }
    }
    if (capped) break;
  }
  if (seq !== searchSeq) return;
  renderResults(results, raw.trim(), libraryScope, capped);
}

function renderResults(results, label, libraryScope, capped) {
  const box = $('#search-results');
  box.innerHTML = '';
  if (!results.length) { box.textContent = `Ничего не найдено: «${label}».`; return; }
  const head = document.createElement('div');
  head.className = 'search-count';
  head.textContent = `Найдено: ${results.length}${capped ? '+ (показаны первые)' : ''}`;
  box.appendChild(head);
  for (const r of results) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-item';

    const meta = document.createElement('span');
    meta.className = 'search-meta';
    meta.textContent = (libraryScope ? `${r.bookTitle} · ` : '') + `${r.chTitle} · ${r.lang.toUpperCase()}`;
    item.appendChild(meta);

    const snip = document.createElement('span');
    snip.className = 'search-snip';
    snip.dir = r.rtl ? 'rtl' : 'ltr';
    const from = Math.max(0, r.start - 40);
    const to = Math.min(r.text.length, r.end + 40);
    snip.append((from > 0 ? '…' : '') + r.text.slice(from, r.start));
    const mark = document.createElement('mark');
    mark.textContent = r.text.slice(r.start, r.end);
    snip.append(mark, r.text.slice(r.end, to) + (to < r.text.length ? '…' : ''));
    item.appendChild(snip);

    item.addEventListener('click', () => jumpToHit(r));
    box.appendChild(item);
  }
}

$('#btn-search').addEventListener('click', () => {
  // в книге — по умолчанию по книге (с переключателем); в библиотеке — по всей
  const bookChip = $('#search-scope').querySelector('[data-scope="book"]');
  bookChip.disabled = !bookId;
  bookChip.classList.toggle('chip-off', !bookId);
  setSearchScope(bookId ? 'book' : 'library');
  openOverlay($('#search'));
  $('#search-input').focus();
});
$('#search-scope').querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
  if (c.dataset.scope === 'book' && !bookId) return;
  setSearchScope(c.dataset.scope);
  const q = $('#search-input').value;
  if (normalize(q).trim().length >= 2) runSearch(q);
}));
$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  runSearch($('#search-input').value);
});

/* ===== библиотека (авторский список книг) ===== */
function entryLabel(e) {
  if (e.title) {
    if (e.title.ru) return e.title.ru; // интерфейс русский — русское название в приоритете
    for (const v of Object.values(e.title)) if (v) return v;
  }
  return e.id;
}

// обложка-заглушка: цвет из id, название по центру
function genCover(e) {
  const div = document.createElement('div');
  div.className = 'cover-gen';
  let h = 0;
  for (const ch of e.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  div.style.background = `linear-gradient(160deg, hsl(${h},35%,38%), hsl(${h},45%,22%))`;
  const t = document.createElement('span');
  t.textContent = entryLabel(e);
  div.appendChild(t);
  const ar = e.title && e.title.ar;
  if (ar && ar !== entryLabel(e)) {
    const a = document.createElement('span');
    a.className = 'cover-gen-ar';
    a.dir = 'rtl';
    a.textContent = ar;
    div.appendChild(a);
  }
  return div;
}

/* фасеты библиотеки: ключ в записи index.json → подпись и формат значения */
// Две независимые оси у книги: ОДОБРЕНИЕ (review) и ГОТОВНОСТЬ (progress).
// Книга может быть одновременно «одобрено» и «в работе». Каждая — свой бейдж и фасет.
const APPROVAL = {
  approved: { label: 'Одобрено администрацией', short: 'Одобрено', icon: '✓', cls: 'review-approved' },
  caution:  { label: 'Осторожно, требует проверки', short: 'Требует проверки', icon: '⚠', cls: 'review-caution' },
};
const PROGRESS = {
  wip:   { label: 'В работе (недоработано)', short: 'В работе', icon: '🚧', cls: 'review-wip' },
  ready: { label: 'Доработано', short: 'Готово', icon: '✔', cls: 'review-ready' },
};
function badgeEl(meta, full) {
  const b = document.createElement('span');
  b.className = 'review-badge ' + meta.cls;
  b.textContent = full ? (meta.icon + ' ' + meta.short) : meta.icon;
  b.title = meta.label;
  return b;
}
// добавить бейджи к обложке: одобрение (слева) + «в работе» (справа). «Готово»
// бейджем не помечаем (это норма), но в фасете «Готовность» оно фильтруется.
function applyBadges(host, e, full) {
  const ap = e && e.review && APPROVAL[e.review];
  if (ap) host.appendChild(badgeEl(ap, full));
  if (e && e.progress === 'wip') host.appendChild(badgeEl(PROGRESS.wip, full));
  else if (full && e && e.progress === 'ready') host.appendChild(badgeEl(PROGRESS.ready, full));
}
const FACETS = [
  { key: 'review', label: 'Одобрение', fmt: v => (APPROVAL[v] ? APPROVAL[v].icon + ' ' + APPROVAL[v].short : v) },
  { key: 'progress', label: 'Готовность', fmt: v => (PROGRESS[v] ? PROGRESS[v].icon + ' ' + PROGRESS[v].short : v) },
  { key: 'langs', label: 'Язык', fmt: v => langName(v) },
  { key: 'authors', label: 'Автор', fmt: v => v },
  { key: 'madhhab', label: 'Мазхаб', fmt: v => v },
  { key: 'era', label: 'Эпоха', fmt: v => v },
  { key: 'genre', label: 'Жанр', fmt: v => v },
  { key: 'tags', label: 'Тема', fmt: v => v },
];
function entryFacetVals(e, key) {
  const v = e[key];
  return Array.isArray(v) ? v : (v ? [v] : []);
}
/* ===== дерево категорий (taxonomy.json, плоский список с parent) ===== */
function buildTaxonomy() {
  taxById = new Map(taxNodes.map(n => [n.id, n]));
  catalogTree = taxNodes.map(n => catPathNames(n.id)); // пути-массивы имён (в т.ч. пустых узлов)
}
// цепочка узлов root→узел (с защитой от циклов)
function catChain(id) {
  const out = []; let n = taxById.get(id); const seen = new Set();
  while (n && !seen.has(n.id)) { seen.add(n.id); out.unshift(n); n = n.parent ? taxById.get(n.parent) : null; }
  return out;
}
function catPathNames(id) { return catChain(id).map(n => n.name); }
// путь имён книги: новый формат — id (строка), старый — массив имён (на случай нестыковки)
function bookCatPath(e) {
  if (typeof e.category === 'string') return catPathNames(e.category);
  if (Array.isArray(e.category)) return e.category;
  return [];
}
// цвет узла: hue ближайшего L1-предка, shade ближайшего узла с shade; глубже наследуется
function catColorOf(id) {
  let hue = null, shade = 0;
  for (const n of catChain(id)) { if (n.hue != null) hue = n.hue; if (n.shade != null) shade = n.shade; }
  return { hue, shade };
}
function entryInCat(e, cat) {
  const p = bookCatPath(e);
  return cat.every((seg, i) => p[i] === seg); // запись лежит в выбранной ветке (или глубже)
}
function entryMatchesFacets(e, facets) {
  for (const f of FACETS) {
    const sel = facets[f.key];
    if (!sel || !sel.length) continue;            // группа неактивна
    const vals = entryFacetVals(e, f.key);
    if (!sel.some(v => vals.includes(v))) return false; // внутри группы — ИЛИ, между группами — И
  }
  return true;
}

/* ===== боковое дерево категорий ===== */
function openTree() { renderTree(); $('#cat-tree').classList.add('open'); $('#tree-backdrop').hidden = false; }
function closeTree() { $('#cat-tree').classList.remove('open'); $('#tree-backdrop').hidden = true; }
function toggleTreeCollapse(id) {
  let c = Array.isArray(settings.treeCollapsed) ? settings.treeCollapsed : (settings.treeCollapsed = []);
  settings.treeCollapsed = c.includes(id) ? c.filter(x => x !== id) : [...c, id];
  saveSettings();
  renderTree();
}
function renderTree() {
  const aside = $('#cat-tree');
  if (!aside) return;
  aside.innerHTML = '';
  const cat = Array.isArray(settings.shelfCat) ? settings.shelfCat : [];
  // дети по parent
  const kids = new Map(); const roots = [];
  for (const n of taxNodes) {
    if (n.parent) { (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n); }
    else roots.push(n);
  }
  // выбранный узел и его предки (активный путь раскрыт)
  let selId = null;
  for (const n of taxNodes) { const p = catPathNames(n.id); if (p.length === cat.length && p.every((s, i) => s === cat[i])) { selId = n.id; break; } }
  const activeIds = new Set(selId ? catChain(selId).map(n => n.id) : []);
  const collapsed = new Set(Array.isArray(settings.treeCollapsed) ? settings.treeCollapsed : []);
  const countUnder = node => {
    const np = catPathNames(node.id);
    return library.filter(e => { const p = bookCatPath(e); return np.every((s, i) => p[i] === s); }).length;
  };
  const goto = path => { settings.shelfCat = path; saveSettings(); closeTree(); renderLibrary(); };
  // «Все книги»
  const allRow = document.createElement('div'); allRow.className = 'tree-row';
  const allTwist = document.createElement('span'); allTwist.className = 'tree-twist leaf'; allRow.appendChild(allTwist);
  const allLink = document.createElement('button'); allLink.type = 'button';
  allLink.className = 'tree-link' + (cat.length === 0 ? ' active' : '');
  allLink.textContent = 'Все книги';
  allLink.addEventListener('click', () => goto([]));
  allRow.appendChild(allLink); aside.appendChild(allRow);
  // рекурсия
  const renderNodes = (list, depth) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    for (const n of list) {
      const children = kids.get(n.id) || [];
      const hasKids = children.length > 0;
      const isCollapsed = hasKids && collapsed.has(n.id) && !activeIds.has(n.id);
      const np = catPathNames(n.id);
      const cnt = countUnder(n);
      const row = document.createElement('div'); row.className = 'tree-row';
      row.style.paddingInlineStart = (depth * 0.9) + 'rem';
      const twist = document.createElement('button'); twist.type = 'button';
      twist.className = 'tree-twist' + (hasKids ? '' : ' leaf');
      twist.textContent = hasKids ? (isCollapsed ? '▸' : '▾') : '';
      if (hasKids) twist.addEventListener('click', () => toggleTreeCollapse(n.id));
      const link = document.createElement('button'); link.type = 'button';
      link.className = 'tree-link' + (selId === n.id ? ' active' : '') + (cnt ? '' : ' empty');
      link.textContent = n.name;
      if (cnt) { const c = document.createElement('span'); c.className = 'tree-count'; c.textContent = ' · ' + cnt; link.appendChild(c); }
      link.addEventListener('click', () => goto(np));
      row.append(twist, link); aside.appendChild(row);
      if (hasKids && !isCollapsed) renderNodes(children, depth + 1);
    }
  };
  renderNodes(roots, 0);
}

/* ===== нижняя панель фильтров (фасеты) ===== */
function activeFilterCount() {
  const f = settings.shelfFacets || {};
  return FACETS.reduce((s, ff) => s + ((f[ff.key] || []).length), 0);
}
function updateFilterBadge() {
  const n = activeFilterCount();
  const b = $('#filter-count');
  if (!b) return;
  b.textContent = n; b.hidden = n === 0;
}
function renderFilterSheet() {
  const body = $('#filter-body');
  if (!body) return;
  body.innerHTML = '';
  const facets = (settings.shelfFacets && typeof settings.shelfFacets === 'object') ? settings.shelfFacets : (settings.shelfFacets = {});
  const cat = Array.isArray(settings.shelfCat) ? settings.shelfCat : [];
  const underCat = library.filter(e => entryInCat(e, cat));
  let any = false;
  for (const f of FACETS) {
    const counts = new Map();
    for (const e of underCat) for (const v of entryFacetVals(e, f.key)) counts.set(v, (counts.get(v) || 0) + 1);
    const sel = facets[f.key] || [];
    if (counts.size < 2 && !sel.length) continue;
    any = true;
    const grp = document.createElement('div'); grp.className = 'facet';
    const lab = document.createElement('div'); lab.className = 'facet-label'; lab.textContent = f.label; grp.appendChild(lab);
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const on = sel.includes(v);
      const c = document.createElement('button'); c.type = 'button';
      c.className = 'chip' + (on ? ' active' : '');
      c.textContent = `${f.fmt(v)} · ${n}`;
      c.addEventListener('click', () => {
        const cur = facets[f.key] || [];
        facets[f.key] = on ? cur.filter(x => x !== v) : [...cur, v];
        saveSettings();
        renderLibrary();      // обновить список под шторкой + бейдж
        renderFilterSheet();  // перерисовать чипсы (счётчики/активность)
      });
      chips.appendChild(c);
    }
    grp.appendChild(chips); body.appendChild(grp);
  }
  if (!any) { const m = document.createElement('div'); m.className = 'facet-empty'; m.textContent = 'Для этого раздела фильтров нет.'; body.appendChild(m); }
}

/* ===== три вида списка книг: обложки / корешки / список ===== */
// детерминированный хэш строки id → число (для высоты/ширины корешка; стабильно)
function hashId(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function openInfoFor(e) { history.pushState({}, '', '?info=' + encodeURIComponent(e.id)); renderBookInfo(e); }
// цвет корешка: hue рода + светлота от оттенка подкатегории (без хэша)
function spineColor(e) {
  const c = catColorOf(e.category);
  const hue = c.hue != null ? c.hue : (hashId(e.id) % 360);
  const L = 34 + (((c.shade || 0) % 5) * 5);
  return { bg: `hsl(${hue} 42% ${L}%)`, edge: `hsl(${hue} 46% ${Math.max(18, L - 13)}%)` };
}
// размеры корешка: ширина по объёму (если есть) иначе по хэшу (34–48px); высота по хэшу (88–100%)
function spineDims(e) {
  const h = hashId(e.id);
  const size = (e.counts && (e.counts.sectors || e.counts.chapters)) || e.pages || e.size || 0;
  let width = size ? 34 + Math.min(14, Math.round(size / 40)) : 34 + (h % 15);
  width = Math.max(34, Math.min(48, width));
  const height = 88 + ((h >>> 8) % 13);
  return { width, height };
}
function coverInto(host, e, alt) {
  if (e.cover) {
    const img = document.createElement('img');
    img.src = e.cover; img.alt = alt || ''; img.loading = 'lazy';
    img.onerror = () => { img.remove(); host.prepend(genCover(e)); };
    host.appendChild(img);
  } else host.appendChild(genCover(e));
}
function renderBookList(shown, view) {
  if (view === 'spines') {
    const shelf = document.createElement('div'); shelf.className = 'spineshelf';
    for (const e of shown) {
      const { bg, edge } = spineColor(e); const { width, height } = spineDims(e);
      const sp = document.createElement('button'); sp.type = 'button'; sp.className = 'spine';
      sp.style.width = width + 'px'; sp.style.height = height + '%';
      sp.style.background = `linear-gradient(90deg, ${edge}, ${bg} 16%, ${bg} 84%, ${edge})`;
      sp.title = entryLabel(e);
      if (e.review && APPROVAL[e.review]) {
        const st = document.createElement('span');
        st.className = 'spine-stripe ' + (e.review === 'approved' ? 'st-ok' : 'st-warn');
        sp.appendChild(st);
      }
      const t = document.createElement('span'); t.className = 'spine-title'; t.textContent = entryLabel(e);
      sp.appendChild(t);
      sp.addEventListener('click', () => openInfoFor(e));
      shelf.appendChild(sp);
    }
    stream.appendChild(shelf);
    return;
  }
  if (view === 'list') {
    const list = document.createElement('div'); list.className = 'booklist';
    for (const e of shown) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'book-row';
      const thumb = document.createElement('span'); thumb.className = 'br-thumb'; coverInto(thumb, e, '');
      const title = document.createElement('span'); title.className = 'br-title'; title.textContent = entryLabel(e);
      const status = document.createElement('span'); status.className = 'br-status'; applyBadges(status, e, false);
      row.append(thumb, title, status);
      row.addEventListener('click', () => openInfoFor(e));
      list.appendChild(row);
    }
    stream.appendChild(list);
    return;
  }
  // обложки (по умолчанию): полка с обложками
  const shelf = document.createElement('div'); shelf.className = 'shelf';
  for (const e of shown) {
    const cell = document.createElement('div'); cell.className = 'shelf-item';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cover';
    btn.title = entryLabel(e); btn.setAttribute('aria-label', entryLabel(e));
    coverInto(btn, e, entryLabel(e));
    const l = getLast(e.id);
    if (l && (l.page != null || l.sector)) {
      const note = document.createElement('span'); note.className = 'cover-badge';
      note.textContent = l.page != null ? `стр. ${l.page}` : '⋯';
      btn.appendChild(note);
    }
    applyBadges(btn, e, false);
    btn.addEventListener('click', () => openInfoFor(e));
    cell.appendChild(btn); shelf.appendChild(cell);
  }
  stream.appendChild(shelf);
}

function renderLibrary() {
  document.body.dataset.view = 'library';
  book = null;
  document.title = 'Библиотека Таухид';
  $('#chapter-title').textContent = library.length ? 'Библиотека Таухид' : 'Список книг пуст';
  stream.innerHTML = '';

  const open = e => () => { history.pushState({}, '', '?book=' + encodeURIComponent(e.id)); openBook(e); };

  renderTree(); // боковое дерево навигации (в #cat-tree)

  // строка «Продолжить» — тонкая, только при сохранённой позиции (стр./сектор)
  let recent = null;
  for (const e of library) {
    const l = getLast(e.id);
    if (l && l.ts && (l.page != null || l.sector) && (!recent || l.ts > recent.ts)) recent = { entry: e, ts: l.ts, page: l.page };
  }
  if (recent) {
    const line = document.createElement('button');
    line.type = 'button'; line.className = 'continue-line';
    const ico = document.createElement('span'); ico.className = 'cl-ico'; ico.textContent = '▶';
    const t = document.createElement('span'); t.className = 'cl-text';
    t.textContent = entryLabel(recent.entry) + (recent.page != null ? ` · стр. ${recent.page}` : '');
    const arr = document.createElement('span'); arr.className = 'cl-arrow'; arr.textContent = '›';
    line.append(ico, t, arr);
    line.addEventListener('click', open(recent.entry));
    stream.appendChild(line);
  }

  // ── классификатор: дерево категорий + фасеты (по полям записи index.json) ──
  const cat = Array.isArray(settings.shelfCat) ? settings.shelfCat : (settings.shelfCat = []);
  const facets = (settings.shelfFacets && typeof settings.shelfFacets === 'object') ? settings.shelfFacets : (settings.shelfFacets = {});
  const panel = document.createElement('div');
  panel.className = 'classifier';

  // хлебные крошки по выбранному пути дерева
  const crumbs = document.createElement('div');
  crumbs.className = 'crumbs';
  const addCrumb = (label, depth) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'crumb' + (depth === cat.length ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { settings.shelfCat = cat.slice(0, depth); saveSettings(); renderLibrary(); });
    crumbs.appendChild(b);
  };
  addCrumb('Все книги', 0);
  cat.forEach((seg, i) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›'; crumbs.appendChild(sep);
    addCrumb(seg, i + 1);
  });
  panel.appendChild(crumbs);

  // книги в текущей ветке дерева
  const underCat = library.filter(e => entryInCat(e, cat));

  // навигация по подкатегориям — в боковом дереве (#cat-tree); фасеты — в нижней
  // панели фильтров (#filter-sheet). На основном экране остаётся только крошка.
  stream.appendChild(panel);
  updateFilterBadge();

  const shown = underCat.filter(e => entryMatchesFacets(e, facets));

  // переключатель видов (запоминается в settings.shelfView)
  const view = ['covers', 'spines', 'list'].includes(settings.shelfView) ? settings.shelfView : (settings.shelfView = 'covers');
  const sw = document.createElement('div'); sw.className = 'view-switch';
  for (const [v, ico, lab] of [['covers', '▦', 'Обложки'], ['spines', '📚', 'Корешки'], ['list', '☰', 'Список']]) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'vs-btn' + (v === view ? ' active' : '');
    b.title = lab; b.textContent = ico;
    b.addEventListener('click', () => { settings.shelfView = v; saveSettings(); renderLibrary(); });
    sw.appendChild(b);
  }
  stream.appendChild(sw);

  if (!shown.length) {
    const m = document.createElement('div');
    m.className = 'shelf-empty';
    m.textContent = 'По выбранным фильтрам книг нет.';
    stream.appendChild(m);
  } else {
    renderBookList(shown, view);
  }
  // подпись внизу полки: чья это библиотека
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'Библиотека Таухид · <a href="mailto:qaadiy@gmail.com">qaadiy@gmail.com</a>';
  stream.appendChild(brand);
  window.scrollTo(0, 0);
}

/* ===== карточка книги: большая обложка, автор, аннотация, кнопки чтения ===== */
async function renderBookInfo(entry) {
  document.body.dataset.view = 'library';
  book = null;
  document.title = entryLabel(entry);
  $('#chapter-title').textContent = entryLabel(entry);
  stream.innerHTML = '';

  // кнопка возврата к каталогу (на странице книги шапочного «домой» нет)
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'bookinfo-back';
  back.textContent = '← Все книги';
  back.addEventListener('click', () => { history.pushState({}, '', location.pathname); renderLibrary(); });
  stream.appendChild(back);

  // манифест книги — за автором, аннотацией и числом глав
  let manifest = null;
  const baseUrl = entry.base.endsWith('/') ? entry.base : entry.base + '/';
  try { manifest = JSON.parse(await fetchText(baseUrl + 'book.json')); } catch { /* карточка работает и без манифеста */ }

  const box = document.createElement('div');
  box.className = 'bookinfo';

  const cov = document.createElement('div');
  cov.className = 'cover bookinfo-cover';
  if (entry.cover) {
    const img = document.createElement('img');
    img.src = entry.cover;
    img.alt = entryLabel(entry);
    img.onerror = () => { img.remove(); cov.prepend(genCover(entry)); };
    cov.appendChild(img);
  } else cov.appendChild(genCover(entry));
  applyBadges(cov, entry, true);
  box.appendChild(cov);

  const meta = document.createElement('div');
  meta.className = 'bookinfo-meta';
  const h = document.createElement('h2');
  h.textContent = entryLabel(entry);
  meta.appendChild(h);
  const subText = entry.title && Object.values(entry.title).find(v => v && v !== entryLabel(entry));
  if (subText) {
    const sub = document.createElement('div');
    sub.className = 'bookinfo-sub';
    sub.dir = /[؀-ۿ]/.test(subText) ? 'rtl' : 'ltr';
    sub.textContent = subText;
    meta.appendChild(sub);
  }
  const author = manifest && manifest.author && (manifest.author.ru || Object.values(manifest.author)[0]);
  if (author) {
    const a = document.createElement('div');
    a.className = 'bookinfo-line';
    a.textContent = 'Автор: ' + author;
    meta.appendChild(a);
  }
  const bits = [];
  if (manifest && Array.isArray(manifest.chapters)) bits.push(`глав: ${manifest.chapters.length}`);
  if (manifest && Array.isArray(manifest.languages) && manifest.languages.length > 1)
    bits.push('параллельный текст: ' + manifest.languages.map(l => langName(l).toLowerCase()).join(' + '));
  if (entry.tags && entry.tags.length) bits.push(entry.tags.join(', '));
  if (bits.length) {
    const b = document.createElement('div');
    b.className = 'bookinfo-line bookinfo-dim';
    b.textContent = bits.join(' · ');
    meta.appendChild(b);
  }
  if (manifest && manifest.description) {
    const d = document.createElement('p');
    d.className = 'bookinfo-desc';
    d.textContent = manifest.description;
    meta.appendChild(d);
  }

  const actions = document.createElement('div');
  actions.className = 'bookinfo-actions';
  const goRead = (opts = {}) => {
    history.pushState({}, '', '?book=' + encodeURIComponent(entry.id));
    openBook(entry, opts);
  };
  const l = getLast(entry.id);
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'bookinfo-read';
  primary.textContent = l ? (l.page != null ? `Продолжить · стр. ${l.page}` : 'Продолжить') : 'Читать';
  primary.addEventListener('click', () => goRead());
  actions.appendChild(primary);
  if (l) {
    const restart = document.createElement('button');
    restart.type = 'button';
    restart.className = 'bookinfo-restart';
    restart.textContent = 'Сначала';
    restart.addEventListener('click', () => goRead({ fromStart: true }));
    actions.appendChild(restart);
  }
  meta.appendChild(actions);
  box.appendChild(meta);
  stream.appendChild(box);
  window.scrollTo(0, 0);
}

async function openBook(entry, opts = {}) {
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
  // мягкая валидация манифеста: rtl/title опциональны, languages/chapters обязательны
  if (!Array.isArray(book.languages) || !book.languages.length ||
      !Array.isArray(book.chapters) || !book.chapters.length) {
    book = null;
    showLoadError(`Книга «${entry.id}»: в book.json нужны непустые массивы languages и chapters.`);
    $('#chapter-title').textContent = 'Ошибка';
    return;
  }
  if (!Array.isArray(book.rtl)) book.rtl = [];
  if (!book.title) book.title = { [book.languages[0]]: entry.id };
  if (!['both', ...book.languages, ...(book.languages.length > 1 ? book.languages.map(l => 'quiz:' + l) : [])].includes(settings.visibility)) settings.visibility = 'both';
  ensureFontDefaults();
  applyFonts();
  setupFontSettings();
  document.title = pickTitle(book.title);
  buildToc();
  buildBookmarks();
  // переход из поиска по библиотеке: открыть нужную главу и подсветить попадание
  if (opts.hit) { pendingHit = opts.hit; await loadChapter(opts.hit.ci, opts.hit.id); return; }
  // deep-link ?s=<sector> — найти главу с этим сектором; иначе вернуться к позиции
  if (opts.sector) {
    const ci = await chapterOfSector(opts.sector);
    if (ci >= 0) { await loadChapter(ci, opts.sector); return; }
    toast(`Сектор ${opts.sector} не найден`);
  }
  if (opts.fromStart) { await loadChapter(0); return; }
  const last = getLast(bookId);
  const ci = last && Number.isInteger(last.chapter) ? last.chapter : 0;
  await loadChapter(Math.min(Math.max(ci, 0), book.chapters.length - 1), last ? last.sector : null);
}

async function chapterOfSector(secId) {
  for (let ci = 0; ci < book.chapters.length; ci++) {
    let d;
    try { d = await loadChapterData(ci); } catch { continue; }
    if (d.pairs.some(p => p.id === secId)) return ci;
  }
  return -1;
}

/* маршрут по ?book=<id>&s=<sector>: книга из списка — читаем, иначе — библиотека */
function route() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('book');
  const entry = wanted ? library.find(b => b.id === wanted) : null;
  const sector = params.get('s');
  // id сектора — только безопасные символы (sNNN/fnNNN/s050a и т.п.)
  const safeSector = sector && /^[\w-]+$/.test(sector) ? sector : null;
  if (entry) { openBook(entry, { sector: safeSector }); return; }
  const info = params.get('info');
  const infoEntry = info ? library.find(b => b.id === info) : null;
  if (infoEntry) renderBookInfo(infoEntry);
  else renderLibrary();
}
window.addEventListener('popstate', () => {
  if (suppressPop) { suppressPop = false; return; }
  if (overlayMark) { overlayMark = false; if (closeTopPopup()) return; }
  route();
});

$('#btn-home').addEventListener('click', () => {
  history.pushState({}, '', location.pathname);
  renderLibrary();
});
$('#btn-cattree').addEventListener('click', openTree);
$('#tree-backdrop').addEventListener('click', closeTree);
$('#btn-filter').addEventListener('click', () => { renderFilterSheet(); openOverlay($('#filter-sheet')); });
$('#filter-apply').addEventListener('click', () => { $('#filter-sheet').hidden = true; });
$('#filter-reset').addEventListener('click', () => {
  settings.shelfFacets = {}; saveSettings();
  renderLibrary(); renderFilterSheet();
});

/* ===== старт ===== */
async function init() {
  applyTheme();
  applyLayout();
  applyAlign();
  bindSettings();
  try {
    const idx = JSON.parse(await fetchText('books/index.json'));
    library = Array.isArray(idx) ? idx : (idx.books || []);
    // дерево категорий — отдельный файл taxonomy.json (плоский список узлов с parent)
    try {
      const tax = JSON.parse(await fetchText('books/taxonomy.json'));
      taxNodes = Array.isArray(tax.categories) ? tax.categories : [];
    } catch { taxNodes = []; }
    buildTaxonomy();
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
