'use strict';

/*
 * Service worker: мгновенный запуск и чтение без сети.
 *
 * Три полки кеша, у каждой своё правило.
 *
 *  1. ОБОЛОЧКА (index.html, стили, сценарии, значки) — «с устройства, сеть не ждём».
 *     Ставится целиком при установке воркера и отдаётся без похода в сеть. Новая
 *     оболочка приезжает новой версией воркера: поднят VERSION — браузер ставит его,
 *     тот кладёт свежие файлы в свой кеш, и со следующего открытия читалка новая.
 *  2. СОДЕРЖИМОЕ (books/**, books-private/**) — «с устройства, а в фоне переспросить».
 *     Сохранённое отдаём сразу; следом тянем свежую копию и кладём в кеш. Если она
 *     отличается — говорим странице (`updated`), и та решает: перерисовать полку или
 *     предложить читателю обновлённый текст. Не сохранено — идём в сеть.
 *  3. ШРИФТЫ Google — «с устройства»: они неизменны.
 *  Остальное со своего адреса — «сначала сеть, при неудаче кеш», как было раньше.
 *  Чужие адреса (переводчики, бэкенд) идут мимо воркера: это не наше, и в кеше им не место.
 *
 * Почему не «сначала сеть» для всего, как было до v83. Тогда каждый файл сперва
 * спрашивался у сервера, и скорость читалки равнялась скорости сети — даже когда всё
 * нужное уже лежало на устройстве. Хуже всего приходилось, когда сервер принял
 * соединение и молчит (плохая связь, хостинг закрыл адрес): запрос не падает, а висит.
 * 15.11.2026 установленная читалка так показывала пустой экран 136 секунд. Отключённая
 * сеть этого не показывает — там запрос падает сразу; проверять надо «молчащим»
 * сервером: `node tools/stend.js`, режим hang.
 *
 * Чем за это заплачено. Правка текста доходит до читателя, уже открывавшего главу, не
 * в ту же секунду, а следом за сохранённой копией: читалка показывает прежний текст,
 * в фоне получает новый и предлагает его показать. Молча держать старое месяцами,
 * как случалось до v57, эта схема не может: содержимое переспрашивается при каждом
 * обращении (но не чаще, чем раз в REFRESH_AFTER).
 *
 * ⚠️ VERSION теперь поднимать ОБЯЗАТЕЛЬНО при любой правке файлов оболочки. Раньше
 * забытый подъём стоил лишь неубранного старого кеша; теперь без него читатель не
 * получит новую оболочку. Страховка от забывчивости есть (refreshShell: раз в
 * SHELL_CHECK_EVERY сверяем оболочку с сервером), но это страховка, а не порядок.
 */

const VERSION = 'chitalka-v87';
const SHELL_CACHE = VERSION.replace('chitalka-', 'chitalka-shell-');
const CONTENT_CACHE = 'chitalka-content-v1';   // переживает смену версии оболочки
const FONT_CACHE = 'chitalka-fonts-v1';
const KEEP = new Set([SHELL_CACHE, CONTENT_CACHE, FONT_CACHE]);
const LEGACY = /^chitalka-v\d+$/;              // прежний единый кеш (до v83): оболочка, книги и шрифты вперемешку

// без этих файлов читалка не запустится: не скачались при установке — версия не ставится
const SHELL_CORE = [
  './',
  'index.html',
  'style.css',
  'parser.js',
  'translate.js',
  'gloss.js',
  'app.js',
  'supabase/config.js',
  'supabase/client.js',
];
// без этих проживём: не скачались — возьмём из сети при первом обращении
const SHELL_EXTRA = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon.png',
  'icons/logo.jpg',
];
// реестр и дерево разделов — содержимое, но без них полка пуста: кладём при установке,
// чтобы читалка, открытая один раз, запускалась без сети
const CONTENT_SEED = ['books/index.json', 'books/taxonomy.json'];

