#!/usr/bin/env node
'use strict';
/*
 * Стенд для проверки кэша и скорости: раздаёт читалку как обычный статический сервер,
 * но умеет притвориться сервером, который МОЛЧИТ.
 *
 *   node tools/stend.js [порт=8131]
 *
 * Открывать по адресу 127.0.0.1, а не localhost: на localhost воркер (sw.js) нарочно
 * работает по-старому, «сначала сеть», чтобы правки были видны сразу, — и ни кеша, ни
 * молчащего сервера там не проверить.
 *
 * Зачем отдельный сервер. Отключённая сеть — случай простой: запрос падает сразу, и
 * читалка берёт сохранённое. Беда — когда сервер принял соединение и не отвечает (плохая
 * связь, хостинг закрыл адрес): запрос висит минутами, и всё, что ждёт сети, висит вместе
 * с ним. 15.11.2026 установленная читалка так показывала пустой экран 136 секунд.
 * `python3 -m http.server` этого не изобразит, поэтому здесь есть режимы:
 *
 *   /__stend?mode=ok     обычная раздача
 *   /__stend?mode=hang   на всё остальное не отвечать вовсе — соединение держится открытым
 *   /__stend?mode=down   на всё остальное отвечать 503
 *   /__stend?mode=slow   отвечать как обычно, но с задержкой (по умолчанию 6 с; &ms=3000 — своя):
 *                        медленная связь, на которой видно, что читалка ждёт, а чего не ждёт
 *   /__stend?mode=stub   на всё остальное отвечать «200 OK» страницей-заглушкой — так ведёт
 *                        себя хостинг в беде («аккаунт приостановлен», «идут работы»);
 *                        сохранённое на устройстве заглушка затирать не должна
 *   /__stend?reset=1     обнулить счётчик запросов
 *   /__stend             показать режим, число запросов и их список
 *
 * Счётчик нужен, чтобы видеть цену действия в запросах: сколько их уходит на запуск,
 * на открытие статьи, на поиск по библиотеке.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const порт = Number(process.argv[2] || process.env.PORT || 8131);
const корень = path.resolve(__dirname, '..');
const ТИПЫ = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const состояние = { mode: 'ok', hits: 0, log: [], ms: 6000 };
const висят = new Set();   // ответы, оставленные без ответа в режиме hang
const ждут = new Map();    // ответ → таймер задержки в режиме slow

http.createServer((req, res) => {
  const адрес = new URL(req.url, 'http://x');
  if (адрес.pathname === '/__stend') {
    const mode = адрес.searchParams.get('mode');
    if (['ok', 'hang', 'down', 'stub', 'slow'].includes(mode)) состояние.mode = mode;
    if (адрес.searchParams.has('ms')) состояние.ms = Math.max(0, Number(адрес.searchParams.get('ms')) || 0);
    /* Вышли из режима hang — рвём повисшие соединения. Иначе они так и висят, а браузер
       даёт на адрес всего шесть: стенд остаётся отравленным до перезапуска, и следующая
       проверка меряет не читалку, а очередь за мёртвыми запросами. */
    if (состояние.mode !== 'hang') { for (const r of висят) r.destroy(); висят.clear(); }
    /* То же с задержанными: сменили режим — запросы, принятые в slow, не должны через
       несколько секунд прийти обычным ответом и подмешаться в замер «молчащего сервера». */
    if (состояние.mode !== 'slow') { for (const [r, т] of ждут) { clearTimeout(т); r.destroy(); } ждут.clear(); }
    if (адрес.searchParams.has('reset')) { состояние.hits = 0; состояние.log = []; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ mode: состояние.mode, hits: состояние.hits, log: состояние.log.slice(-600) }));
    return;
  }

  состояние.hits++;
  состояние.log.push(адрес.pathname);
  if (состояние.mode === 'hang') {          // не отвечаем: соединение остаётся висеть
    висят.add(res);
    res.on('close', () => висят.delete(res));
    return;
  }
  if (состояние.mode === 'down') { res.writeHead(503); res.end('стенд: сервер недоступен'); return; }
  if (состояние.mode === 'stub') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Сайт временно недоступен</h1></body></html>');
    return;
  }

  if (состояние.mode === 'slow') {
    const т = setTimeout(() => { ждут.delete(res); отдать(req, res, адрес); }, состояние.ms);
    ждут.set(res, т);
    res.on('close', () => { clearTimeout(т); ждут.delete(res); });   // вкладку закрыли — ждать некого
    return;
  }
  отдать(req, res, адрес);
}).listen(порт, '127.0.0.1', () => {
  console.log(`стенд читалки (режимы — /__stend?mode=ok|hang|down|stub|slow):`);
  console.log(`  http://127.0.0.1:${порт}/   как на сайте: оболочка и тексты из кеша`);
  console.log(`  http://localhost:${порт}/   режим разработки: воркер всегда идёт в сеть`);
});

function отдать(req, res, адрес) {
  let имя;
  try { имя = decodeURIComponent(адрес.pathname); } catch { res.writeHead(400); res.end(); return; }
  if (имя.includes('\0')) { res.writeHead(400); res.end(); return; }   // нулевой байт уронил бы fs.stat
  let файл = path.join(корень, имя);
  // с разделителем: без него «…/skorost-2/x» сошло бы за «внутри …/skorost»
  if (файл !== корень && !файл.startsWith(корень + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.stat(файл, (ош, ст) => {
    if (!ош && ст.isDirectory()) { файл = path.join(файл, 'index.html'); try { ст = fs.statSync(файл); } catch { ош = true; } }
    if (ош || !ст || !ст.isFile()) { res.writeHead(404); res.end('нет файла'); return; }
    /* Условные запросы и заголовки — как у GitHub Pages: ETag, Last-Modified и
       Cache-Control: max-age=600. Без них на стенде не выполнялись бы те ветки воркера,
       что работают на сайте: сверка по метке и запросы мимо HTTP-кеша браузера. */
    const изменён = new Date(ст.mtime); изменён.setMilliseconds(0);
    const метка = `W/"${ст.size.toString(16)}-${изменён.getTime().toString(16)}"`;
    // на localhost (режим разработки) — «не хранить»: иначе браузер десять минут отдаёт прежний
    // app.js из своей памяти, и правка не видна; на 127.0.0.1 — как на сайте
    const дома = (req.headers.host || '').startsWith('localhost');
    const общие = { ETag: метка, 'Last-Modified': изменён.toUTCString(), 'Cache-Control': дома ? 'no-cache' : 'max-age=600' };
    const знает = req.headers['if-none-match'], с = req.headers['if-modified-since'];
    if (знает ? знает === метка : (с && new Date(с) >= изменён)) { res.writeHead(304, общие); res.end(); return; }
    res.writeHead(200, Object.assign({
      'Content-Type': ТИПЫ[path.extname(файл).toLowerCase()] || 'application/octet-stream',
      'Content-Length': ст.size,
    }, общие));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(файл).on('error', () => res.destroy()).pipe(res);
  });
}
