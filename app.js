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
  last: {},            // bookId → { chapter, sector, page, ts }
  readDays: [],        // ['YYYY-MM-DD', …] — дни, когда что-то читали
  mtProvider: 'mymemory',  // последний выбранный движок машинного перевода
  mtModel: '',             // модель OpenRouter (id из его каталога); ключ — НЕ здесь, см. translate.js
  mtPrompt: 'plain',       // выбранный промпт перевода (id встроенного или своего)
  mtPrompts: [],           // свои промпты: [{ id, label, text }]
  /* подстрочник (gloss.js): только вид и отбор. Сами подписи приходят вместе с
     книгой (SPEC 3.4c), в настройках их нет и быть не должно — это содержимое.
     func — рисовать ли служебные слова (в данных они есть всегда);
     onlyVerified — не рисовать секторы, которых человек не выверял. */
  gloss: { on: false, size: 0.62, dim: 0.62, func: false, onlyVerified: false },
  marks: {},           // bookId → [пометка] — см. «пометки» ниже
  collections: [],     // сквозные тематические сборники из пометок
  // ↓ старые ключи: читаются один раз при миграции в marks и больше не пишутся
  highlights: {},
  bookmarks: {},
};

/* ===== ПОМЕТКИ =====
 * Одна сущность на всё: выделение, заметка, закладка и вырезка — это одна и та же
 * запись, различающаяся заполненными полями. Раньше механизмов было два, и они
 * не сходились: закладка умела заметку, но не знала фрагмента; выделение знало
 * фрагмент, но заметку прицепить было некуда. Из-за этого нельзя было сделать
 * главное — «выделил кусок и записал мысль».
 *
 *   { id, chapter, sector, lang, start, end, color, note, tags[], text, page, ts, edited }
 *
 *   start === null  → якорь на весь сектор (это ЗАКЛАДКА, места в тексте нет)
 *   start !== null  → якорь на фрагмент    (ВЫДЕЛЕНИЕ; с note — ЗАМЕТКА)
 *   text            → снимок самого фрагмента на момент создания
 *
 * Зачем хранить `text`, хотя его можно достать по якорю: ВЫРЕЗКА должна читаться
 * без книги — в общем списке, в сборнике, в выгрузке. Книга может быть приватной
 * (нет сети), переимпортированной (сдвинулись смещения) или вовсе удалённой, а
 * мысль, ради которой фрагмент сохраняли, теряться не должна. Якорь — для «перейти»,
 * снимок — для чтения; расходятся они редко и не смертельно.
 */
const MARK_COLORS = [
  { id: 'yellow', name: 'Жёлтый' },
  { id: 'green', name: 'Зелёный' },
  { id: 'blue', name: 'Голубой' },
  { id: 'pink', name: 'Розовый' },
  { id: 'red', name: 'Красный' },
];
const DEFAULT_COLOR = 'yellow';

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

/* loadSettings склеивает поверхностно, поэтому вложенные ветки достраиваем руками.
   Заодно это рвёт общую ссылку с DEFAULTS: без копии правка настроек меняла бы
   сам DEFAULTS, и «сбросить» возвращал бы уже испорченное значение. */
settings.gloss = Object.assign({}, DEFAULTS.gloss, settings.gloss || {});

/* Миграция старых ключей в `marks`. Выполняется один раз и НЕ трогает исходные
   массивы, пока не сложит всё новое: если что-то пойдёт не так, прежние закладки
   и выделения останутся в localStorage нетронутыми и их можно будет разобрать
   руками. Прошлые данные пользователя дороже чистоты хранилища. */
function migrateMarks() {
  const oldHl = settings.highlights || {};
  const oldBm = settings.bookmarks || {};
  const bookIds = new Set([...Object.keys(oldHl), ...Object.keys(oldBm)]);
  if (!bookIds.size) return;
  let moved = 0;
  for (const id of bookIds) {
    const list = settings.marks[id] || (settings.marks[id] = []);
    const known = new Set(list.map(m => m.ts + ':' + m.sector));
    for (const h of oldHl[id] || []) {
      if (known.has(h.ts + ':' + h.id)) continue;
      list.push({
        id: newMarkId(), chapter: h.chapter, sector: h.id, lang: h.lang,
        start: h.start, end: h.end, color: DEFAULT_COLOR, note: '', tags: [],
        text: '', page: null, ts: h.ts || Date.now(), edited: 0,
      });
      moved++;
    }
    for (const b of oldBm[id] || []) {
      if (known.has(b.ts + ':' + b.id)) continue;
      list.push({
        id: newMarkId(), chapter: b.chapter, sector: b.id, lang: null,
        start: null, end: null, color: null, note: b.note || '', tags: [],
        text: '', page: b.page ?? null, ts: b.ts || Date.now(), edited: 0,
      });
      moved++;
    }
  }
  settings.highlights = {};
  settings.bookmarks = {};
  if (moved) saveSettings();
}

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

/* Приватная книга (BACKEND.md, фаза 2): статической базы у неё нет — файлы лежат в
   закрытом бакете Supabase, а `base` записи хранит префикс объекта. Читаем через
   короткоживущий подписанный URL, который бэкенд выдаёт только при праве доступа (RLS).
   Публичные книги идут прежним путём — прямым fetch с CDN, с кешем SW и офлайном.
   Флаг открытой книги — `privateBook` (ставится в openBook), но карточка книги рисуется
   ДО открытия, поэтому режим можно передать явно вторым аргументом. */
let privateBook = false;
async function fetchBookText(path, isPrivate = privateBook) {
  if (!isPrivate) return fetchText(path);
  return fetchText(await SB.signedUrl('book-content', path));
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
      try { texts[lang] = await fetchBookText(`${base}${lang}/${file}`); }
      catch { texts[lang] = ''; }
    }));
    // base — чтобы ![](media/…) в секторе резолвился от папки книги, как и сканы
    chapterCache.set(key, buildChapter(texts, book.languages, { base }));
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
  ensureGlossChapter();   // фоном: подписи лягут на уже отрисованный текст
  // выделение режима перевода указывало в прежнюю главу — её узлов больше нет
  if (typeof clearMtSel === 'function') clearMtSel();
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
  detachMtCard();          // иначе innerHTML = '' уничтожит карточку вместе с обработчиками
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
  applyMarks();
  applyGloss();   // подстрочник кладётся последним — поверх уже покрашенных пометок
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
  // подписанное слово: показать, что за лемма, и дать убрать её из роя.
  // Проверяем первым — обёртка слова лежит глубже подкраски пометки
  const gw = e.target.closest('span.gl');
  if (gw && window.getSelection().isCollapsed) { openGlossPop(gw); return; }
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
  // иллюстрация в тексте → тот же полноэкранный просмотр, что у сканов
  const figImg = e.target.closest('.fig img');
  if (figImg) { showImage(figImg.currentSrc || figImg.src); return; }
  const hl = e.target.closest('mark.hl');
  // тап по выделению открывает его правку (цвет, заметка, теги, сборники), а не удаляет:
  // случайно снести мысль одним касанием — слишком дорого
  if (hl && window.getSelection().isCollapsed) { openMarkEditor(hl.dataset.mark); return; }
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
let tocQuery = '';              // фильтр по названиям глав
function buildToc() {
  tocCollapsed = new Set();
  tocQuery = '';
  const f = $('#toc-filter');
  if (f) { f.value = ''; f.hidden = book.chapters.length < 12; }  // на короткой книге незачем
  $('#toc-book-title').textContent = pickTitle(book.title);
  tocRangesFilled = false;
  renderTocList();
}

/* Фильтр оглавления. Пока он пуст — обычное дерево с уровнями и сворачиванием.
   Как только что-то введено, дерево разворачивается в ПЛОСКИЙ список совпавших глав:
   иерархия при фильтрации только мешает — родительские группы обычно не совпадают
   с запросом, и совпавшие главы оказались бы спрятаны под ними. */