const REFRESH_AFTER = 30 * 1000;              // текст и реестр переспрашиваем не чаще
const REFRESH_MEDIA_AFTER = 24 * 3600 * 1000; // обложки и картинки — раз в сутки
const SHELL_CHECK_EVERY = 6 * 3600 * 1000;    // страховка от забытого VERSION
const NET_WAIT = 4000;                        // «сначала сеть»: сколько ждём, если есть запасная копия
const FONT_WAIT = 2500;                       // таблицу шрифтов, которой нет в кеше, ждём не дольше
const BG_WAIT = 20000;                        // срок фонового запроса (сверка, установка)
const AT = 'x-chitalka-at';                   // когда копию взяли с сервера
const SHELL_STAMP = '__shell-checked';

const SCOPE = new URL(self.registration.scope);
/* На localhost воркер работает по-старому: «сначала сеть» для всего. Там читалку правят,
   и оболочка из кеша прятала бы каждую правку app.js до подъёма VERSION, а сохранённый
   текст — каждую правку главы до второго открытия (ровно та беда, что описана в CLAUDE.md
   про v57). Настоящее поведение проверяют по адресу 127.0.0.1: для браузера это другой сайт,
   со своим воркером и своим кешем. Стенд `node tools/stend.js` открывается обоими адресами. */
const DEV = SCOPE.hostname === 'localhost';
const abs = u => new URL(u, SCOPE).href;
const SHELL_URLS = new Set(SHELL_CORE.concat(SHELL_EXTRA).map(abs));
const INDEX_URL = abs('index.html');

const isFont = url => /(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname);
// бэкенд (аутентификация, реестр приватных книг, подписанные URL) — мимо кеша совсем:
// приватный контент не должен оседать в кеше, иначе токен-гейт обходится через него
// OpenRouter — тоже API, а не контент: каталог моделей и цены меняются, и держать
// их в офлайн-кеше значит однажды показать выбор из моделей, которых уже нет
const isBackend = url =>
  /(^|\.)supabase\.(co|in)$/.test(url.hostname) || /(^|\.)openrouter\.ai$/.test(url.hostname);
const isContent = url => url.origin === SCOPE.origin &&
  (url.pathname.startsWith(SCOPE.pathname + 'books/') || url.pathname.startsWith(SCOPE.pathname + 'books-private/'));
const isMedia = url => /\.(jpe?g|png|webp|gif|svg|avif|mp3|ogg|m4a|mp4|webm|pdf)$/i.test(url.pathname);
const okStatus = res => res && res.status === 200 && (res.type === 'basic' || res.type === 'cors');
const fresh = u => new Request(u, { cache: 'no-cache' });   // переспросить сервер (обычно 304)

/* Ответ похож на то, что просили? Хостинг в беде умеет отвечать «200 OK» страницей-заглушкой
   на ЛЮБОЙ адрес. Положи мы её в кеш вместо реестра или главы — сохранённая библиотека
   затрётся заглушкой ровно тогда, когда на неё вся надежда, и читалка не откроется уже и
   без сети. Поэтому страница вместо не-страницы в кеш не идёт никогда. */
const plausible = (url, res) =>
  /\.html?$/i.test(url.pathname) || !(res.headers.get('content-type') || '').toLowerCase().includes('html');

/* Запрос со сроком — на всё, и на заголовки, и на тело. Молчащий сервер держит соединение
   открытым, а браузер даёт на один адрес всего шесть соединений: повисшие фоновые запросы
   занимают их все, и когда сервер оживает, настоящие стоят в очереди за мёртвыми. Срок эту
   очередь чистит. Возвращает { res, buf }: res — ответ (тело уже прочитано), buf — его байты. */
async function grab(u, ms, как = 'no-cache', ещё = {}) {
  const стоп = new AbortController();
  const срок = setTimeout(() => стоп.abort(), ms);
  try {
    const res = await fetch(new Request(u, Object.assign({ cache: как, signal: стоп.signal }, ещё)));
    return { res, buf: await res.arrayBuffer() };
  } finally {
    clearTimeout(срок);
  }
}

