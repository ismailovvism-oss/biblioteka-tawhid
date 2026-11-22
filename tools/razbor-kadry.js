#!/usr/bin/env node
'use strict';

/*
 * «Ясный разбор» картинками (SPEC 3.4h): снимает кадры разбора записи в PNG 1080×1350 —
 * для альбома в Telegram, обложки поста, ролика. Снимает настоящую читалку в Chrome без
 * окна, поэтому картинка — ровно то, что видит читатель (шрифты, арабский, тема).
 *
 *   node tools/razbor-kadry.js books/<id> <папка> [--без check,next] [--подпись "tawhiid.com/kutub"]
 *
 * Разбор в читалке всегда на тёмной сцене с золотом (style.css, #razbor) — снимок тот же.
 * --без    виды кадров, которые не снимать (по умолчанию check,next: в альбоме проверка —
 *          это опрос-викторина Telegram, а «дальше» — ссылка в подписи).
 * Снимок без кнопок листания и счётчика: в альбоме своя нумерация.
 *
 * ⚠ Арабский на картинке после снимка — глазами по увеличенному кадру (огласовки, порядок
 * слов): сверка текста здесь уже не поможет, это пиксели.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const КОРЕНЬ = path.join(__dirname, '..');
const арг = process.argv.slice(2);
const опция = (имя, по) => { const i = арг.indexOf(имя); return i >= 0 ? арг.splice(i, 2)[1] : по; };
const БЕЗ = опция('--без', 'check,next').split(',').filter(Boolean);
const ПОДПИСЬ = опция('--подпись', 'tawhiid.com/kutub');
const [книга, куда] = арг;
if (!книга || !куда) {
  console.error('Использование: node tools/razbor-kadry.js books/<id> <папка> [--без check,next]');
  process.exit(2);
}
const id = path.basename(path.resolve(книга));
const W = 432, H = 540, DPR = 2.5;   // 1080×1350 — вертикальный кадр 4:5, на телефоне почти весь экран

const СНИМОК = `.rz-frame{animation:none!important}.rz-nav,#rz-close,#rz-count,#rz-bar,.rz-more,.rz-end{display:none!important}
  #rz-stage{overflow:hidden!important}
  #rz-brand{position:absolute;left:0;right:0;bottom:14px;text-align:center;font-size:12px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--muted)}`;

const ТИПЫ = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

(async () => {
  fs.mkdirSync(куда, { recursive: true });
  const сервер = http.createServer((з, о) => {
    let п = decodeURIComponent(new URL(з.url, 'http://x').pathname);
    if (п.endsWith('/')) п += 'index.html';
    const файл = path.join(КОРЕНЬ, п);
    if (!файл.startsWith(КОРЕНЬ) || !fs.existsSync(файл) || fs.statSync(файл).isDirectory()) { о.writeHead(404); return о.end(); }
    о.writeHead(200, { 'content-type': ТИПЫ[path.extname(файл)] || 'application/octet-stream' });
    о.end(fs.readFileSync(файл));
  }).listen(0, 'localhost');
  await new Promise(r => сервер.once('listening', r));
  const порт = сервер.address().port;

  const профиль = fs.mkdtempSync(path.join(os.tmpdir(), 'razbor-kadry-'));
  const хром = spawn('google-chrome-stable', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${профиль}`,
    '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const стоп = () => { try { хром.kill(); } catch { /* уже нет */ } сервер.close(); fs.rmSync(профиль, { recursive: true, force: true }); };
  try {
    let отладка;
    for (let i = 0; i < 100 && !отладка; i++) {
      await new Promise(r => setTimeout(r, 100));
      const ф = path.join(профиль, 'DevToolsActivePort');
      if (fs.existsSync(ф)) отладка = fs.readFileSync(ф, 'utf8').split('\n')[0];
    }
    if (!отладка) throw new Error('Chrome не поднялся');
    const страницы = await (await fetch(`http://127.0.0.1:${отладка}/json/list`)).json();
    const ws = new WebSocket(страницы.find(с => с.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let н = 0; const ждут = new Map();
    ws.addEventListener('message', с => { const м = JSON.parse(с.data); if (м.id && ждут.has(м.id)) { ждут.get(м.id)(м); ждут.delete(м.id); } });
    const вызов = (method, params = {}) => new Promise((ok, нет) => {
      const i = ++н; ждут.set(i, м => м.error ? нет(new Error(м.error.message)) : ok(м.result));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const выполнить = async выражение => {
      const р = await вызов('Runtime.evaluate', { expression: выражение, awaitPromise: true, returnByValue: true });
      if (р.exceptionDetails) throw new Error(р.exceptionDetails.exception?.description || р.exceptionDetails.text);
      return р.result.value;
    };
    const пауза = мс => new Promise(r => setTimeout(r, мс));

    await вызов('Page.enable');
    await вызов('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
    await вызов('Page.navigate', { url: `http://localhost:${порт}/?book=${encodeURIComponent(id)}&razbor=1` });
    let готово = false;
    for (let i = 0; i < 150 && !готово; i++) {
      await пауза(100);
      try { готово = await выполнить('typeof razborOpen === "function" && razborOpen() && !!rz.data'); } catch { /* грузится */ }
    }
    if (!готово) throw new Error(`разбор «${id}» не открылся — есть ли у записи razbor.json и поле в book.json?`);
    await выполнить(`(() => {
      const st = document.createElement('style');
      st.textContent = ${JSON.stringify(СНИМОК)};
      document.head.appendChild(st);
      const b = document.createElement('div'); b.id = 'rz-brand'; b.textContent = ${JSON.stringify(ПОДПИСЬ)};
      document.getElementById('razbor').appendChild(b);
      return true; })()`);
    await выполнить('document.fonts.ready.then(() => true)');
    const виды = await выполнить('rz.data.frames.map(f => f.type)');
    const снятые = [];
    for (let i = 0; i < виды.length; i++) {
      if (БЕЗ.includes(виды[i])) continue;
      await выполнить(`(() => { rz.i = ${i}; rzRender(); return true; })()`);
      await выполнить('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))');
      /* Не влез — ужимаем кадр целиком (zoom), пока не войдёт: обрезанный снимок хуже
         чуть меньшего шрифта. Ужали сильнее чем до 80% — говорим: текст кадра пора сократить. */
      const масштаб = await выполнить(`(() => {
        const s = document.getElementById('rz-stage'), f = s.querySelector('.rz-frame');
        let z = 1;
        while (s.scrollHeight - s.clientHeight > 1 && z > 0.6) { z -= 0.02; f.style.zoom = z; }
        return Math.round(z * 100); })()`);
      const лишнее = await выполнить('(() => { const s = document.getElementById("rz-stage"); return s.scrollHeight - s.clientHeight; })()');
      const { data } = await вызов('Page.captureScreenshot', { format: 'png' });
      const имя = `${String(снятые.length + 1).padStart(2, '0')}-${виды[i]}.png`;
      fs.writeFileSync(path.join(куда, имя), Buffer.from(data, 'base64'));
      снятые.push(имя);
      console.log(`  ${имя}${масштаб < 100 ? `  (ужат до ${масштаб}%)` : ''}` +
        `${лишнее > 2 || масштаб < 80 ? '  ⚠ кадр не помещается — сократить его текст' : ''}`);
    }
    ws.close();
    console.log(`готово: ${снятые.length} кадров → ${куда}`);
  } finally {
    стоп();
  }
})().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