function renderTocList() {
  const ul = $('#toc-list');
  ul.innerHTML = '';
  if (tocQuery) return renderTocFiltered(ul);
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

function renderTocFiltered(ul) {
  const words = normalize(tocQuery).split(/\s+/).filter(Boolean);
  // путь групп над главой — чтобы в плоском списке было видно, откуда она
  const trail = i => {
    const out = [];
    let lvl = chLevel(book.chapters[i]);
    for (let j = i - 1; j >= 0 && lvl > 0; j--) {
      const l = chLevel(book.chapters[j]);
      if (l < lvl && !chHasFile(book.chapters[j])) { out.unshift(tocTitle(book.chapters[j].title)); lvl = l; }
    }
    return out;
  };
  let found = 0;
  book.chapters.forEach((ch, i) => {
    if (!chHasFile(ch)) return;                 // группы сами по себе не открыть
    const title = tocTitle(ch.title);
    const hay = normalize(title + ' ' + trail(i).join(' '));
    if (!words.every(w => hay.includes(w))) return;
    found++;
    const li = document.createElement('li');
    li.className = 'toc-li toc-l0 toc-flat';
    li.dataset.ci = i;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'toc-link';
    const t = document.createElement('span'); t.className = 'toc-title'; t.textContent = title;
    btn.appendChild(t);
    const path = trail(i);
    if (path.length) {
      const p = document.createElement('span'); p.className = 'toc-trail'; p.textContent = path.join(' › ');
      btn.appendChild(p);
    }
    btn.addEventListener('click', () => { $('#toc').hidden = true; consumeOverlayMark(); loadChapter(i); });
    li.appendChild(btn);
    ul.appendChild(li);
  });
  if (!found) {
    const li = document.createElement('li');
    li.className = 'toc-none';
    li.textContent = `Глав по запросу «${tocQuery}» нет.`;
    ul.appendChild(li);
  }
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

/* ===== пометки: доступ к данным ===== */
function newMarkId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function getMarks(id = bookId) {
  return settings.marks[id] || [];  // чистый геттер — не плодим пустые записи в localStorage
}
function markList(id = bookId) {
  return settings.marks[id] || (settings.marks[id] = []);
}
function findMark(mid, id = bookId) {
  return getMarks(id).find(m => m.id === mid);
}
const isClip = m => m.start !== null && m.start !== undefined;   // вырезка = пометка с фрагментом

/* Все пометки всех книг одним списком — основа раздела «Вырезки». Записи не копируются:
   возвращаются ссылки на те же объекты, чтобы правка из любого места меняла оригинал. */
function allMarks() {
  const out = [];
  for (const [id, list] of Object.entries(settings.marks || {})) {
    for (const m of list) out.push({ book: id, mark: m });
  }
  return out;
}
function bookTitleById(id) {
  const e = library.find(b => b.id === id);
  if (!e) return id;
  const t = e.title || {};
  return t.ru || Object.values(t)[0] || id;
}
// все теги, уже применённые хоть где-то — для подсказок и фильтра
function allTags() {
  const s = new Set();
  for (const { mark } of allMarks()) for (const t of mark.tags || []) s.add(t);
  for (const c of settings.collections || []) for (const t of c.tags || []) s.add(t);
  return [...s].sort((a, b) => a.localeCompare(b, 'ru'));
}

/* ===== пометки: нанесение на текущую главу ===== */
function applyMarks() {
  // закладки на сектор — метка на самой паре
  const secIds = new Set(getMarks().filter(m => !isClip(m) && m.chapter === chapterIndex).map(m => m.sector));
  stream.querySelectorAll('.pair').forEach(el => {
    el.classList.toggle('bookmarked', secIds.has(el.dataset.id));
  });
  // вырезки — подкраска фрагмента внутри члена пары
  for (const m of getMarks()) {
    if (!isClip(m) || m.chapter !== chapterIndex) continue;
    const pairEl = pairById(m.sector);
    const member = pairEl && pairEl.querySelector(`.member.lang-${m.lang}`);
    if (!member) continue;
    const cls = 'hl hl-' + (m.color || DEFAULT_COLOR) + (m.note ? ' has-note' : '');
    highlightRange(member, m.start, m.end, cls, { mark: m.id });
  }
}

// перерисовать подкраску целиком: проще и надёжнее точечной вставки поверх пересечений
function repaintMarks() {
  // подстрочник снимаем ПЕРЕД перекраской: его обёртки слов режут диапазон
  // выделения на куски, и цельным <mark> он бы уже не обернулся
  stream.querySelectorAll('.member').forEach(m => glClear(m));
  stream.querySelectorAll('mark.hl').forEach(unwrap);
  applyMarks();
  applyGloss();
}

/* ===== пометки: создание и правка ===== */
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

/* Выделенный фрагмент → новая пометка. Возвращает её или null.
   openNote — сразу открыть редактор заметки (путь «выделил и записал мысль»). */
function addRangeMark(color = DEFAULT_COLOR, openNote = false) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const member = startEl.closest('.member');
  const pairEl = member && member.closest('.pair');
  if (!member || !pairEl) return null;
  const off = selectionOffsets(member, range);
  if (!off) return null;
  const mark = {
    id: newMarkId(),
    chapter: chapterIndex,
    sector: pairEl.dataset.id,
    lang: member.getAttribute('lang'),
    start: off.start,
    end: off.end,
    color,
    note: '',
    tags: [],
    text: sel.toString().replace(/\s+/g, ' ').trim(),   // снимок — см. шапку «ПОМЕТКИ»
    page: pairEl.dataset.page ? Number(pairEl.dataset.page) : currentPage(),
    ts: Date.now(),
    edited: 0,
  };
  markList().push(mark);
  saveSettings();
  sel.removeAllRanges();
  hideSelToolbar();
  repaintMarks();
  buildMarkPanel();
  if (openNote) openMarkEditor(mark.id, { focusNote: true });
  else toast('Выделено');
  return mark;
}

// закладка на текущем месте — пометка без фрагмента
function toggleActiveBookmark() {
  if (!book || !activeEl) return;
  const secId = activeEl.dataset.id;
  const list = markList();
  const i = list.findIndex(m => !isClip(m) && m.sector === secId && m.chapter === chapterIndex);
  if (i >= 0) list.splice(i, 1);
  else list.push({
    id: newMarkId(), chapter: chapterIndex, sector: secId, lang: null,
    start: null, end: null, color: null, note: '', tags: [],
    text: (activeEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    page: currentPage(), ts: Date.now(), edited: 0,
  });
  saveSettings();
  applyMarks();
  updateBookmarkBtn();
  buildMarkPanel();
  toast(i >= 0 ? 'Закладка снята' : 'Закладка добавлена');
}

function updateBookmarkBtn() {
  const btn = $('#btn-bookmark');
  const on = !!(book && activeEl && getMarks().some(m => !isClip(m) && m.sector === activeEl.dataset.id && m.chapter === chapterIndex));
  btn.classList.toggle('active-mark', on);
  btn.title = on ? 'Убрать закладку' : 'Закладка на текущем месте';
}

function removeMark(mid) {
  const list = markList();
  const i = list.findIndex(m => m.id === mid);
  if (i < 0) return;
  list.splice(i, 1);
  // подчистить ссылки в сборниках, иначе там останутся мёртвые записи
  for (const c of settings.collections || []) {
    c.items = (c.items || []).filter(it => !(it.book === bookId && it.mark === mid));
  }
  saveSettings();
  repaintMarks();
  applyMarks();
  updateBookmarkBtn();
  buildMarkPanel();
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

/* ===== редактор пометки ===== */
let editingMark = null;   // { book, id }

function openMarkEditor(mid, { focusNote = false, bookOf = bookId } = {}) {
  const m = findMark(mid, bookOf);
  if (!m) return;
  editingMark = { book: bookOf, id: mid };
  const box = $('#mark-editor');

  $('#mark-text').textContent = m.text || '(фрагмент не сохранён)';
  $('#mark-text').hidden = !m.text;
  $('#mark-where').textContent = markPlace(bookOf, m);
  $('#mark-note').value = m.note || '';
  $('#mark-tags').value = (m.tags || []).join(', ');

  // палитра: у закладки цвета нет — красить нечего
  const pal = $('#mark-colors');
  pal.hidden = !isClip(m);
  pal.innerHTML = '';
  for (const c of MARK_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch sw-' + c.id + (m.color === c.id ? ' on' : '');
    b.title = c.name;
    b.addEventListener('click', () => {
      m.color = c.id; m.edited = Date.now();
      saveSettings(); repaintMarks(); openMarkEditor(mid, { bookOf });
    });
    pal.appendChild(b);
  }

  renderTagSuggest();
  renderCollectionPicker();
  openOverlay(box);
  if (focusNote) setTimeout(() => $('#mark-note').focus(), 60);
}

/* «Книга · Глава · стр. N» — источник вырезки, читаемый и вне книги.
   withBook: в списке вырезок название книги нужно ВСЕГДА (там вперемешку разные книги),
   а в панели внутри книги оно только шумит — и так понятно, где находишься. */
function markPlace(bid, m, withBook = false) {
  const parts = [];
  if (withBook || bid !== bookId) parts.push(bookTitleById(bid));
  if (bid === bookId && book && book.chapters[m.chapter]) parts.push(pickTitle(book.chapters[m.chapter].title));
  else parts.push('гл. ' + (m.chapter + 1));
  if (m.page != null) parts.push('стр. ' + m.page);
  return parts.join(' · ');
}

function saveMarkEditor() {
  if (!editingMark) return;
  const m = findMark(editingMark.id, editingMark.book);
  if (!m) return;
  m.note = $('#mark-note').value.trim();
  m.tags = $('#mark-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  m.edited = Date.now();
  saveSettings();
  if (editingMark.book === bookId) repaintMarks();
  buildMarkPanel();
  renderClips();
  $('#mark-editor').hidden = true;
  consumeOverlayMark();
  toast('Сохранено');
}

// подсказки уже использованных тегов — чтобы теги не плодились опечатками
function renderTagSuggest() {
  const box = $('#mark-tag-suggest');
  box.innerHTML = '';
  const used = $('#mark-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  const rest = allTags().filter(t => !used.includes(t)).slice(0, 12);
  box.hidden = !rest.length;
  for (const t of rest) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip tag-chip';
    b.textContent = t;
    b.addEventListener('click', () => {
      const cur = $('#mark-tags').value.split(',').map(s => s.trim()).filter(Boolean);
      cur.push(t);
      $('#mark-tags').value = cur.join(', ');
      renderTagSuggest();
    });
    box.appendChild(b);
  }
}

// в какие сборники входит эта пометка
function renderCollectionPicker() {
  const box = $('#mark-colls');
  box.innerHTML = '';
  if (!editingMark) return;
  for (const c of settings.collections || []) {
    const inIt = (c.items || []).some(it => it.book === editingMark.book && it.mark === editingMark.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (inIt ? ' on' : '');
    b.textContent = (inIt ? '✓ ' : '+ ') + c.name;
    b.addEventListener('click', () => {
      toggleInCollection(c.id, editingMark.book, editingMark.id);
      renderCollectionPicker();
    });
    box.appendChild(b);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-new';
  add.textContent = '+ новый сборник';
  add.addEventListener('click', () => {
    const name = prompt('Название сборника:');
    if (!name || !name.trim()) return;
    const c = createCollection(name.trim());
    toggleInCollection(c.id, editingMark.book, editingMark.id);
    renderCollectionPicker();
  });
  box.appendChild(add);
}

/* ===== сборники ===== */
function createCollection(name) {
  const c = { id: 'c' + Date.now().toString(36), name, note: '', tags: [], items: [], ts: Date.now() };
  (settings.collections || (settings.collections = [])).push(c);
  saveSettings();
  return c;
}
function toggleInCollection(cid, bid, mid) {
  const c = (settings.collections || []).find(x => x.id === cid);
  if (!c) return;
  c.items = c.items || [];
  const i = c.items.findIndex(it => it.book === bid && it.mark === mid);
  if (i >= 0) c.items.splice(i, 1);
  else c.items.push({ book: bid, mark: mid });
  saveSettings();
  renderClips();
}

/* ===== панель пометок в оглавлении ===== */
function buildMarkPanel() {
  const section = $('#bm-section');
  const ul = $('#bm-list');
  if (!section || !ul) return;
  ul.innerHTML = '';
  const list = getMarks().slice().sort((a, b) => a.chapter - b.chapter || String(a.sector).localeCompare(String(b.sector)));
  section.hidden = list.length === 0;
  $('#bm-count').textContent = list.length ? String(list.length) : '';
  for (const m of list) ul.appendChild(markRow(m, bookId, { compact: true }));
}

/* Одна строка пометки. Используется и в панели книги, и в списке вырезок —
   разметка одна, чтобы вид пометки не разъезжался между двумя местами. */
function markRow(m, bid, { compact = false } = {}) {
  const li = document.createElement('li');
  li.className = 'bm-item mark-item' + (isClip(m) ? ' is-clip c-' + (m.color || DEFAULT_COLOR) : ' is-bm');

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'bm-go';

  const meta = document.createElement('span');
  meta.className = 'bm-meta';
  meta.textContent = markPlace(bid, m, !compact);
  go.appendChild(meta);

  if (m.text) {
    const quote = document.createElement('span');
    quote.className = 'mark-quote';
    quote.textContent = compact ? m.text.slice(0, 160) : m.text;
    go.appendChild(quote);
  }
  if (m.note) {
    const note = document.createElement('span');
    note.className = 'bm-note';
    note.textContent = m.note;
    go.appendChild(note);
  }
  if ((m.tags || []).length) {
    const tags = document.createElement('span');
    tags.className = 'mark-tags';
    for (const t of m.tags) {
      const s = document.createElement('span');
      s.className = 'mark-tag';
      s.textContent = t;
      tags.appendChild(s);
    }
    go.appendChild(tags);
  }
  go.addEventListener('click', () => {
    if (bid === bookId) gotoSector(m.sector, m.chapter);
    else openBook(library.find(b => b.id === bid), { chapter: m.chapter, sector: m.sector });
  });
  li.appendChild(go);

  const actions = document.createElement('span');
  actions.className = 'bm-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.title = 'Заметка, цвет, теги, сборники';
  edit.textContent = '✎';
  edit.addEventListener('click', () => openMarkEditor(m.id, { bookOf: bid }));
  const share = document.createElement('button');
  share.type = 'button';
  share.title = 'Скопировать ссылку';
  share.textContent = '↗';
  share.addEventListener('click', () => shareSector(m.sector));
  const del = document.createElement('button');
  del.type = 'button';
  del.title = 'Удалить';
  del.textContent = '🗑';
  del.addEventListener('click', () => {
    if (bid === bookId) removeMark(m.id);
    else {
      const l = settings.marks[bid] || [];
      const i = l.findIndex(x => x.id === m.id);
      if (i >= 0) l.splice(i, 1);
      saveSettings();
    }
    renderClips();
    buildMarkPanel();
  });
  actions.append(edit, share, del);
  li.appendChild(actions);
  return li;
}

$('#btn-bookmark').addEventListener('click', toggleActiveBookmark);

/* ===== плавающая панель над выделением ===== */
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

/* Цветные кнопки панели выделения. mousedown/touchstart с preventDefault — иначе
   касание снимет выделение раньше, чем мы успеем его прочитать.

   ⚠️ Узла может не быть. Сборки нет, index.html и app.js — два отдельных файла, и
   браузер (или кеш) вполне может отдать их разных поколений: старая разметка + новый
   скрипт. Раньше это валило ВСЁ приложение — исключение на верхнем уровне обрывало
   выполнение файла, до init() дело не доходило, и вместо библиотеки был пустой экран.
   Поэтому привязки к необязательным узлам молча пропускаются: пропавшая кнопка —
   мелкая неприятность, пустая библиотека — поломка. */
function bindSelAction(el, fn) {
  if (!el) return;
  el.addEventListener('mousedown', e => { e.preventDefault(); fn(); });
  el.addEventListener('touchstart', e => { e.preventDefault(); fn(); }, { passive: false });
}
// то же и для обычных кнопок новых панелей
function bindClick(sel, fn) {
  const el = $(sel);
  if (el) el.addEventListener('click', fn);
}
(function buildSelPalette() {
  const pal = $('#sel-colors');
  if (!pal) return;
  for (const c of MARK_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch sw-' + c.id;
    b.title = 'Выделить: ' + c.name.toLowerCase();
    bindSelAction(b, () => addRangeMark(c.id, false));
    pal.appendChild(b);
  }
})();
bindSelAction($('#sel-note'), () => addRangeMark(DEFAULT_COLOR, true));

/* ===== машинный перевод выделенного =====
 * Показываем ТОЛЬКО карточкой поверх текста. В поток секторов машинный перевод
 * не попадает никогда: рядом стоит выверенный человеческий перевод, и на арабском
 * спутать их особенно дорого. Единственный мостик в книгу — кнопка «в заметку»,
 * которая кладёт текст в личную пометку пользователя, а не в текст книги.
 */
let mtPending = null;   // { text, from, to, result }

// куда переводим: второй язык книги, иначе русский
function mtTargetFor(from) {
  if (book && Array.isArray(book.languages)) {
    const other = book.languages.find(l => l !== from);
    if (other) return other;
  }
  return from === 'ru' ? 'en' : 'ru';
}

const mtProvider = () =>
  (mtAvailable().find(p => p.id === settings.mtProvider && p.ready) || {}).id
  || (mtAvailable().find(p => p.ready) || {}).id
  || 'mymemory';

/* ===== промпты перевода =====
 * Промпт — просьба ПОВЕРХ перевода: разобрать термины, дать примеры, объяснить
 * грамматику. Встроенные неизменяемы, свои живут в settings.mtPrompts (это не
 * секрет, поэтому им место именно в настройках и в резервной копии).
 *
 * `plain` особый: у него пустой текст, и тогда в системный промпт возвращается
 * строка «только перевод, без пояснений» (см. mtSystemPrompt в translate.js).
 */
const MT_PROMPTS_BUILTIN = [
  { id: 'plain', label: 'Точно', text: '' },
  {
    id: 'literal', label: 'Дословно',
    text: 'Дай два варианта, каждый со своей строки: сначала «Дословно:» — подстрочник, '
      + 'слово за словом, даже если звучит коряво; затем «Литературно:» — гладкий перевод.',
  },
  {
    id: 'explain', label: 'Подробно',
    text: 'После перевода добавь раздел «Разбор»: ключевые слова и термины, их корни '
      + 'и оттенки смысла, и почему выбран именно такой вариант перевода. Кратко, по пунктам.',
  },
  {
    id: 'examples', label: 'С примерами',
    text: 'После перевода добавь раздел «Примеры»: 2–3 других употребления ключевых слов '
      + 'и выражений этого фрагмента, каждое с переводом.',
  },
  {
    id: 'grammar', label: 'Грамматика',
    text: 'После перевода добавь раздел «Грамматика»: части речи, форма слова, падеж '
      + 'или огласовка окончания, синтаксическая роль. Только то, что есть во фрагменте.',
  },
];

const mtPromptAll = () => MT_PROMPTS_BUILTIN.concat(settings.mtPrompts || []);
const mtPromptById = id => mtPromptAll().find(p => p.id === id) || MT_PROMPTS_BUILTIN[0];
const mtPromptCur = () => mtPromptById(settings.mtPrompt || 'plain');

/* Чипсы выбора промпта. Живут в двух местах — в панели режима перевода (выбрать до
   запроса) и в карточке результата (переспросить иначе, не выделяя заново). */
function renderPromptChips(box, onPick) {
  if (!box) return;
  box.innerHTML = '';
  const curId = mtPromptCur().id;
  for (const p of mtPromptAll()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mt-prompt' + (p.id === curId ? ' on' : '');
    b.textContent = p.label;
    b.title = p.text || 'Просто перевод, без пояснений';
    b.addEventListener('click', () => {
      settings.mtPrompt = p.id;
      saveSettings();
      onPick(p);
    });
    box.appendChild(b);
  }
}

/* Промпт понимают только ИИ-движки: MyMemory — словарь, у него нет куда положить
   просьбу. Молча отдать словарный перевод на просьбу «разбери грамматику» — обман,
   поэтому переключаем движок сами, а если ИИ не настроен — говорим прямо. */
function mtProviderForPrompt(promptId, current) {
  if (promptId === 'plain' || current !== 'mymemory') return current;
  const ai = mtAvailable().find(p => p.ready && p.id !== 'mymemory');
  if (ai) return ai.id;
  toast('Промпты работают только с ИИ — задайте ключ в настройках');
  return current;
}

/* Карточка результата встаёт ПОД абзацем, а не всплывашкой поверх текста: так её
   видно вместе с тем, что переводишь, и она ничего не заслоняет. Узел один и тот же,
   он просто переезжает в поток и обратно.
   ⚠️ Под абзацем — но НЕ внутри пары: машинный перевод по-прежнему не попадает в
   поток секторов (см. шапку translate.js). Его отделяют плашка «⚡ машинный перевод»,
   своя рамка и то, что он исчезает при закрытии и при смене главы — рядом с
   выверенным человеческим переводом спутать их нельзя. */
function placeMtCard(pairEl) {
  const card = $('#mt-card');
  if (pairEl && pairEl.parentNode === stream) {
    card.classList.add('mt-inline');
    /* Встаём ПОСЛЕ развёрнутых сносок этого абзаца, а не между ним и ими:
       toggleInlineFn ищет свою сноску, шагая по соседям и останавливаясь на первом
       не-.fn-inline. Влезь карточка в середину — повторный тап по ссылке не нашёл бы
       раскрытую сноску и открыл бы вторую такую же. */
    let anchor = pairEl;
    while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('fn-inline')) {
      anchor = anchor.nextElementSibling;
    }
    anchor.insertAdjacentElement('afterend', card);
  } else {
    detachMtCard();   // абзац неизвестен (например, поиск) — прежнее поведение, поверх текста
  }
}

/* Вернуть карточку из потока в body. Обязательно ПЕРЕД перерисовкой главы:
   renderChapter чистит stream через innerHTML, и карточка вместе со всеми
   обработчиками была бы уничтожена — перевод перестал бы работать до перезагрузки. */
function detachMtCard() {
  const card = $('#mt-card');
  if (!card) return;
  card.classList.remove('mt-inline');
  if (card.parentNode !== document.body) document.body.appendChild(card);
}

function closeMt() {
  $('#mt-card').hidden = true;
  detachMtCard();
  if (mtModeOn()) $('#mtsel-bar').hidden = false;   // вернуть панель режима, если он ещё включён
}

/* Переводим СРАЗУ, без промежуточного меню выбора.
   Меню висело под панелью выделения — ровно там же, где браузер рисует своё
   «Копировать / Поиск / Поделиться», и системное перекрывало наше. Провайдер
   теперь переключается уже в карточке результата, а она прижата к низу экрана.
   Выделение снимаем первым делом: это и системное меню убирает. */
function startTranslate() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const member = el.closest('.member');
  if (!member) return;
  const from = member.getAttribute('lang') || (book && book.languages[0]) || 'en';
  mtPending = {
    text: sel.toString().trim(), from, to: mtTargetFor(from),
    pair: member.closest('.pair'), result: null,
  };
  runTranslate(mtProvider());
}

// переключатели провайдера внутри карточки
function renderMtProviders(active) {
  const box = $('#mt-providers');
  if (!box) return;
  box.innerHTML = '';
  for (const p of mtAvailable()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mt-prov' + (p.id === active ? ' on' : '') + (p.ready ? '' : ' off');
    b.textContent = p.label;
    b.title = p.ready ? p.note : p.note + ' — не настроен';
    b.disabled = !p.ready || p.id === active;
    b.addEventListener('click', () => runTranslate(p.id));
    box.appendChild(b);
  }
}

async function runTranslate(providerId) {
  if (!mtPending) return;
  const { text, from, to } = mtPending;
  const prompt = mtPromptCur();
  providerId = mtProviderForPrompt(prompt.id, providerId);
  settings.mtProvider = providerId;
  saveSettings();
  // карточка встаёт под абзацем — панель режима внизу ей больше не мешает и остаётся
  // на месте: можно сразу выделять следующий фрагмент
  placeMtCard(mtPending.pair);
  if (mtModeOn()) $('#mtsel-bar').hidden = !$('#mt-card').classList.contains('mt-inline');

  // снять выделение сразу — заодно закрывается системное меню браузера
  hideSelToolbar();
  const s = window.getSelection();
  if (s) s.removeAllRanges();

  const body = $('#mt-body');
  const label = () => `${langName(from)} → ${langName(to)}`
    + (prompt.id === 'plain' ? '' : ' · ' + prompt.label);
  $('#mt-source').textContent = label();
  body.textContent = 'Перевожу…';
  body.classList.remove('mt-error');
  renderMtProviders(providerId);
  // смена промпта прямо в карточке — переспросить тем же выделением, не выделяя заново
  renderPromptChips($('#mt-prompts'), () => runTranslate(providerId));
  $('#mt-card').hidden = false;

  try {
    const r = await mtTranslate(text, from, to, providerId, {
      model: settings.mtModel, extra: prompt.text, promptId: prompt.id,
    });
    body.textContent = r.text;
    $('#mt-source').textContent = label() + (r.cached ? ' · из кэша' : '');
    mtPending.result = r.text;
    // ответ бывает длинным и уезжает за нижний край — подтянуть, но только если правда нужно
    if ($('#mt-card').classList.contains('mt-inline')) {
      $('#mt-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } catch (err) {
    body.textContent = err.message;
    body.classList.add('mt-error');
    mtPending.result = null;
  }
  // провайдер мог погаснуть на неудаче (нет функции / нет ключа) — перерисуем
  renderMtProviders(providerId);
}

bindSelAction($('#sel-mt'), startTranslate);
bindClick('#mt-close', closeMt);
bindClick('#mt-copy', () => {
  const t = mtPending && mtPending.result;
  if (!t) return;
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Скопировано'), () => toast('Не удалось'));
});
/* Единственный путь машинного перевода внутрь книги — личная пометка, и она
   честно подписана как машинная: своя мысль и машинный черновик не должны
   выглядеть одинаково, когда через полгода перечитываешь вырезки. */
bindClick('#mt-to-note', () => {
  const t = mtPending && mtPending.result;
  if (!t || !book) return;
  const list = markList();
  list.push({
    id: newMarkId(), chapter: chapterIndex, sector: activeEl ? activeEl.dataset.id : 's001',
    lang: mtPending.from, start: null, end: null, color: null,
    note: `[машинный перевод${mtPromptCur().id === 'plain' ? '' : ' · ' + mtPromptCur().label}] ` + t,
    tags: ['машинный перевод'],
    text: mtPending.text, page: currentPage(), ts: Date.now(), edited: 0,
  });
  saveSettings();
  applyMarks();
  buildMarkPanel();
  closeMt();
  toast('Сохранено в пометки');
});

/* ===== РЕЖИМ ПЕРЕВОДА: выделение без системного меню =====
 * Обычное выделение текста на телефоне бесполезно для перевода: браузер сам рисует
 * над ним «Копировать / Поиск / Поделиться», и это меню перекрывает нашу панель —
 * до кнопки перевода просто не дотянуться. Спорить с системным меню нельзя, его
 * не подвинуть и не убрать.
 *
 * Поэтому здесь системного выделения НЕТ ВОВСЕ: в режиме перевода текст получает
 * `user-select: none`, браузеру нечего показывать — и меню не появляется. Выделение
 * своё: тап по слову берёт слово, тап по второму слову растягивает до фразы, кнопка
 * берёт абзац целиком. Панель прижата к низу экрана, далеко от пальца и от текста.
 *
 * ⚠️ Не «чинить» это возвращением обычного выделения — оно и было причиной.
 */
const mtSel = { member: null, start: 0, end: 0, anchor: null, lastMember: null, lastTap: 0 };

const mtModeOn = () => document.body.dataset.mtmode === '1';

/* Символьное смещение точки экрана внутри члена пары. Смещения считаем по
   textContent — та же система координат, что у пометок и поиска. */
function caretOffset(member, x, y) {
  let node = null, off = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer; off = r.startOffset;
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode; off = p.offset;
  } else return null;
  if (!node || !member.contains(node)) return null;
  if (node.nodeType !== 3) return null;
  const walker = document.createTreeWalker(member, NodeFilter.SHOW_TEXT);
  let pos = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return pos + off;
    pos += n.nodeValue.length;
  }
  return null;
}

/* Границы слова вокруг позиции. Intl.Segmenter знает про арабскую вязь и огласовки
   куда лучше любой регулярки; запасной путь — на случай старых движков. Если палец
   попал в пробел или знак препинания, берём ближайшее слово, а не пустоту: иначе
   аккуратный тап по короткому слову часто не давал бы ничего. */
function wordAt(text, pos) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segs = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)]
      .filter(s => s.isWordLike);
    if (!segs.length) return null;
    let best = null, bestDist = Infinity;
    for (const s of segs) {
      const start = s.index, end = s.index + s.segment.length;
      if (pos >= start && pos < end) return { start, end };
      const d = pos < start ? start - pos : pos - end;
      if (d < bestDist) { bestDist = d; best = { start, end }; }
    }
    return bestDist <= 2 ? best : null;   // далеко от слов — считаем, что промах
  }
  const re = /[\p{L}\p{M}\p{N}_'’ـ-]+/gu;
  let m, best = null, bestDist = Infinity;
  while ((m = re.exec(text))) {
    const start = m.index, end = start + m[0].length;
    if (pos >= start && pos < end) return { start, end };
    const d = pos < start ? start - pos : pos - end;
    if (d < bestDist) { bestDist = d; best = { start, end }; }
  }
  return bestDist <= 2 ? best : null;
}

/* Подкраска диапазона по кускам текстовых узлов. Отдельно от highlightRange:
   тот зовёт surroundContents на весь диапазон и молча ничего не красит, стоит
   фразе пересечь <b> или ссылку на сноску — а невидимое выделение хуже, чем
   никакого. Здесь каждый кусок оборачивается в своём узле, так что пересечения
   разметки не мешают. */
function paintParts(root, start, end, cls, data) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const jobs = [];
  let pos = 0, n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    const s = Math.max(start, pos), e = Math.min(end, pos + len);
    if (e > s) jobs.push({ node: n, s: s - pos, e: e - pos });
    pos += len;
    if (pos >= end) break;
  }
  let painted = 0;
  for (const j of jobs) {
    try {
      const r = document.createRange();
      r.setStart(j.node, j.s);
      r.setEnd(j.node, j.e);
      const mark = document.createElement('mark');
      mark.className = cls;
      if (data) Object.assign(mark.dataset, data);
      r.surroundContents(mark);
      painted++;
    } catch { /* кусок не обернулся — остальные всё равно покрасим */ }
  }
  return painted;
}