/* Заголовки для копии, которую кладём в кеш или отдаём странице. Длину и сжатие убираем:
   тело у нас уже распакованное, и прежние значения к нему не относятся. `at` — отметка
   времени: по ней видно, давно ли копию сверяли с сервером. */
function headersOf(res, at) {
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (at) headers.set(AT, String(Date.now()));
  return headers;
}
/* Ответ из прочитанного. Заодно снимается пометка «перенаправлен»: такой ответ браузер
   отказался бы отдать на переход по адресу. */
const БЕЗ_ТЕЛА = new Set([101, 204, 205, 304]);   // таким ответам тело не положено: с ним Response бросит ошибку
const rebuilt = ({ res, buf }, at) =>
  new Response(БЕЗ_ТЕЛА.has(res.status) ? null : buf, { status: res.status, statusText: res.statusText, headers: headersOf(res, at) });
/* Копия файла оболочки для кеша. «Хранить 10 минут» от сервера (так отвечает GitHub Pages)
   с неё снимаем: с этим заголовком браузер вправе взять сценарий из своей памяти, не
   спросив воркер, — и после обновления оболочки новая страница получила бы прежний app.js.
   С «no-cache» он спрашивает воркер всегда, а тот отвечает из кеша мгновенно. */
function shellCopy(got) {
  const res = rebuilt(got);
  res.headers.set('cache-control', 'no-cache');
  return res;
}
// то же для ответа, который ещё не читали: тело идёт потоком
const stamped = res =>
  new Response(res.body, { status: res.status, statusText: res.statusText, headers: headersOf(res, true) });

/* Возраст копии. Отметка из будущего (на устройстве переводили часы) — это «очень давно»,
   а не «только что»: иначе сверка молчала бы, пока часы не догонят отметку. */
function age(at) {
  const прошло = Date.now() - (Number(at) || 0);
  return прошло < 0 ? Infinity : прошло;
}

function sameBytes(x, y) {
  if (x.byteLength !== y.byteLength) return false;
  const p = new Uint8Array(x), q = new Uint8Array(y);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/* Изменился ли файл: `old` — сохранённый ответ (его тело здесь читается — давать копию),
   `got` — свежий, уже прочитанный. Метки сервера — только повод присмотреться: на GitHub
   Pages дата изменения у всех файлов равна времени выкладки, и по ней каждая выкладка
   «меняла» бы всю библиотеку. Поэтому при несовпавших метках сверяем сами байты. */
async function differs(old, got) {
  const e1 = old.headers.get('etag'), e2 = got.res.headers.get('etag');
  if (e1 && e2 && e1 === e2) return false;
  const l1 = old.headers.get('last-modified'), l2 = got.res.headers.get('last-modified');
  if (!(e1 && e2) && l1 && l2 && l1 === l2) return false;
  return !sameBytes(await old.arrayBuffer(), got.buf);
}

async function notify(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) c.postMessage(msg);
}

/* Файл оболочки похож на себя? Та же заглушка хостинга, что и выше, но оболочке она
   опаснее: положи мы её вместо app.js — читалка не запустится, и починить её с устройства
   будет нечем: оболочку мы берём из кеша, не спрашивая сеть. */
function looksRight(u, res) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (/\.js$/.test(u)) return /javascript|ecmascript/.test(type);
  if (/\.css$/.test(u)) return type.includes('css');
  if (/\.(png|jpe?g)$/.test(u)) return type.startsWith('image/');
  // тип .webmanifest сервер может и не знать — довольно того, что это не страница
  if (/\.webmanifest$/.test(u)) return !type.includes('html');
  return type.includes('html');   // './' и index.html
}

/* `как` — режим кеша запроса: 'reload' при установке (мимо HTTP-кеша браузера, целиком),
   'no-cache' при сверке (условный запрос, обычно 304 без тела). */
async function fetchShellFile(u, как = 'reload') {
  const got = await grab(u, BG_WAIT, как);
  if (!okStatus(got.res) || !looksRight(u, got.res)) throw new Error(`оболочка: ${u} — ${got.res.status} ${got.res.headers.get('content-type')}`);
  // заглушка хостинга тоже html — отличаем по тому, что настоящая страница зовёт app.js
  if ((u === './' || u === 'index.html') && !new TextDecoder().decode(got.buf).includes('app.js')) {
    throw new Error(`оболочка: ${u} — это не страница читалки`);
  }
  return got;
}

