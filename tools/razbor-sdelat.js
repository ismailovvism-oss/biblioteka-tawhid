#!/usr/bin/env node
'use strict';

/*
 * «Ясный разбор» сам (SPEC 3.4h): готовит books/<id>/razbor.json по тексту статьи, сверяет
 * его и подключает к записи. Зовётся конвертером статей (~/projects/tools/statya/в-читалку.py)
 * при каждой выкладке — так разбор выходит вместе со статьёй (решение хозяина 22.11.2026).
 *
 *   node tools/razbor-sdelat.js books/<id> [--заново] [--модель sonnet] [--проба]
 *
 *   --заново  сделать заново, даже если разбор есть и сходится со статьёй
 *   --модель  модель для `claude -p` (по умолчанию sonnet; можно RAZBOR_MODEL=…)
 *   --проба   ничего не записывать: положить разбор во временную папку и сказать, куда
 *
 * Когда ничего не делает (и говорит почему): запись не статья (разбор показывается только у
 * статей); министатья, у которой есть полная статья (`brief` в реестре — разбор темы у полной);
 * разбор уже есть и сходится с текстом (переделывается, только если статью поправили так, что
 * старый разбор с ней разошёлся — иначе он сломал бы выкладку: validate.js его не пропустит).
 *
 * Как пишет: кадры составляет модель через `claude -p` (подписка, без ключа в проекте).
 * ⚠ Арабский модель НЕ набирает: все арабские места статьи пронумерованы (A1, A2…), модель
 * ссылается на номер, а текст вырезает отсюда, из файла главы, — огласовки и порядок слов
 * не могут поплыть. Слова автора (позиция, оговорка, итог, ответ на возражение) модель
 * копирует; что не нашлось в статье дословно — печатается для глаз. Проверка — та же
 * razborCheck, что в validate.js; не прошла — вторая попытка с перечнем ошибок.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildChapter, razborCheck, razborCounts } = require(path.join(__dirname, '..', 'parser.js'));

const КОРЕНЬ = path.join(__dirname, '..');
const арг = process.argv.slice(2);
const флаг = имя => { const i = арг.indexOf(имя); if (i < 0) return false; арг.splice(i, 1); return true; };
const опция = (имя, по) => { const i = арг.indexOf(имя); return i >= 0 ? арг.splice(i, 2)[1] : по; };
const ЗАНОВО = флаг('--заново');
const ПРОБА = флаг('--проба');
const МОДЕЛЬ = опция('--модель', process.env.RAZBOR_MODEL || 'sonnet');
const папка = арг[0] && path.resolve(арг[0]);
if (!папка) { console.error('Использование: node tools/razbor-sdelat.js books/<id> [--заново] [--модель sonnet] [--проба]'); process.exit(2); }
const id = path.basename(папка);
const читать = п => JSON.parse(fs.readFileSync(п, 'utf8'));

// ── запись и решение, делать ли ─────────────────────────────────────────────
const манифест = читать(path.join(папка, 'book.json'));
const реестр = читать(path.join(КОРЕНЬ, 'books', 'index.json')).books || [];
const запись = реестр.find(з => з.id === id) || {};
const мини = (запись.genre || []).includes('Краткий ответ');
const готово = (что) => { console.log(`разбор «${id}»: ${что}`); process.exit(0); };
if (запись.kind !== 'article') готово('запись не статья — разбор показывается только у статей, не делаю');
const полная = реестр.find(з => з.brief === id);
if (мини && полная) готово(`у министатьи есть полная статья «${полная.id}» — разбор темы у неё, не делаю`);

// ── статья: секторы по главам и арабские места ──────────────────────────────
const ЯЗ = (манифест.languages || ['ru'])[0];
const АРАБ = '؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿';
const МЕСТО = new RegExp(`[${АРАБ}][${АРАБ}\\u200c\\u200d \\t.,:;!?«»"'()\\[\\]\\-–—0-9٠-٩]*[${АРАБ}]`, 'gu');
const арабские = [];        // { n, текст, c, s }
const главы = [];           // { c, title, блоки:[{ id, текст }] }
let исходник = '';
const секторы = new Map();
манифест.chapters.forEach((гл, k) => {
  if (!гл.file) return;
  const c = k + 1;
  let сырьё = '';
  try { сырьё = fs.readFileSync(path.join(папка, ЯЗ, гл.file), 'utf8'); } catch { return; }
  исходник += сырьё + '\n';
  const { pairs } = buildChapter({ [ЯЗ]: сырьё }, [ЯЗ]);
  секторы.set(c, new Set(pairs.filter(p => p.type === 'text').map(p => p.id)));
  const блоки = [];
  const куски = сырьё.split(/<!--\s*(s\d+[a-z]?|fn\d+)\s*-->/);
  for (let i = 1; i < куски.length; i += 2) {
    const метка = куски[i].replace(/^(s\d+)[a-z]$/, '$1');
    let текст = куски[i + 1].replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!текст) continue;
    текст = текст.replace(МЕСТО, м => {
      const чистое = м.replace(/^[^\p{L}]+|[^\p{L}\p{M}]+$/gu, '');
      if (чистое.split(/\s+/).length < 2) return м;
      const n = арабские.length + 1;
      арабские.push({ n, текст: чистое, c, s: метка });
      return м.replace(чистое, `⟦A${n} ${чистое}⟧`);
    });
    const было = блоки.find(б => б.id === метка);
    if (было) было.текст += '\n' + текст; else блоки.push({ id: метка, текст });
  }
  const title = (гл.title && (гл.title[ЯЗ] || Object.values(гл.title)[0])) || гл.file;
  главы.push({ c, title, блоки });
});

const проверить = данные => razborCheck(данные, {
  chapters: манифест.chapters,
  sectors: c => секторы.get(c) || null,
  source: исходник,
  media: п => fs.existsSync(path.join(папка, п)),
});

const файл = path.join(папка, 'razbor.json');
if (fs.existsSync(файл) && !ЗАНОВО) {
  let ошибки;
  try { ошибки = проверить(читать(файл)); } catch (e) { ошибки = [`не читается: ${e.message}`]; }
  if (!ошибки.length) { подключить(); готово('уже есть и сходится со статьёй — оставляю'); }
  console.log(`разбор «${id}» разошёлся со статьёй (${ошибки.length} ошибок, первая: ${ошибки[0]}) — делаю заново`);
}

// ── запрос к модели ─────────────────────────────────────────────────────────
const spec = (() => {
  const т = fs.readFileSync(path.join(КОРЕНЬ, 'SPEC.md'), 'utf8');
  const н = т.indexOf('### 3.4h');
  const к = т.indexOf('\n### ', н + 10);
  return т.slice(н, к > 0 ? к : undefined);
})();
// образец — готовый разбор ДРУГОЙ записи: со своим разбором перед глазами модель его и перепишет
const образецИд = (мини ? ['otvet-murtadd', 'otvet-myaso'] : ['fatiha', 'posuda']).find(x => x !== id);
const образец = fs.readFileSync(path.join(КОРЕНЬ, 'books', образецИд, 'razbor.json'), 'utf8');
const сколько = мини ? '4–5' : '6–10';
const названиеСтатьи = (манифест.title && (манифест.title[ЯЗ] || Object.values(манифест.title)[0])) || id;

const статьяТекстом = главы.map(г =>
  `## Глава c=${г.c}: ${г.title}\n\n` + г.блоки.map(б => `[${б.id}] ${б.текст}`).join('\n\n')).join('\n\n');

const правила = `Ты готовишь «Ясный разбор» — подачу готовой статьи по шагам, кадрами во весь экран телефона, для исламской библиотеки автора Исмаила Абу Хаммада. Ответ — только JSON файла разбора, без пояснений и без \`\`\`.

ФОРМАТ — раздел спецификации ниже (виды кадров и их поля). Верх файла: {"v":1,"lang":"ru","title":"${названиеСтатьи.replace(/"/g, '\\"')}","sub":"Ясный разбор","frames":[…]}.

ПРАВИЛА (нарушение = брак):
1. Кадров содержания ${сколько}, не считая первого «question» и необязательного последнего «next». Ход: question → position → proof… → objection… → summary → caveat → check → next. Главный вопрос статьи и главный вывод автора — не второстепенные.
2. «position».text, «caveat».text, «summary».quote, «objection».answer.text — СЛОВАМИ АВТОРА: копируй предложения из статьи. Можно сократить (выбросить часть предложения или целые предложения), нельзя перефразировать, усиливать вывод или добавлять своё. Своими словами — только title, question.text, note (одна строка пояснения), claim.text (чужое мнение, как его излагает статья), fork и тексты вариантов и пояснений в «check» (опираясь на слова статьи).
3. АРАБСКИЙ НЕ НАБИРАЙ. Все арабские места статьи помечены ⟦An текст⟧. В поле "ar" (у proof, claim, answer) пиши только номер: "ar": "A12". Нужна часть места — добавь "ar_from" и "ar_to": первое и последнее слово нужного куска, скопированные из этого места (без огласовок можно). Бери коротко — ключевая фраза довода (1–2 строки). "quran": true — только у аята. Перевод "tr" — из статьи, к той же фразе; "ref" — адрес, как его даёт статья.
4. У кадров position, proof, objection, caveat, summary — "src": {"c": номер главы (как в заголовке «Глава c=…»), "s": "сектор"} — откуда кадр взят. Сектор — метка в квадратных скобках перед абзацем, вида s012; метки fnN (сноски) в src не ставить.
5. Кадр «caveat» обязателен, если статья говорит об иджтихаде, разногласии учёных или границах вывода (kind: ijtihad | khilaf | limits). Доводы другой стороны, которые статья разбирает, — кадрами «objection».
6. «check» — один вопрос-случай на понимание статьи, 2–3 варианта, ровно один "ok": true, у каждого "why".
7. Коротко: кадр должен влезать в экран телефона. Позиция — до ~60 слов, пояснение — одна строка. Поле "say" не ставить. Ссылки «next» — на главы и секторы этой статьи.
8. Ничего, чего нет в статье: это подача статьи, не новое исследование.

Образец готового разбора (в нём арабский уже вставлен текстом — в твоём ответе вместо текста номер "A…"):
${образец}

СПЕЦИФИКАЦИЯ:
${spec}`;

function спросить(подсказка) {
  const р = spawnSync('claude', ['-p', '--model', МОДЕЛЬ, '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--output-format', 'json',
    '--system-prompt', 'Ты аккуратный редактор исламской библиотеки. Отвечаешь только JSON.'],
  { input: подсказка, encoding: 'utf8', cwd: os.tmpdir(), timeout: 15 * 60 * 1000, maxBuffer: 64 << 20 });
  if (р.error) throw new Error(`claude не запустился: ${р.error.message}`);
  let ответ;
  try { ответ = JSON.parse(р.stdout); } catch { throw new Error(`claude ответил не JSON: ${(р.stdout || р.stderr || '').slice(0, 300)}`); }
  if (ответ.is_error) throw new Error(`claude: ${String(ответ.result || ответ.subtype).slice(0, 300)}`);
  const т = String(ответ.result || '');
  const н = т.indexOf('{'), к = т.lastIndexOf('}');
  if (н < 0 || к < н) throw new Error('в ответе нет JSON');
  return JSON.parse(т.slice(н, к + 1));
}

// ── арабский: номер места → дословный текст из статьи ──────────────────────
const голое = с => с.normalize('NFC').replace(/[ً-ٰٟۖ-ۭـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}]/gu, '');
const замечания = [];
function вставитьАрабский(узел, где) {
  if (!узел || typeof узел.ar !== 'string') return;
  const м = /^A(\d+)$/.exec(узел.ar.trim());
  const от = узел.ar_from, до = узел.ar_to;
  delete узел.ar_from; delete узел.ar_to;
  if (!м) return;   // не номер — оставим как есть, razborCheck сверит со статьёй
  const место = арабские[+м[1] - 1];
  if (!место) { замечания.push(`${где}: арабского места A${м[1]} нет`); return; }
  const слова = место.текст.split(/(\s+)/);          // слова и пробелы, чтобы склеить как было
  const только = слова.filter((_, i) => i % 2 === 0);
  const голые = только.map(голое);
  // «с» — слово или несколько слов подряд; ищем, где они стоят в месте (без огласовок)
  const найти = (с, с_какого, сзади) => {
    const кусок = String(с).trim().split(/\s+/).map(голое).filter(Boolean);
    if (!кусок.length) return -1;
    const подходит = n => кусок.every((x, k) => голые[n + k] === x);
    if (сзади) { for (let n = голые.length - кусок.length; n >= с_какого; n--) if (подходит(n)) return n + кусок.length - 1; }
    else for (let n = с_какого; n + кусок.length <= голые.length; n++) if (подходит(n)) return n;
    return -1;
  };
  let i = 0, j = только.length - 1;
  if (от) { const k = найти(от, 0, false); if (k >= 0) i = k; else замечания.push(`${где}: «${от}» не нашлось в A${м[1]} — взято место с начала`); }
  if (до) { const k = найти(до, i, true); if (k >= 0) j = k; else замечания.push(`${где}: «${до}» не нашлось в A${м[1]} — взято место до конца`); }
  узел.ar = слова.slice(i * 2, j * 2 + 1).join('').replace(/^[^\p{L}]+|[^\p{L}\p{M}]+$/gu, '');
}

// ── слова автора: что не нашлось в статье дословно ─────────────────────────
const плоско = с => с.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const статьяПлоско = ' ' + плоско(исходник.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[\^\d+\]/g, ' ')) + ' ';
function словаАвтора(данные) {
  const мимо = [];
  const смотреть = (т, где) => {
    if (typeof т !== 'string') return;
    for (const кусок of т.split(/[.!?;:—–«»"()]+|,\s/)) {
      const п = плоско(кусок);
      if (п.split(' ').length >= 4 && !статьяПлоско.includes(' ' + п + ' ')) мимо.push(`${где}: «${кусок.trim().slice(0, 80)}»`);
    }
  };
  (данные.frames || []).forEach((f, n) => {
    const где = `кадр ${n + 1} (${f.type})`;
    if (f.type === 'position' || f.type === 'caveat') смотреть(f.text, где);
    if (f.type === 'summary') смотреть(f.quote, где);
    if (f.type === 'objection' && f.answer) смотреть(f.answer.text, где);
  });
  return мимо;
}

function своиОшибки(данные) {
  const о = [];
  const кадры = данные.frames || [];
  if (!кадры.length || кадры[0].type !== 'question') о.push('первый кадр должен быть «question»');
  const содержания = кадры.filter(f => f.type !== 'question' && f.type !== 'next').length;
  const [мин, макс] = мини ? [4, 5] : [6, 10];
  if (содержания < мин - 1 || содержания > макс + 1) о.push(`кадров содержания ${содержания}, нужно ${мин}–${макс}`);
  if (!кадры.some(f => f.type === 'check')) о.push('нет кадра «check»');
  if (/иджтихад|разноглас|расхожд/i.test(исходник) && !кадры.some(f => f.type === 'caveat'))
    о.push('статья говорит об иджтихаде или разногласии — нужен кадр «caveat»');
  return о;
}

// ── попытки ────────────────────────────────────────────────────────────────
let данные = null, ошибки = [], мимо = [], прошлый = '';
for (let попытка = 1; попытка <= 2; попытка++) {
  const подсказка = `${правила}\n\nСТАТЬЯ «${названиеСтатьи}»${мини ? ' (министатья — краткий ответ)' : ''}:\n\n${статьяТекстом}` +
    (попытка > 1 ? `\n\nПРОШЛЫЙ ОТВЕТ:\n${прошлый}\n\nВ НЁМ ОШИБКИ — исправь их и верни весь файл заново:\n- ${[...ошибки, ...мимо.map(м => 'не дословно из статьи: ' + м)].join('\n- ')}` : '');
  console.log(`разбор «${id}»: попытка ${попытка}, модель ${МОДЕЛЬ}…`);
  let ответ;
  try { ответ = спросить(подсказка); } catch (e) { ошибки = [e.message]; continue; }
  прошлый = JSON.stringify(ответ);
  замечания.length = 0;
  (ответ.frames || []).forEach((f, n) => {
    вставитьАрабский(f, `кадр ${n + 1}`);
    if (f && f.claim) вставитьАрабский(f.claim, `кадр ${n + 1}, довод`);
    if (f && f.answer) вставитьАрабский(f.answer, `кадр ${n + 1}, ответ`);
    if (f) delete f.say;
    // слова автора часто взяты с середины предложения — кадр начинается с заглавной
    const заглавная = т => typeof т === 'string' ? т.replace(/^([^\p{L}]*)(\p{Ll})/u, (_, a, b) => a + b.toUpperCase()) : т;
    if (f) for (const k of ['title', 'text', 'quote', 'note']) if (f[k]) f[k] = заглавная(f[k]);
    for (const k of ['claim', 'answer']) if (f && f[k] && f[k].text) f[k].text = заглавная(f[k].text);
  });
  ошибки = [...своиОшибки(ответ), ...проверить(ответ)];
  мимо = словаАвтора(ответ);
  данные = ответ;
  if (!ошибки.length && мимо.length <= 2) break;
}

if (!данные || ошибки.length) {
  console.error(`разбор «${id}» не получился:\n  • ${ошибки.join('\n  • ')}`);
  if (данные) { const ч = path.join(os.tmpdir(), `razbor-${id}-черновик.json`); fs.writeFileSync(ч, JSON.stringify(данные, null, 2)); console.error(`черновик: ${ч}`); }
  process.exit(1);
}

const текст = JSON.stringify({ v: 1, lang: 'ru', title: названиеСтатьи, sub: 'Ясный разбор', ...данные }, null, 2) + '\n';
if (ПРОБА) {
  const п = path.join(os.tmpdir(), `razbor-${id}.json`);
  fs.writeFileSync(п, текст);
  console.log(`проба: ${п}`);
} else {
  if (fs.existsSync(файл)) { const ст = path.join(os.tmpdir(), `razbor-${id}-прежний-${Date.now()}.json`); fs.copyFileSync(файл, ст); console.log(`прежний разбор сохранён: ${ст}`); }
  fs.writeFileSync(файл, текст);
  подключить();
}
const { frames, words } = razborCounts(данные);
console.log(`разбор «${id}»: кадров ${frames}, слов ${words}${ПРОБА ? '' : ' → ' + path.relative(КОРЕНЬ, файл)}`);
for (const з of замечания) console.log('  ⚠ ' + з);
if (мимо.length) {
  console.log('  ⚠ слова автора не нашлись в статье дословно — посмотреть глазами:');
  for (const м of мимо) console.log('    – ' + м);
}
console.log('  арабский вырезан из текста статьи; проверка кадров (как в validate.js) ✓');

/** "razbor": "razbor.json" в book.json, если его там нет. */
function подключить() {
  if (ПРОБА || манифест.razbor) return;
  const п = path.join(папка, 'book.json');
  const м = читать(п);
  м.razbor = 'razbor.json';
  fs.writeFileSync(п, JSON.stringify(м, null, 2));   // как пишет конвертер: без перевода строки в конце
  console.log('  в book.json добавлено "razbor": "razbor.json"');
}