function paintMtSel() {
  stream.querySelectorAll('mark.mtsel').forEach(unwrap);
  if (!mtSel.member || mtSel.end <= mtSel.start) return;
  paintParts(mtSel.member, mtSel.start, mtSel.end, 'mtsel');
}

function mtSelText() {
  if (!mtSel.member || mtSel.end <= mtSel.start) return '';
  return mtSel.member.textContent.slice(mtSel.start, mtSel.end).replace(/\s+/g, ' ').trim();
}

function clearMtSel() {
  mtSel.member = null; mtSel.anchor = null; mtSel.start = 0; mtSel.end = 0;
  paintMtSel();
  updateMtSelBar();
}

function updateMtSelBar() {
  const prev = $('#mtsel-preview');
  if (!prev) return;
  const txt = mtSelText();
  prev.textContent = txt ? (txt.length > 100 ? txt.slice(0, 100) + '…' : txt)
    : 'Тап по слову — выделить. Тап по второму — вся фраза между ними.';
  prev.classList.toggle('mtsel-empty', !txt);
  $('#mtsel-go').disabled = !txt;
  $('#mtsel-clear').disabled = !txt;
}

/* Тап в режиме перевода. Capture + stopPropagation: ниже по дереву висит обычный
   обработчик чтения (раскрыть второй язык, открыть пометку), и в этом режиме он
   только мешал бы. */