/* Положить оболочку в кеш: при установке воркера и когда кеш оказался пуст (см. shellFirst). */
async function precacheShell() {
  const shell = await caches.open(SHELL_CACHE);
  // главное — целиком или никак: половина оболочки хуже, чем прежняя оболочка
  const core = await Promise.all(SHELL_CORE.map(async u => [u, await fetchShellFile(u)]));
  await Promise.all(core.map(([u, got]) => shell.put(u, shellCopy(got))));
  await shell.put(SHELL_STAMP, new Response(String(Date.now())));
  await Promise.allSettled(SHELL_EXTRA.map(async u => shell.put(u, shellCopy(await fetchShellFile(u)))));
  // таблица шрифтов: адрес берём из самой страницы, чтобы не держать его в двух местах
  try {
    const html = new TextDecoder().decode(core.find(([u]) => u === 'index.html')[1].buf);
    const m = html.match(/href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/);
    if (m) {
      const fonts = await caches.open(FONT_CACHE);
      const адрес = m[1].replace(/&amp;/g, '&');
      if (!(await fonts.match(адрес, { ignoreVary: true }))) {
        const got = await grab(адрес, BG_WAIT, 'default', { mode: 'cors' });
        if (okStatus(got.res)) await fonts.put(адрес, rebuilt(got));
      }
    }
  } catch { /* шрифты — не повод срывать установку */ }
  const content = await caches.open(CONTENT_CACHE);
  await Promise.allSettled(CONTENT_SEED.map(async u => {
    if (await content.match(u)) return;        // уже есть — обновится обычным порядком
    const got = await grab(u, BG_WAIT);
    if (okStatus(got.res) && plausible(new URL(u, SCOPE), got.res)) await content.put(u, rebuilt(got, true));
  }));
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(precacheShell());
});

/* Кеш оболочки пропал под работающим воркером: браузер вправе вычистить его, когда на
   устройстве кончается место, а читатель — стереть «данные сайта». Воркер при этом остаётся,
   и без кеша каждый запуск снова шёл бы в сеть, а без сети читалка не открылась бы вовсе.
   Поэтому, не найдя файл оболочки, кладём её заново — один раз, а не на каждый промах. */
let чиним = null;
function restoreShell() {
  if (!чиним) чиним = precacheShell().catch(() => {}).finally(() => { чиним = null; });
  return чиним;
}

/* До v83 кеш был один на всё (`chitalka-vNN`). Его книги и шрифты переносим на новые
   полки — иначе обновление стёрло бы всё, что читатель накопил для чтения без сети.
   Оболочку и чужие адреса не переносим. Переезд идёт в фоне и по одной записи: положили
   в новый кеш — убрали из старого. Так он не держит активацию (пока воркер активируется,
   запросы страницы стоят), не занимает место дважды и продолжается с того же места, если
   браузер усыпит воркер на полдороге. */
let переезд = null, переехали = false;
function adoptLegacy() {
  if (переехали) return Promise.resolve();
  if (!переезд) {
    переезд = (async () => {
      for (const имя of (await caches.keys()).filter(k => LEGACY.test(k))) {
        const old = await caches.open(имя);
        for (const req of await old.keys()) {
          const url = new URL(req.url);
          const куда = isFont(url) ? FONT_CACHE : isContent(url) ? CONTENT_CACHE : null;
          if (куда) {
            try {
              const цель = await caches.open(куда);
              if (!(await цель.match(req, { ignoreVary: true }))) {
                const res = await old.match(req);
                // без отметки времени: при первом обращении копию переспросим
                if (res && plausible(url, res)) await цель.put(req, res);
              }
            } catch { /* не поместилось — эту запись теряем, остальные едут дальше */ }
          }
          await old.delete(req);
        }
        await caches.delete(имя);
      }
      переехали = true;
    })().catch(() => {}).finally(() => { переезд = null; });
  }
  return переезд;
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // чужие кеши не трогаем: на одном адресе живут и другие приложения (у Cache Storage
    // граница — сайт, а не папка); прежний единый кеш разбирает adoptLegacy
    const лишние = keys.filter(k => k.startsWith('chitalka-') && !KEEP.has(k) && !LEGACY.test(k));
    const былаОболочка = лишние.some(k => k.startsWith('chitalka-shell-'));
    await Promise.all(лишние.map(k => caches.delete(k)));
    await self.clients.claim();
    /* Открытые страницы, взятые из прежнего кеша оболочки, показывают прежнюю читалку —
       говорим им. При переходе с единого кеша (до v83) говорить нечего: тогда страница шла
       «сначала из сети» и уже пришла новой. */
    if (былаОболочка) notify({ type: 'shell-updated' });
    adoptLegacy();   // не ждём
  })());
});