stream.addEventListener('click', e => {
  if (!mtModeOn()) return;
  const member = e.target.closest && e.target.closest('.member');
  if (!member || !stream.contains(member)) return;
  e.preventDefault();
  e.stopPropagation();
  /* Двойной тап по тому же абзацу — весь абзац целиком. Кнопка «Весь абзац» в панели
     есть, но тянуться к ней ради самого частого действия неудобно. */
  const now = Date.now();
  if (mtSel.lastMember === member && now - (mtSel.lastTap || 0) < 400) {
    mtSel.lastTap = 0;
    mtSel.anchor = null;
    mtSel.start = 0;
    mtSel.end = member.textContent.length;
    paintMtSel();
    updateMtSelBar();
    return;
  }
  mtSel.lastMember = member;
  mtSel.lastTap = now;

  const off = caretOffset(member, e.clientX, e.clientY);
  if (off === null) return;
  const w = wordAt(member.textContent, off);
  if (!w) return;
  if (mtSel.member === member && mtSel.anchor) {
    // второй тап — растянуть от слова-якоря до этого слова (в любую сторону)
    mtSel.start = Math.min(mtSel.anchor.start, w.start);
    mtSel.end = Math.max(mtSel.anchor.end, w.end);
  } else {
    mtSel.member = member;
    mtSel.anchor = w;
    mtSel.start = w.start;
    mtSel.end = w.end;
  }
  paintMtSel();
  updateMtSelBar();
}, true);

// перерисовка нужна ради подсветки выбранного: сам выбор уже сохранён в settings
function refreshMtselPrompts() { renderPromptChips($('#mtsel-prompts'), refreshMtselPrompts); }

/* Пояс и подтяжки к `user-select: none`. В большинстве браузеров хватает и одного
   CSS, но в части webview (и в Firefox на Android) долгий тап всё равно запускает
   выделение и системное меню поверх нашей панели. Отменяем оба события в зародыше —
   и только в режиме перевода, чтобы обычное чтение с копированием не сломать. */
['selectstart', 'contextmenu'].forEach(ev => {
  stream.addEventListener(ev, e => { if (mtModeOn()) e.preventDefault(); });
});

function setMtMode(on) {
  if (on && !book) { toast('Сначала откройте книгу'); return; }
  if (on) document.body.dataset.mtmode = '1';
  else delete document.body.dataset.mtmode;
  $('#btn-mtmode').classList.toggle('on', on);
  $('#mtsel-bar').hidden = !on;
  clearMtSel();
  if (on) {
    hideSelToolbar();
    const s = window.getSelection();
    if (s) s.removeAllRanges();
    refreshMtselPrompts();
    toast('Тап по слову. Второй тап — до конца фразы');
  } else {
    closeMt();
  }
}

bindClick('#btn-mtmode', () => setMtMode(!mtModeOn()));
bindClick('#mtsel-off', () => setMtMode(false));
bindClick('#mtsel-clear', clearMtSel);
bindClick('#mtsel-all', () => {
  // абзац целиком: либо тот, где уже выделяли, либо текущий по прокрутке
  const member = mtSel.member || (activeEl && activeEl.querySelector('.member'));
  if (!member) { toast('Сначала тапните по абзацу'); return; }
  mtSel.member = member;
  mtSel.anchor = null;
  mtSel.start = 0;
  mtSel.end = member.textContent.length;
  paintMtSel();
  updateMtSelBar();
});
bindClick('#mtsel-go', () => {
  const text = mtSelText();
  if (!text) return;
  const from = mtSel.member.getAttribute('lang') || (book && book.languages[0]) || 'en';
  mtPending = {
    text, from, to: mtTargetFor(from),
    pair: mtSel.member.closest('.pair'), result: null,
  };
  runTranslate(mtProvider());
});

/* ===== ПОДСТРОЧНИК: перевод под словом =====
 * Механика — в gloss.js, формат — SPEC 3.4c. Глоссы приходят ВМЕСТЕ С КНИГОЙ
 * (`<книга>/gloss/<язык>/<глава>.md`), а не из встроенного словаря: словарь давал
 * перевод леммы, слепой к предложению, и на омонимах врал (см. шапку gloss.js).
 * Здесь только то, что знает про приложение: кнопка, настройки и наложение на
 * текущую главу.
 */

// языки книги, у которых есть слой подстрочника (book.json → "gloss": ["en"])
function glossLangs() {
  if (!book || !Array.isArray(book.gloss)) return [];
  return book.gloss.filter(l => book.languages.includes(l));
}

const glossKey = (lang, file) => `${bookId}/${lang}/${file}`;
const chapterFile = () => (book && book.chapters[chapterIndex] && book.chapters[chapterIndex].file) || '';

/* Подстрочник текущей главы. Грузится фоном: глава не должна его ждать, а когда
   файл приедет, подписи лягут на уже отрисованный текст. */
async function ensureGlossChapter() {
  const file = chapterFile();
  const langs = glossLangs();
  if (!file || !langs.length) { updateGlossBtn(); return; }
  await Promise.all(langs.map(l =>
    glLoadChapter(glossKey(l, file), `${base}gloss/${l}/${file}`, fetchBookText)));
  if (settings.gloss.on) applyGloss();
  updateGlossBtn();
  setupGlossSettings();
}

// подписи есть, если хоть у одного языка главы разобрался непустой файл
function glossReady() {
  const file = chapterFile();
  return glossLangs().some(l => {
    const m = glChapter(glossKey(l, file));
    return m && m.size > 0;
  });
}

function updateGlossBtn() {
  const btn = $('#btn-gloss');
  if (!btn) return;
  btn.hidden = !glossLangs().length;
  btn.classList.toggle('on', !!settings.gloss.on);
}

// кегль и приглушённость — чистый CSS, перекладывать текст ради них незачем
function applyGlossStyle() {
  document.body.style.setProperty('--gl-size', settings.gloss.size + 'em');
  document.body.style.setProperty('--gl-dim', String(settings.gloss.dim));
}

function applyGloss() {
  const g = settings.gloss;
  document.body.toggleAttribute('data-gloss', !!g.on);
  // отметка «здесь подписи скрыты, а не отсутствуют» — нужна только когда отбор включён
  document.body.toggleAttribute('data-gloss-ok', !!(g.on && g.onlyVerified));
  applyGlossStyle();
  stream.querySelectorAll('.member').forEach(m => glClear(m));
  if (g.on && book) {
    const file = chapterFile();
    for (const lang of glossLangs()) {
      const sectors = glChapter(glossKey(lang, file));
      if (!sectors) continue;
      for (const el of stream.querySelectorAll('.pair')) {
        const sec = sectors.get(el.dataset.id);
        if (!sec) continue;
        /* Выверенность — на секторе. «Только выверенное» просто не рисует
           неподтверждённое: для тафсира гарантию даёт это, а не оформление.
           Пунктиром тут не обойтись — пока не выверено ничего, пунктир под каждой
           подписью это пунктир на всей странице, то есть шум. */
        el.classList.toggle('gl-unverified', !sec.verified);
        if (g.onlyVerified && !sec.verified) continue;
        const mem = el.querySelector('.member.lang-' + lang);
        if (mem) glApplyEntries(mem, sec.entries, { showFunction: g.func });
      }
    }
  }
  closeGlossPop();
  updateGlossBtn();
}

function setGlossMode(on) {
  if (on && !glossLangs().length) {
    toast(book ? 'У этой книги нет слоя подстрочника' : 'Сначала откройте книгу');
    return;
  }
  settings.gloss.on = !!on;
  saveSettings();
  applyGloss();
  setupGlossSettings();
  if (on && !glossReady()) toast('У этой главы подписи ещё не подготовлены');
}

bindClick('#btn-gloss', () => setGlossMode(!settings.gloss.on));

/* Тап по подписанному слову: показать перевод целиком. В строке длинная глосса
   срезается многоточием, и без этого её было бы не прочитать вовсе. */
let glPop = null;

function openGlossPop(span) {
  const pop = $('#gl-pop');
  glPop = { n: span.dataset.n };
  $('#gl-pop-word').textContent = span.textContent;
  $('#gl-pop-gloss').textContent = span.dataset.g;
  pop.hidden = false;
  // измерять можно только показанным: у скрытого нет ни ширины, ни высоты
  const r = span.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 8 + h < window.innerHeight;
  pop.style.left = (left + window.scrollX) + 'px';
  pop.style.top = ((below ? r.bottom + 8 : Math.max(8, r.top - h - 8)) + window.scrollY) + 'px';
}

function closeGlossPop() {
  const pop = $('#gl-pop');
  if (pop) pop.hidden = true;
  glPop = null;
}

bindClick('#gl-pop-close', closeGlossPop);
document.addEventListener('click', e => {
  if (glPop && !e.target.closest('#gl-pop') && !e.target.closest('span.gl')) closeGlossPop();
});

/* ── настройки подстрочника ──────────────────────────────────────────────── */

function setupGlossSettings() {
  const wrap = $('#set-gloss');
  if (!wrap) return;
  wrap.innerHTML = '';

  const group = document.createElement('div');
  group.className = 'font-group';
  const head = document.createElement('div');
  head.className = 'font-lang';
  head.textContent = 'Подстрочник';
  group.appendChild(head);

  const langs = glossLangs();
  if (!book || !langs.length) {
    const hint = document.createElement('p');
    hint.className = 'set-hint';
    hint.textContent = book
      ? 'У этой книги нет слоя подстрочника: подписи поставляются вместе с книгой.'
      : 'Откройте книгу — подстрочник зависит от её содержимого.';
    group.appendChild(hint);
    wrap.appendChild(group);
    return;
  }

  const on = document.createElement('label');
  on.className = 'row';
  on.append('Показывать перевод под словом');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!settings.gloss.on;
  cb.addEventListener('change', () => setGlossMode(cb.checked));
  on.appendChild(cb);
  group.appendChild(on);

  const func = document.createElement('label');
  func.className = 'row';
  func.append('Подписывать служебные слова');
  const fcb = document.createElement('input');
  fcb.type = 'checkbox';
  fcb.checked = !!settings.gloss.func;
  fcb.addEventListener('change', () => {
    settings.gloss.func = fcb.checked;
    saveSettings();
    applyGloss();
  });
  func.appendChild(fcb);
  group.appendChild(func);

  const ver = document.createElement('label');
  ver.className = 'row';
  ver.append('Только выверенное человеком');
  const vcb = document.createElement('input');
  vcb.type = 'checkbox';
  vcb.checked = !!settings.gloss.onlyVerified;
  vcb.addEventListener('change', () => {
    settings.gloss.onlyVerified = vcb.checked;
    saveSettings();
    applyGloss();
    setupGlossSettings();
  });
  ver.appendChild(vcb);
  group.appendChild(ver);

  group.appendChild(makeSlider('Кегль перевода', settings.gloss.size, 0.45, 0.9, 0.01,
    v => Math.round(v * 100) + '%',
    v => { settings.gloss.size = v; applyGlossStyle(); }));
  group.appendChild(makeSlider('Приглушённость', settings.gloss.dim, 0.25, 1, 0.05,
    v => Math.round(v * 100) + '%',
    v => { settings.gloss.dim = v; applyGlossStyle(); }));

  const info = document.createElement('p');
  info.className = 'set-hint';
  const file = chapterFile();
  const counts = langs.map(l => {
    const m = glChapter(glossKey(l, file));
    if (!m) return `${langName(l)}: нет`;
    let ok = 0;
    for (const sec of m.values()) if (sec.verified) ok++;
    return `${langName(l)}: ${m.size} секторов, выверено ${ok}`;
  });
  info.textContent = glossReady()
    ? `В этой главе — ${counts.join('; ')}.`
    : 'В этой главе подписей пока нет — подготовьте их генератором (tools/gloss-book.js).';
  group.appendChild(info);

  wrap.appendChild(group);
}

/* ===== настройка перевода через ИИ (ключ OpenRouter + модель) =====
 * Ключ читателя, а не библиотеки: живёт в localStorage этого браузера, в экспорт
 * настроек не попадает (см. translate.js). Модель выбирается из ЖИВОГО каталога
 * OpenRouter — захардкоженный список моделей протухает к следующему их релизу.
 */
let mtModelCache = null;   // список моделей за сессию: каталог большой, тянуть его на каждое открытие незачем

/* Список желаемых моделей — ИМЕННО перечислением, а не регуляркой по имени:
   регулярка «любой anthropic/claude-opus» в алфавитном каталоге выберет
   claude-opus-4 ($15/$75 за миллион) вместо свежего и втрое более дешёвого.
   Список сверяется с живым каталогом: чего в нём нет — то и не предлагаем,
   так что устаревшая строка отсюда молча пропускается, а не ломает выбор. */
const MT_MODEL_PREF = [
  'anthropic/claude-sonnet-5',      // рабочая лошадка: качество почти опусное, цена вчетверо ниже
  'anthropic/claude-opus-5',        // когда важнее точность, чем цена
  'google/gemini-3.1-pro-preview',
  'anthropic/claude-haiku-4.5',     // быстро и дёшево
  'google/gemini-3.6-flash',
  'deepseek/deepseek-v3.2',         // самый дешёвый из вменяемых
];

function mtKeyStateText() {
  const k = orKey();
  return k
    ? `Ключ сохранён (…${k.slice(-6)}). Перевод через ИИ доступен на этом устройстве.`
    : 'Ключ не задан — в карточке перевода доступен только бесплатный движок.';
}

function renderMtKeyState() {
  $('#mt-key-state').textContent = mtKeyStateText();
  $('#mt-key').value = '';
  $('#mt-key').placeholder = orKey() ? 'ключ сохранён — вставьте новый, чтобы заменить' : 'sk-or-v1-…';
}

function mtModelLabel(m) {
  const price = m.outM ? ` · $${m.inM}/$${m.outM} за 1M` : ' · бесплатно';
  return m.name + price;
}

function renderMtModelState() {
  const cur = settings.mtModel;
  const box = $('#mt-model-state');
  if (!cur) { box.textContent = 'Модель не выбрана — перевод через ИИ не запустится.'; return; }
  const known = mtModelCache && mtModelCache.find(m => m.id === cur);
  box.textContent = known
    ? `Переводит: ${mtModelLabel(known)}`
    : `Переводит: ${cur}` + (mtModelCache ? ' — такой модели нет в каталоге OpenRouter, проверьте написание' : '');
}

function setMtModel(id) {
  settings.mtModel = id.trim();
  saveSettings();
  $('#mt-model').value = settings.mtModel;
  renderMtModelState();
}

/* Быстрый выбор строится из того же каталога: несколько знакомых имён, чтобы не
   печатать id руками, но без вида «вот эти модели одобрены» — список открыт. */
function renderMtQuick() {
  const box = $('#mt-model-quick');
  box.innerHTML = '';
  if (!mtModelCache) return;
  const picked = MT_MODEL_PREF.map(id => mtModelCache.find(x => x.id === id)).filter(Boolean);
  for (const m of picked) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (m.id === settings.mtModel ? ' on' : '');
    b.textContent = m.name;
    b.title = m.id + (m.outM ? ` — $${m.inM}/$${m.outM} за 1M токенов` : '');
    b.addEventListener('click', () => { setMtModel(m.id); renderMtQuick(); });
    box.appendChild(b);
  }
}

async function loadMtModels(force) {
  if (mtModelCache && !force) { renderMtQuick(); renderMtModelState(); return; }
  const state = $('#mt-model-state');
  state.textContent = 'Загружаю список моделей…';
  try {
    mtModelCache = await mtModels();
  } catch (err) {
    state.textContent = 'Список моделей не загрузился (' + err.message + '). Id модели можно вписать вручную.';
    return;
  }
  const dl = $('#mt-model-list');
  dl.innerHTML = '';
  for (const m of mtModelCache) {
    const o = document.createElement('option');
    o.value = m.id;
    o.label = mtModelLabel(m);
    dl.appendChild(o);
  }
  // первый заход: подставить разумную модель, чтобы не заставлять выбирать вслепую
  if (!settings.mtModel) {
    const first = MT_MODEL_PREF.find(id => mtModelCache.some(x => x.id === id));
    if (first) { settings.mtModel = first; saveSettings(); }
  }
  $('#mt-model').value = settings.mtModel;
  renderMtQuick();
  renderMtModelState();
}

/* Свои промпты: встроенные показываем только для справки (их текст полезно
   подсмотреть, сочиняя свой), редактируются и удаляются лишь пользовательские. */