/* ОБОЛОЧКА: из кеша версии. Нет в кеше — отдаём из сети, а кеш следом восстанавливаем. */
async function shellFirst(req, key, event) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key || req, { ignoreSearch: true });
  if (hit) return hit;
  event.waitUntil(restoreShell());
  return fetch(fresh(req));
}

/* Страховка от забытого VERSION. Раз в SHELL_CHECK_EVERY переспрашиваем всю оболочку;
   если хоть один файл изменился — меняем её в кеше ЦЕЛИКОМ и сообщаем странице.
   Целиком — потому что новый index.html со старым app.js хуже, чем оба старые; любой
   сбой или подозрительный ответ — ничего не трогаем. */
async function refreshShell() {
  const cache = await caches.open(SHELL_CACHE);
  const mark = await cache.match(SHELL_STAMP);
  if (mark && age(await mark.text()) < SHELL_CHECK_EVERY) return;
  // отметку ставим сразу: соседняя вкладка не должна затеять вторую проверку
  await cache.put(SHELL_STAMP, new Response(String(Date.now())));
  const got = await Promise.all(SHELL_CORE.map(async u => [u, await fetchShellFile(u, 'no-cache')]));
  let changed = false;
  for (const [u, g] of got) {
    const old = await cache.match(u);
    if (!old || await differs(old, g)) { changed = true; break; }
  }
  if (!changed) return;
  await Promise.all(got.map(([u, g]) => cache.put(u, shellCopy(g))));
  notify({ type: 'shell-updated' });
}

/* СОДЕРЖИМОЕ: сохранённое — сразу, свежее — следом. */
async function contentFirst(req, url, event) {
  const cache = await caches.open(CONTENT_CACHE);
  const hit = await cache.match(req);
  if (!hit) {
    // срок здесь задаёт страница (fetchText): её отмена доходит и до этого запроса
    const res = await fetch(fresh(req));
    if (okStatus(res) && plausible(url, res)) event.waitUntil(cache.put(req, stamped(res.clone())));
    return res;
  }
  if (age(hit.headers.get(AT)) > (isMedia(url) ? REFRESH_MEDIA_AFTER : REFRESH_AFTER)) {
    event.waitUntil(revalidate(req, url, hit.clone(), cache));
  }
  return hit;
}

async function revalidate(req, url, old, cache) {
  let got;
  try { got = await grab(req, BG_WAIT); } catch { return; }   // сети нет или молчит — живём с сохранённым
  if (!okStatus(got.res) || !plausible(url, got.res)) return;  // 404, 500, заглушка хостинга — сохранённое надёжнее
  const changed = await differs(old, got);
  await cache.put(req, rebuilt(got, true));
  if (changed) notify({ type: 'updated', url: req.url });
}

/* ПРОЧЕЕ и то, что страница просит свежим: сначала сеть. Но если запасная копия есть,
   сеть ждём не дольше NET_WAIT — молчащий сервер не должен вешать то, что лежит на
   устройстве. Отдали запасную, а сеть потом всё же ответила другим — говорим странице,
   как при обычной сверке: иначе она так и осталась бы со старым. */