function renderMtPromptList() {
  const list = $('#mt-prompt-list');
  if (!list) return;
  list.innerHTML = '';
  for (const p of mtPromptAll()) {
    const own = (settings.mtPrompts || []).some(x => x.id === p.id);
    const li = document.createElement('li');
    li.className = 'mt-prompt-item' + (own ? '' : ' built-in');
    const head = document.createElement('div');
    head.className = 'mt-prompt-name';
    head.textContent = p.label + (own ? '' : ' · встроенный');
    const body = document.createElement('div');
    body.className = 'mt-prompt-text';
    body.textContent = p.text || 'Просто перевод, без пояснений.';
    li.append(head, body);
    if (own) {
      const actions = document.createElement('div');
      actions.className = 'mt-prompt-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '✎ Править';
      edit.addEventListener('click', () => {
        $('#mt-prompt-name').value = p.label;
        $('#mt-prompt-text').value = p.text;
        $('#mt-prompt-form').dataset.editing = p.id;
        $('#mt-prompt-name').focus();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '🗑 Удалить';
      del.addEventListener('click', () => {
        settings.mtPrompts = (settings.mtPrompts || []).filter(x => x.id !== p.id);
        // выбранным был именно он — вернуться к обычному переводу, а не к пустоте
        if (settings.mtPrompt === p.id) settings.mtPrompt = 'plain';
        saveSettings();
        renderMtPromptList();
        refreshMtselPrompts();
      });
      actions.append(edit, del);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }
}

if ($('#mt-prompt-form')) {
  $('#mt-prompt-form').addEventListener('submit', e => {
    e.preventDefault();
    const label = $('#mt-prompt-name').value.trim();
    const text = $('#mt-prompt-text').value.trim();
    if (!label || !text) { toast('Нужны и название, и текст промпта'); return; }
    const editing = $('#mt-prompt-form').dataset.editing;
    settings.mtPrompts = settings.mtPrompts || [];
    if (editing) {
      const p = settings.mtPrompts.find(x => x.id === editing);
      if (p) { p.label = label; p.text = text; }
      delete $('#mt-prompt-form').dataset.editing;
    } else {
      settings.mtPrompts.push({ id: 'u' + Date.now().toString(36), label, text });
    }
    saveSettings();
    $('#mt-prompt-name').value = '';
    $('#mt-prompt-text').value = '';
    renderMtPromptList();
    refreshMtselPrompts();
    toast('Промпт сохранён');
  });
}

function openMtSetup() {
  $('#settings').hidden = true;
  renderMtKeyState();
  $('#mt-model').value = settings.mtModel;
  renderMtPromptList();
  openOverlay($('#mtset'));
  loadMtModels(false);
}

bindClick('#btn-mtset', openMtSetup);
bindClick('#mt-key-save', () => {
  const v = $('#mt-key').value.trim();
  if (!v) { toast('Поле пустое'); return; }
  orKeySet(v);
  renderMtKeyState();
  toast('Ключ сохранён');
});
bindClick('#mt-key-clear', () => {
  orKeySet('');
  renderMtKeyState();
  toast('Ключ удалён');
});
bindClick('#mt-model-reload', () => loadMtModels(true));
if ($('#mt-model')) {
  $('#mt-model').addEventListener('change', e => { setMtModel(e.target.value); renderMtQuick(); });
}

/* ===== ВЫРЕЗКИ: сквозной свод пометок по всем книгам =====
 * Полка отвечает на вопрос «что почитать», вырезки — на вопрос «что я об этом думал».
 * Поэтому это отдельный раздел, а не вкладка внутри книги: мысль по теме почти всегда
 * собирается из разных книг, и держать её запертой в одной — значит не дать её собрать.
 * Ничего своего этот раздел не хранит: он рисует те же объекты пометок, что и книга.
 */
const clipsUI = { tab: 'all', book: '', tag: '', color: '', q: '', coll: null };

function openClips() {
  $('#settings').hidden = true;
  clipsUI.coll = null;
  clipsUI.tab = 'all';
  // показать ПЕРЕД отрисовкой: renderClips ничего не делает, пока панель скрыта
  // (эта же проверка бережёт от лишней работы при правке пометки из книги)
  openOverlay($('#clips'));
  renderClips();
}

function clipMatches(bid, m) {
  if (clipsUI.book && bid !== clipsUI.book) return false;
  if (clipsUI.tag && !(m.tags || []).includes(clipsUI.tag)) return false;
  if (clipsUI.color && (m.color || '') !== clipsUI.color) return false;
  if (clipsUI.q) {
    const q = clipsUI.q.toLowerCase();
    if (!((m.text || '') + ' ' + (m.note || '')).toLowerCase().includes(q)) return false;
  }
  return true;
}

function renderClips() {
  const box = $('#clips-body');
  if (!box || $('#clips').hidden) return;
  box.innerHTML = '';
  $('#clips-tab-all').classList.toggle('on', clipsUI.tab === 'all');
  $('#clips-tab-colls').classList.toggle('on', clipsUI.tab === 'colls');
  $('#clips-filters').hidden = clipsUI.tab !== 'all';

  if (clipsUI.tab === 'colls') return renderCollectionsList(box);
  renderClipFilters();

  const rows = allMarks()
    .filter(x => clipMatches(x.book, x.mark))
    .sort((a, b) => (b.mark.ts || 0) - (a.mark.ts || 0));

  $('#clips-count').textContent = rows.length
    ? `${rows.length} ${plural(rows.length, 'пометка', 'пометки', 'пометок')}`
    : '';

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'clips-empty';
    p.textContent = allMarks().length
      ? 'Под фильтр ничего не попало.'
      : 'Пока пусто. Выделите фрагмент в книге — и он появится здесь.';
    box.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'clip-list';
  for (const { book: bid, mark } of rows) ul.appendChild(markRow(mark, bid));
  box.appendChild(ul);
}

// строка фильтров: книга, тег, цвет. Показываем только реально встречающиеся значения
function renderClipFilters() {
  const box = $('#clips-filters');
  box.innerHTML = '';

  const bookIds = [...new Set(allMarks().map(x => x.book))];
  box.appendChild(selectFilter('Книга', bookIds.map(id => [id, bookTitleById(id)]), clipsUI.book, v => { clipsUI.book = v; renderClips(); }));
  const tags = allTags();
  if (tags.length) box.appendChild(selectFilter('Тег', tags.map(t => [t, t]), clipsUI.tag, v => { clipsUI.tag = v; renderClips(); }));
  const colors = [...new Set(allMarks().map(x => x.mark.color).filter(Boolean))];
  if (colors.length) {
    const names = new Map(MARK_COLORS.map(c => [c.id, c.name]));
    box.appendChild(selectFilter('Цвет', colors.map(c => [c, names.get(c) || c]), clipsUI.color, v => { clipsUI.color = v; renderClips(); }));
  }
  if (clipsUI.book || clipsUI.tag || clipsUI.color || clipsUI.q) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'chip';
    reset.textContent = '✕ сбросить';
    reset.addEventListener('click', () => {
      clipsUI.book = clipsUI.tag = clipsUI.color = clipsUI.q = '';
      $('#clips-q').value = '';
      renderClips();
    });
    box.appendChild(reset);
  }
}

function selectFilter(label, pairs, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'clip-filter';
  wrap.append(label);
  const sel = document.createElement('select');
  const any = document.createElement('option');
  any.value = ''; any.textContent = 'все';
  sel.appendChild(any);
  for (const [v, t] of pairs) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if (v === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  wrap.appendChild(sel);
  return wrap;
}

/* ===== сборники: список и просмотр ===== */
function renderCollectionsList(box) {
  const colls = settings.collections || [];
  $('#clips-count').textContent = colls.length
    ? `${colls.length} ${plural(colls.length, 'сборник', 'сборника', 'сборников')}`
    : '';

  if (clipsUI.coll) {
    const c = colls.find(x => x.id === clipsUI.coll);
    if (!c) { clipsUI.coll = null; return renderCollectionsList(box); }
    return renderOneCollection(box, c);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'primary coll-new';
  add.textContent = '+ Новый сборник';
  add.addEventListener('click', () => {
    const name = prompt('Название сборника:');
    if (name && name.trim()) { createCollection(name.trim()); renderClips(); }
  });
  box.appendChild(add);

  if (!colls.length) {
    const p = document.createElement('p');
    p.className = 'clips-empty';
    p.textContent = 'Сборник — это подборка вырезок по теме, собранная из разных книг.';
    box.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'coll-list';
  for (const c of colls) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'coll-open';
    const n = document.createElement('b');
    n.textContent = c.name;
    const cnt = document.createElement('span');
    cnt.className = 'coll-count';
    cnt.textContent = `${(c.items || []).length}`;
    b.append(n, cnt);
    b.addEventListener('click', () => { clipsUI.coll = c.id; renderClips(); });
    li.appendChild(b);
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

function renderOneCollection(box, c) {
  const head = document.createElement('div');
  head.className = 'coll-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'chip';
  back.textContent = '‹ все сборники';
  back.addEventListener('click', () => { clipsUI.coll = null; renderClips(); });
  const title = document.createElement('h3');
  title.textContent = c.name;
  head.append(back, title);

  const tools = document.createElement('div');
  tools.className = 'coll-tools';
  const rename = document.createElement('button');
  rename.type = 'button'; rename.className = 'chip'; rename.textContent = '✎ переименовать';
  rename.addEventListener('click', () => {
    const n = prompt('Название сборника:', c.name);
    if (n && n.trim()) { c.name = n.trim(); saveSettings(); renderClips(); }
  });
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'chip'; copy.textContent = '⧉ скопировать как текст';
  copy.addEventListener('click', () => copyCollection(c));
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'chip'; del.textContent = '🗑 удалить сборник';
  del.addEventListener('click', () => {
    if (!confirm(`Удалить сборник «${c.name}»? Сами вырезки останутся.`)) return;
    settings.collections = (settings.collections || []).filter(x => x.id !== c.id);
    saveSettings();
    clipsUI.coll = null;
    renderClips();
  });
  tools.append(rename, copy, del);
  head.appendChild(tools);
  box.appendChild(head);

  const items = (c.items || [])
    .map(it => ({ book: it.book, mark: findMark(it.mark, it.book) }))
    .filter(x => x.mark);   // пометку могли удалить — мёртвые ссылки просто не рисуем
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'clips-empty';
    p.textContent = 'Пусто. Откройте вырезку (✎) и добавьте её в этот сборник.';
    box.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'clip-list';
  for (const { book: bid, mark } of items) ul.appendChild(markRow(mark, bid));
  box.appendChild(ul);
}

/* Сборник → markdown в буфер обмена: подборка нужна не только внутри библиотеки,
   а и в заметках, в статье, в разговоре. Формат тот же, что понимает Вычитка. */
function copyCollection(c) {
  const lines = ['# ' + c.name, ''];
  for (const it of c.items || []) {
    const m = findMark(it.mark, it.book);
    if (!m) continue;
    lines.push('> ' + (m.text || '(фрагмент не сохранён)'));
    lines.push('');
    lines.push('— *' + bookTitleById(it.book) + '*' + (m.page != null ? ', стр. ' + m.page : ''));
    if (m.note) lines.push('', m.note);
    if ((m.tags || []).length) lines.push('', m.tags.map(t => '#' + t.replace(/\s+/g, '-')).join(' '));
    lines.push('', '---', '');
  }
  const text = lines.join('\n');
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Сборник скопирован'), () => toast('Не удалось скопировать'));
  else toast('Буфер обмена недоступен');
}

bindClick('#clips-tab-all', () => { clipsUI.tab = 'all'; clipsUI.coll = null; renderClips(); });
bindClick('#clips-tab-colls', () => { clipsUI.tab = 'colls'; renderClips(); });
if ($('#clips-q')) $('#clips-q').addEventListener('input', e => { clipsUI.q = e.target.value.trim(); renderClips(); });
bindClick('#btn-clips', openClips);
bindClick('#mark-save', saveMarkEditor);
bindClick('#mark-delete', () => {
  if (!editingMark) return;
  const { book: bid, id } = editingMark;
  if (bid === bookId) removeMark(id);
  else {
    const l = settings.marks[bid] || [];
    const i = l.findIndex(x => x.id === id);
    if (i >= 0) l.splice(i, 1);
    saveSettings();
  }
  $('#mark-editor').hidden = true;
  consumeOverlayMark();
  renderClips();
  buildMarkPanel();
});
if ($('#mark-tags')) $('#mark-tags').addEventListener('input', renderTagSuggest);

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

/* ===== скан страницы / иллюстрация ===== */
// один полноэкранный просмотр на оба случая: скан целой страницы и картинка в тексте
// (тап по фигуре). Заодно бесплатно достаются Esc и системная «назад» — они уже
// навешены на #img-overlay через openOverlay.
function showImage(src) {
  const img = $('#img-scan');
  img.src = src;
  img.classList.remove('zoom');
  openOverlay($('#img-overlay'));
}

function openScan() {
  const p = currentPage();
  if (p == null || !book.hasImages) return;
  showImage(base + book.imagePattern.replace('{page}', p));
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
      buildMarkPanel();
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
    ['Закладок', `${allMarks().filter(x => !isClip(x.mark)).length}`],
    ['Вырезок', `${allMarks().filter(x => isClip(x.mark)).length}`],
    ['С заметкой', `${allMarks().filter(x => x.mark.note).length}`],
    ['Сборников', `${(settings.collections || []).length}`],
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
if ($('#toc-filter')) {
  let tocTimer = null;
  $('#toc-filter').addEventListener('input', e => {
    tocQuery = e.target.value.trim();
    clearTimeout(tocTimer);
    tocTimer = setTimeout(() => { renderTocList(); fillPageRanges(); }, 100);
  });
}
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
  if (e.key === 'Escape') {
    if (closeTopPopup()) { consumeOverlayMark(); return; }
    if (mtModeOn()) setMtMode(false);
    return;
  }
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

/* ===== свайп влево/вправо — смена глав (тач) =====
 * Внутри блока со своей горизонтальной прокруткой (таблица, блок формул) жест сперва
 * принадлежит блоку: пока таблице есть куда ехать, главы не листаются. Дошли до края —
 * следующий свайп уже меняет главу. Полностью запретить нельзя: глава «Сводная таблица»
 * почти целиком одна таблица, и из неё было бы не выйти. */
function scrollerAt(node) {
  for (let el = node instanceof Element ? node : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox === 'auto' || ox === 'scroll') return el;
  }
  return null;
}
// сколько осталось прокрутки в каждую сторону; в RTL scrollLeft отрицателен
function scrollRoom(el) {
  const max = el.scrollWidth - el.clientWidth;
  const fromStart = el.scrollLeft >= 0 ? el.scrollLeft : max + el.scrollLeft;
  return { left: fromStart, right: max - fromStart };
}

let swipeX = null, swipeY = null, swipeT = 0, swipeRoom = null;
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { swipeX = null; return; }
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
  swipeT = Date.now();
  // запас меряем в НАЧАЛЕ жеста: тот же свайп, что прокрутил таблицу, не должен ещё и
  // пролистнуть главу, даже если к концу жеста таблица доехала до упора
  const sc = scrollerAt(e.target);
  swipeRoom = sc ? scrollRoom(sc) : null;
}, { passive: true });
document.addEventListener('touchend', e => {
  if (swipeX == null) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeX, dy = t.clientY - swipeY, dt = Date.now() - swipeT;
  const room = swipeRoom;
  swipeX = null; swipeRoom = null;
  if (document.body.dataset.view !== 'reading' || !book || anyPopupOpen()) return;
  if (dt > 600 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return; // не горизонтальный свайп
  // палец влево — содержимое едет влево, значит прокрутка вправо; и наоборот
  if (room && (dx < 0 ? room.right : room.left) > 1) return;
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
    /* Диапазон пересёк границу разметки — сноску, <b> или обёртку слова
       подстрочника. Раньше здесь было `return false`, то есть выделение молча
       не рисовалось вовсе; невидимая пометка хуже, чем нарисованная кусками,
       поэтому падаем в покраску по кускам текстовых узлов. */
    return paintParts(root, start, end, cls, data) > 0;
  }
}

/* ===== поиск: внутри книги или по всей библиотеке ===== */
// загрузчики, не трогающие глобалы текущей книги (своя кеш-карта)
const searchManifests = new Map(); // id → manifest (+ _base)
const searchChapters = new Map();  // `${id}/${file}` → данные главы
async function searchManifest(entry) {
  if (!searchManifests.has(entry.id)) {
    const b = entry.base.endsWith('/') ? entry.base : entry.base + '/';
    const m = JSON.parse(await fetchBookText(b + 'book.json', entry.private === true));
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
      // приватная книга ищется тоже — через подписанный URL, иначе она молча выпадет из поиска
      try { texts[lang] = await fetchBookText(`${m._base}${lang}/${m.chapters[ci].file}`, entry.private === true); }
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
    /* Считаем значения по книгам, прошедшим ВСЕ ОСТАЛЬНЫЕ группы фасетов, а не по
       всему разделу. Иначе чипс обещает «Ханафитский · 87», а вместе с уже выбранным
       языком даёт пусто — и фильтр приходится откатывать вручную. Свою группу из
       расчёта исключаем: внутри неё ИЛИ, и её значения должны оставаться доступными. */
    const others = {};
    for (const g of FACETS) if (g.key !== f.key && facets[g.key] && facets[g.key].length) others[g.key] = facets[g.key];
    const pool = underCat.filter(e => entryMatchesFacets(e, others));
    const counts = new Map();
    for (const e of pool) for (const v of entryFacetVals(e, f.key)) counts.set(v, (counts.get(v) || 0) + 1);
    // выбранное значение показываем всегда, даже если сейчас оно даёт ноль — иначе снять его нечем
    for (const v of facets[f.key] || []) if (!counts.has(v)) counts.set(v, 0);
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

/* ===== поиск и порядок на полке =====
 * Дерево разделов отвечает на вопрос «что тут вообще есть». На тысячах книг чаще
 * спрашивают другое — «где вот это», и отвечает на такое поиск. Поэтому он живёт
 * прямо на полке, а не только в отдельной панели полнотекстового поиска по главам.
 */
let shelfQuery = '';   /* намеренно НЕ в settings: сохранённый между запусками фильтр
                          при следующем запуске выглядит как «библиотека опустела» */
const SHELF_SORTS = [
  { id: 'manual', label: 'как в реестре' },
  { id: 'title', label: 'по названию' },
  { id: 'author', label: 'по автору' },
  { id: 'recent', label: 'сначала читаемые' },
];
const shelfSort = () =>
  SHELF_SORTS.some(s => s.id === settings.shelfSort) ? settings.shelfSort : 'manual';

/* Строка, по которой ищем: название на всех языках, авторы, теги, жанр, путь раздела.
   Нормализуем тем же foldChar, что и поиск по тексту, — значит арабское название
   находится без огласовок, а русское без учёта регистра и «ё».
   Кэш нужен, чтобы не пересобирать это для каждой книги на каждое нажатие клавиши. */
const haystackCache = new WeakMap();
function entryHaystack(e) {
  let h = haystackCache.get(e);
  if (h === undefined) {
    h = normalize([
      ...Object.values(e.title || {}),
      ...(e.authors || []),
      ...(e.tags || []),
      ...(e.genre || []),
      ...(e.madhhab || []),
      ...bookCatPath(e),
      e.id,
    ].filter(Boolean).join(' '));
    haystackCache.set(e, h);
  }
  return h;
}
function entryMatchesQuery(e, q) {
  if (!q) return true;
  // все слова запроса должны найтись — так «навави шарх» сужает, а не расширяет
  const words = normalize(q).split(/\s+/).filter(Boolean);
  const hay = entryHaystack(e);
  return words.every(w => hay.includes(w));
}

const cmpRu = (a, b) => String(a).localeCompare(String(b), 'ru');
function sortShelf(list) {
  const mode = shelfSort();
  if (mode === 'manual') return list;   // порядок реестра — авторская расстановка
  const out = list.slice();
  if (mode === 'title') out.sort((a, b) => cmpRu(entryLabel(a), entryLabel(b)));
  else if (mode === 'author') {
    const au = e => (Array.isArray(e.authors) && e.authors[0]) || '￿';  // без автора — в конец
    out.sort((a, b) => cmpRu(au(a), au(b)) || cmpRu(entryLabel(a), entryLabel(b)));
  } else if (mode === 'recent') {
    const ts = e => (getLast(e.id) || {}).ts || 0;
    out.sort((a, b) => ts(b) - ts(a) || cmpRu(entryLabel(a), entryLabel(b)));
  }
  return out;
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
/* ── одна запись в каждом из трёх видов ─────────────────────────────────── */
function spineItem(e) {
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
  return sp;
}

/* Строка списка. Самый ёмкий вид — и потому самый нагруженный смыслом: автор,
   раздел и языки прямо здесь. Без них на тысячах книг список не читается: одни
   названия не дают отличить пять «Шархов» друг от друга. */
function listItem(e) {
  const row = document.createElement('button'); row.type = 'button'; row.className = 'book-row';
  const thumb = document.createElement('span'); thumb.className = 'br-thumb'; coverInto(thumb, e, '');

  const main = document.createElement('span'); main.className = 'br-main';
  const title = document.createElement('span'); title.className = 'br-title'; title.textContent = entryLabel(e);
  main.appendChild(title);

  const bits = [];
  const author = (Array.isArray(e.authors) && e.authors.filter(Boolean).join(', ')) || '';
  const path = bookCatPath(e);
  if (path.length) bits.push(path[path.length - 1]);
  if (Array.isArray(e.langs) && e.langs.length) bits.push(e.langs.map(l => l.toUpperCase()).join('+'));
  if (Array.isArray(e.genre) && e.genre.length) bits.push(e.genre.join(', '));
  if (author || bits.length) {
    const meta = document.createElement('span'); meta.className = 'br-meta';
    if (author) {
      const a = document.createElement('b'); a.textContent = author;
      meta.appendChild(a);
      if (bits.length) meta.append(' · ');
    }
    if (bits.length) meta.append(bits.join(' · '));
    main.appendChild(meta);
  }

  const status = document.createElement('span'); status.className = 'br-status'; applyBadges(status, e, false);
  row.append(thumb, main, status);
  row.addEventListener('click', () => openInfoFor(e));
  return row;
}

function coverItem(e) {
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
  cell.appendChild(btn);
  return cell;
}

/* ── список порциями ────────────────────────────────────────────────────────
 * Раньше сюда клали в DOM все книги разом. На десятке это незаметно, на тысячах
 * страница просто не открывается — поэтому рисуем окно и досыпаем по мере
 * прокрутки. Досыпка через IntersectionObserver, а не через обработчик scroll:
 * тот срабатывает на каждый кадр и сам становится тормозом.
 */
const SHELF_CHUNK = 60;
let shelfObserver = null;
let shelfOnScroll = null;

function renderBookList(shown, view, host) {
  if (shelfObserver) { shelfObserver.disconnect(); shelfObserver = null; }
  if (shelfOnScroll) { window.removeEventListener('scroll', shelfOnScroll); shelfOnScroll = null; }

  const make = view === 'spines' ? spineItem : view === 'list' ? listItem : coverItem;
  const box = document.createElement('div');
  box.className = view === 'spines' ? 'spineshelf' : view === 'list' ? 'booklist' : 'shelf';
  host.appendChild(box);

  const sentinel = document.createElement('div');
  sentinel.className = 'shelf-sentinel';
  host.appendChild(sentinel);

  let i = 0;

  /* Одной порции может не хватить, чтобы дотянуться до низа экрана. Наблюдатель сам
     об этом не сообщит: он срабатывает на ИЗМЕНЕНИЕ пересечения, а маячок как был
     виден, так и остался. Поэтому после каждой порции переподписываемся — наблюдатель
     заново проверит маячок и позовёт нас, если тот всё ещё в кадре.

     ⚠️ Не заменять это на цикл «досыпать, пока getBoundingClientRect выше сгиба»:
     такой цикл синхронный, меряет раскладку на каждой итерации и в худшем случае
     отрисовывает весь список разом — то есть ровно то, от чего мы уходим. Проверено
     на 3000 книг: вкладка вешалась намертво. Здесь же между порциями отдаём кадр
     браузеру, и прокрутка остаётся живой. */
  const pump = () => {
    const end = Math.min(i + SHELF_CHUNK, shown.length);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) frag.appendChild(make(shown[i]));
    box.appendChild(frag);

    if (i >= shown.length) {
      if (shelfObserver) { shelfObserver.disconnect(); shelfObserver = null; }
      if (shelfOnScroll) { window.removeEventListener('scroll', shelfOnScroll); shelfOnScroll = null; }
      sentinel.remove();
      return;
    }
    /* Переподписка синхронная, без requestAnimationFrame: в фоновой вкладке кадры не
       выдаются вовсе, и досыпка на rAF там встала бы намертво. Наблюдатель сообщает
       асинхронно, поэтому браузер всё равно успевает отрисовать порцию между вызовами,
       а цикл сам останавливается, как только маячок уходит из кадра. */
    if (shelfObserver && sentinel.isConnected) {
      shelfObserver.unobserve(sentinel);
      shelfObserver.observe(sentinel);
    }
  };

  shelfObserver = new IntersectionObserver(entries => {
    if (entries.some(x => x.isIntersecting)) pump();
  }, { rootMargin: '400px' });
  shelfObserver.observe(sentinel);

  /* Запасной путь. IntersectionObserver — основной, но он не везде доходит: в части
     встроенных webview его придушивают, а в фоновой вкладке не доставляют вовсе.
     Здесь ровно ОДИН замер на событие прокрутки и никакого цикла: досыпали порцию —
     маячок ушёл вниз, следующее событие уже ничего не сделает, пока не долистают. */
  shelfOnScroll = () => {
    if (sentinel.isConnected && sentinel.getBoundingClientRect().top < window.innerHeight + 400) pump();
  };
  window.addEventListener('scroll', shelfOnScroll, { passive: true });

  pump();
}

function renderLibrary() {
  document.body.dataset.view = 'library';
  if (mtModeOn()) setMtMode(false);   // режим перевода живёт только внутри книги
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

  // переключатель видов (запоминается в settings.shelfView)
  const view = ['covers', 'spines', 'list'].includes(settings.shelfView) ? settings.shelfView : (settings.shelfView = 'covers');

  /* Панель полки: поиск, порядок, виды, счётчик. Строится ОДИН раз, а при вводе
     перерисовывается только список — иначе поле поиска пересоздавалось бы на каждой
     букве и теряло фокус вместе с кареткой. */
  const bar = document.createElement('div');
  bar.className = 'shelf-bar';

  const q = document.createElement('input');
  q.type = 'search';
  q.className = 'shelf-search';
  q.placeholder = 'Название, автор, тема…';
  q.value = shelfQuery;
  q.setAttribute('aria-label', 'Поиск по полке');

  const sort = document.createElement('select');
  sort.className = 'shelf-sort';
  sort.setAttribute('aria-label', 'Порядок книг');
  for (const s of SHELF_SORTS) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.label;
    if (s.id === shelfSort()) o.selected = true;
    sort.appendChild(o);
  }

  const sw = document.createElement('div'); sw.className = 'view-switch';
  for (const [v, ico, lab] of [['covers', '▦', 'Обложки'], ['spines', '📚', 'Корешки'], ['list', '☰', 'Список']]) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'vs-btn' + (v === view ? ' active' : '');
    b.title = lab; b.textContent = ico;
    b.addEventListener('click', () => { settings.shelfView = v; saveSettings(); renderLibrary(); });
    sw.appendChild(b);
  }

  /* Фильтры — кнопкой прямо в панели полки, с подписью и счётчиком. В шапке
     она была глифом ⛃ среди десятка иконок: не видно и непонятно, для чего. */
  const filt = document.createElement('button');
  filt.type = 'button';
  filt.id = 'btn-filter';
  filt.className = 'shelf-filter';
  filt.title = 'Отбор по признакам: одобрение, готовность, язык, автор, тема';
  filt.innerHTML = '⛃ Фильтры<span id="filter-count" class="filter-badge" hidden></span>';
  filt.addEventListener('click', () => { renderFilterSheet(); openOverlay($('#filter-sheet')); });

  const count = document.createElement('span');
  count.className = 'shelf-count';

  bar.append(q, sort, sw, filt, count);
  stream.appendChild(bar);
  updateFilterBadge();

  const body = document.createElement('div');
  body.className = 'shelf-body';
  stream.appendChild(body);

  const paint = () => {
    const shown = sortShelf(underCat.filter(e =>
      entryMatchesFacets(e, facets) && entryMatchesQuery(e, shelfQuery)));
    // «показано из скольких» — иначе непонятно, фильтр отсёк или книг столько и есть
    count.textContent = shown.length === underCat.length
      ? `${underCat.length}`
      : `${shown.length} / ${underCat.length}`;
    body.innerHTML = '';
    if (!shown.length) {
      const m = document.createElement('div');
      m.className = 'shelf-empty';
      m.textContent = shelfQuery ? `Ничего не нашлось по запросу «${shelfQuery}».` : 'По выбранным фильтрам книг нет.';
      body.appendChild(m);
    } else {
      renderBookList(shown, view, body);
    }
  };

  let qTimer = null;
  q.addEventListener('input', () => {
    shelfQuery = q.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(paint, 120);   // не перерисовывать список на каждое нажатие
  });
  sort.addEventListener('change', () => {
    settings.shelfSort = sort.value;
    saveSettings();
    paint();
  });
  paint();
  // подпись внизу полки (почта — только в «О приложении», не на главной)
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = 'Библиотека Таухид';
  stream.appendChild(brand);
  window.scrollTo(0, 0);
}

/* ===== карточка книги: большая обложка, автор, аннотация, кнопки чтения ===== */
async function renderBookInfo(entry) {
  document.body.dataset.view = 'library';
  if (mtModeOn()) setMtMode(false);
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
  // приватная книга: манифест тоже из бакета, иначе карточка теряет автора и аннотацию
  try { manifest = JSON.parse(await fetchBookText(baseUrl + 'book.json', entry.private === true)); }
  catch { /* карточка работает и без манифеста */ }

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
  box.appendChild(cov);

  const meta = document.createElement('div');
  meta.className = 'bookinfo-meta';
  const h = document.createElement('h2');
  h.textContent = entryLabel(entry);
  meta.appendChild(h);
  /* Статус — в сведениях, не поверх обложки: обложка рисованная, бейджи
     перекрывали выходные данные (имя издательства, автора). На полке они
     остаются на миниатюре — там колонки сведений нет. */
  const status = document.createElement('div');
  status.className = 'bookinfo-status';
  applyBadges(status, entry, true);
  if (status.childNodes.length) meta.appendChild(status);
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
  privateBook = entry.private === true;   // непубличная книга → путь через бакет
  chapterCache.clear();
  document.body.dataset.view = 'reading';
  $('#chapter-title').textContent = 'Загрузка…';
  try {
    book = JSON.parse(await fetchBookText(base + 'book.json'));
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
  glForget();          // подстрочник прошлой книги к этой отношения не имеет
  document.title = pickTitle(book.title);
  buildToc();
  buildMarkPanel();
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
$('#filter-apply').addEventListener('click', () => { $('#filter-sheet').hidden = true; });
$('#filter-reset').addEventListener('click', () => {
  settings.shelfFacets = {}; saveSettings();
  renderLibrary(); renderFilterSheet();
});

/* ===== аккаунт и каталог за бэкендом (BACKEND.md, фаза 1) =====
   Полка = статический реестр ∪ локальные непубличные ∪ непубличные из бэкенда. Аноним
   без локальной папки видит ровно то же, что и раньше: слагаемые просто пустые, и
   публичная библиотека работает как работала. */
let staticLibrary = [];             // то, что пришло из books/index.json
const backendReady = () => Boolean(window.SB && SB.configured());

/* Локальные непубличные книги: папка books-private/ в проекте, целиком под .gitignore.
   Файлы обычные, читаются прямым fetch — значит работают офлайн и попадают в кеш SW,
   в отличие от бакетных (те идут мимо кеша, см. isBackend в sw.js).
   На GitHub Pages этой папки нет: fetch отвечает 404, и слагаемое просто пустое. */
async function loadLocalBooks() {
  try {
    const res = await fetch('books-private/index.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.books || []).map(b => Object.assign({}, b, { local: true }));
  } catch {
    return [];   // нет папки — это норма, а не поломка
  }
}

async function loadPrivateBooks() {
  if (!backendReady()) return [];
  try {
    if (!(await SB.isSignedIn())) return [];
    const rows = await SB.rest('books?select=id,meta,storage_base,visibility');
    // meta — это готовая запись реестра; id/base/private проставляем поверх неё
    return rows.map(r => Object.assign({}, r.meta || {}, {
      id: r.id,
      base: r.storage_base.endsWith('/') ? r.storage_base : r.storage_base + '/',
      visibility: r.visibility,
      private: true,
    }));
  } catch (err) {
    console.warn('непубличные книги не загрузились:', err);
    return [];
  }
}

/* Одна и та же книга обычно есть и локально, и в бакете (папка проекта — исходник,
   бакет — копия для других устройств). На полке она должна быть ОДНА, и побеждает
   локальная: та же книга, но без сети, без подписанных URL и с офлайном. */
async function refreshLibrary() {
  const [local, backend] = await Promise.all([loadLocalBooks(), loadPrivateBooks()]);
  const seen = new Set();
  library = [];
  for (const b of staticLibrary.concat(local, backend)) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    library.push(b);
  }
}

async function renderAccount() {
  const state = $('#acc-state'), form = $('#acc-form'), out = $('#acc-signout');
  if (!backendReady()) {
    state.textContent = 'Бэкенд не настроен (supabase/config.js) — доступны только публичные книги.';
    form.hidden = true; out.hidden = true;
    return;
  }
  const user = await SB.currentUser();
  form.hidden = Boolean(user);
  out.hidden = !user;
  state.textContent = user
    ? `Вход выполнен${user.email ? ' — ' + user.email : ''}. Непубличные книги, доступные вам, показаны в библиотеке.`
    : 'Вход не выполнен.';
}

$('#btn-account').addEventListener('click', () => {
  $('#settings').hidden = true;
  renderAccount();
  openOverlay($('#account'));
});

$('#acc-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#acc-email').value.trim();
  if (!email) return;
  const btn = $('#acc-form').querySelector('button');
  btn.disabled = true;
  try {
    // возвращаться туда же, откуда вошли (адрес должен быть в Redirect URLs проекта)
    await SB.sendMagicLink(email, location.origin + location.pathname);
    $('#acc-state').textContent = 'Ссылка отправлена на ' + email + '. Откройте её на этом устройстве.';
    $('#acc-form').hidden = true;
  } catch (err) {
    /* Самая частая ошибка здесь выглядит бессмысленно. Публичная регистрация закрыта,
       и клиент просит ссылку с create_user:false — тогда на НЕизвестную почту GoTrue
       отвечает «Signups not allowed for otp». По этой строке нипочём не догадаться,
       что дело всего лишь в опечатке в адресе, поэтому переводим её по-человечески. */
    const unknownMail = err.code === 'otp_disabled' || err.code === 'signup_disabled'
      || /signups not allowed/i.test(err.message || '');
    $('#acc-state').textContent = unknownMail
      ? `Почта ${email} не заведена в библиотеке. Регистрация закрыта: ссылка приходит только на уже заведённый адрес — проверьте написание.`
      : 'Не получилось отправить ссылку: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#acc-signout').addEventListener('click', async () => {
  SB.signOut();
  await refreshLibrary();
  await renderAccount();
  document.body.dataset.view = 'library';
  renderLibrary();
  toast('Вы вышли');
});

/* ===== старт ===== */
async function init() {
  migrateMarks();   // старые закладки/выделения → единые пометки (одноразово)
  applyTheme();
  applyLayout();
  applyAlign();
  bindSettings();
  // возврат по магик-линку: токены прилетают в hash — снять их до разбора маршрута
  let authBack = null;
  if (backendReady()) { try { authBack = SB.consumeAuthCallback(); } catch { /* не мешаем старту */ } }
  try {
    const idx = JSON.parse(await fetchText('books/index.json'));
    staticLibrary = Array.isArray(idx) ? idx : (idx.books || []);
    library = staticLibrary;
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
  // непубличные книги — уже поверх готового реестра: если бэкенд молчит, полка живёт
  await refreshLibrary();
  route();
  // молча проглоченная неудача входа выглядит как «ссылка не работает» — сказать вслух
  if (authBack) {
    toast(authBack.status === 'signed-in'
      ? 'Вход выполнен'
      : 'Ссылка не сработала: ' + (authBack.message || 'срок истёк'));
  }
}

init();

/* ===== PWA: офлайн через service worker ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW не зарегистрирован:', err));
  });
}