async function networkFirst(req, key, url, event) {
  const cache = await caches.open(CONTENT_CACHE);
  const hit = await cache.match(key);
  if (!hit) {
    const res = await fetch(fresh(req));
    if (okStatus(res) && plausible(url, res)) event.waitUntil(cache.put(key, stamped(res.clone())));
    return res;
  }
  const запас = hit.clone();
  let поздно = false;
  const net = (async () => {
    const got = await grab(req, BG_WAIT);
    if (okStatus(got.res) && plausible(url, got.res)) {
      const changed = поздно && await differs(запас, got);
      await cache.put(key, rebuilt(got, true));
      if (changed) notify({ type: 'updated', url: req.url });
    }
    return rebuilt(got);
  })();
  event.waitUntil(net.catch(() => {}));
  return Promise.race([
    net.catch(() => hit),
    new Promise(resolve => setTimeout(() => { поздно = true; resolve(hit); }, NET_WAIT)),
  ]);
}

/* ШРИФТЫ: из кеша. Таблица шрифтов (fonts.googleapis.com) держит первый показ страницы,
   поэтому, пока её нет в кеше, сеть ждём не дольше FONT_WAIT: не успела — отдаём пустую
   таблицу, текст покажется запасным шрифтом, а настоящая доедет в кеш к следующему
   открытию. Сами файлы шрифтов показу не мешают (display=swap) — их просто ждём. */
async function fontFirst(req) {
  const cache = await caches.open(FONT_CACHE);
  // ignoreVary: Google помечает ответ зависящим от заголовков запроса, а запрос страницы
  // и запрос воркера при установке ими различаются — без этого своё же не находим
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const net = fetch(req).then(res => {
    if (okStatus(res)) cache.put(req, res.clone());
    return res;
  });
  if (req.destination !== 'style') return net;
  const пустая = () => new Response('', { headers: { 'Content-Type': 'text/css' } });
  return Promise.race([
    net.catch(пустая),
    new Promise(resolve => setTimeout(() => resolve(пустая()), FONT_WAIT)),
  ]);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isBackend(url)) return;                 // network-only, без участия SW
  if (req.headers.has('range')) return;       // куски файла (звук, видео) кешу не по зубам
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (!переехали) event.waitUntil(adoptLegacy());
  if (isFont(url)) { event.respondWith(fontFirst(req)); return; }
  /* Чужие адреса — мимо воркера. Это переводчик (в адресе запроса — сам переводимый текст,
     в том числе из непубличных книг), внешние картинки и прочее не наше; раньше всё это
     оседало в кеше и стиралось с каждой версией, теперь стирать его было бы некому.
     Появятся книги с содержимым на чужом адресе — завести для них явное правило. */
  if (url.origin !== SCOPE.origin) return;

  const here = url.origin + url.pathname;
  // любая страница читалки (?book=…&s=…) — это один и тот же index.html
  const страница = req.mode === 'navigate' && (here === SCOPE.href || here === INDEX_URL);
  if (DEV) {
    // страницы кладём под одним ключом — иначе кеш пухнет по записи на каждый адрес
    event.respondWith(networkFirst(req, страница ? INDEX_URL : req, url, event));
    return;
  }
  if (страница) {
    event.respondWith(shellFirst(req, INDEX_URL, event));
    event.waitUntil(refreshShell().catch(() => {}));
    return;
  }
  if (SHELL_URLS.has(here)) { event.respondWith(shellFirst(req, null, event)); return; }
  /* Страница сама просит свежее (`cache: 'no-cache'` и строже) — уважаем: сначала сеть.
     Так читается реестр локальных непубличных книг (на машине автора он меняется под
     рукой) и публичный реестр, когда в адресе запись, которой в сохранённом нет. */
  const wantsFresh = req.cache === 'no-cache' || req.cache === 'reload' || req.cache === 'no-store';
  if (isContent(url) && !wantsFresh && req.mode !== 'navigate') { event.respondWith(contentFirst(req, url, event)); return; }
  event.respondWith(networkFirst(req, req, url, event));
});
