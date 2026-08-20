#!/usr/bin/env node
'use strict';

/*
 * ГЕНЕРАТОР ПОДСТРОЧНИКА — готовит `<книга>/gloss/<язык>/<глава>.md` (SPEC 3.4c).
 *
 * Это НЕ конвертер формата: текст книги он не трогает вообще. Он готовит ДАННЫЕ —
 * пословные подписи, которых в исходнике нет и взяться им неоткуда, кроме как от
 * ИИ, читающего каждый абзац целиком.
 *
 * ⚠️ Нумерация слов берётся из parser.js (`glossTokens`) — той же функцией её считает
 * читалка при расстановке подписей и валидатор при проверке. Своей нумерации здесь
 * нет и заводить её нельзя: разойдись они на одно слово, и рой съедет по всему
 * сектору, причём незаметно — подпись под чужим словом читается как перевод.
 *
 * ⚠️ Перегенерация НЕ бесплатна по смыслу, а не только по деньгам. На трёх прогонах
 * одного сектора одной моделью структура (номера, слова, классы) совпала полностью,
 * а сами подписи разошлись примерно в каждой шестой строке — синонимами («разделения»
 * против «разлуки»). Поэтому по умолчанию трогаем только те секторы, чей хеш не сошёлся:
 * иначе диффы шумят на ровном месте, а выверка человеком (`ok`) слетает пачками.
 *
 * Режимы:
 *   --prompt [глава.md] [--sector sNNN]   напечатать запросы для ручной прогонки
 *   --apply  <глава.md>  < ответ.txt      вклеить ответ модели
 *   --run    [глава.md]                   спросить модель самому (ANTHROPIC_API_KEY)
 *   --force                               перегенерировать и непротухшие секторы
 *
 * ⚠️ Обращение к API — голым fetch, без официального SDK: в репозитории нет
 * package.json и ни одной npm-зависимости (CLAUDE.md, правило «без зависимостей»),
 * а тянуть node_modules ради одного POST — плохой обмен. Появится package.json —
 * этот кусок стоит переписать на @anthropic-ai/sdk.
 */

const fs = require('fs');
const path = require('path');
const {
  buildChapter, glossTokens, glossHash, glossPrompt, glossNormalizeBase, parseGlossFile,
} = require(path.join(__dirname, '..', 'parser.js'));

const MODEL = 'claude-opus-5';
const API = 'https://api.anthropic.com/v1/messages';

/* ── аргументы ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const dir = argv[0];
const flag = name => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

if (!dir || dir.startsWith('--')) {
  console.error(`Использование:
  node tools/gloss-book.js <папка книги> --lang <язык> --prompt [глава.md] [--sector sNNN]
  node tools/gloss-book.js <папка книги> --lang <язык> --apply <глава.md> < ответ.txt
  node tools/gloss-book.js <папка книги> --lang <язык> --run [глава.md] [--force]`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
const lang = (!flag('lang') || flag('lang') === true)
  ? manifest.languages.find(l => l !== 'ru') || manifest.languages[0]
  : flag('lang');
if (!manifest.languages.includes(lang)) {
  console.error(`В книге нет языка «${lang}». Есть: ${manifest.languages.join(', ')}`);
  process.exit(1);
}

/* ── чтение главы ────────────────────────────────────────────────────────── */

// Только текст-секторы нужного языка: у сносок своя нумерация и свой язык,
// подстрочник к ним пока не готовим.
function sectorsOf(file) {
  const texts = {};
  for (const l of manifest.languages) {
    try { texts[l] = fs.readFileSync(path.join(dir, l, file), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; texts[l] = ''; }
  }
  const { pairs } = buildChapter(texts, manifest.languages);
  return pairs
    .filter(p => p.type === 'text' && p[lang])
    .map(p => ({ id: p.id, html: p[lang], hash: glossHash(p[lang]), tokens: glossTokens(p[lang]) }));
}

function chapterFiles() {
  const only = ['prompt', 'apply', 'run']
    .map(f => flag(f))
    .find(v => v && v !== true);
  const files = manifest.chapters.filter(c => c.file).map(c => c.file);
  if (!only) return files;
  if (!files.includes(only)) {
    console.error(`В книге нет главы «${only}». Есть: ${files.join(', ')}`);
    process.exit(1);
  }
  return [only];
}

const glossPath = file => path.join(dir, 'gloss', lang, file);

// то, что уже лежит в файле: чтобы не перегенерировать непротухшее и не терять «ok»
function existing(file) {
  try { return parseGlossFile(fs.readFileSync(glossPath(file), 'utf8')).sectors; }
  catch { return new Map(); }
}

/* ── разбор ответа модели ────────────────────────────────────────────────── */

/*
 * Ответ модели → записи сектора, сверенные с нумерацией. Модель ошибается двумя
 * способами: путает номер и переписывает слово. Обе ошибки ловятся здесь, потому
 * что запись обязана совпасть со словом, которое реально стоит под этим номером.
 * Молча пропустить такую строку нельзя — подпись встанет под чужим словом.
 */
function parseReply(reply, id, tokens) {
  const text = String(reply).replace(/^```[a-z]*\s*$/gim, '');
  const lines = text.split(/\r?\n/);

  // такт 1: рабочий перевод. Кладём в файл комментарием — он не показывается
  // читателю никогда, но без него выверку сектора делать вслепую.
  const head = lines.find(l => /^\s*ПЕРЕВОД\s*:/i.test(l));
  const draft = head ? head.replace(/^\s*ПЕРЕВОД\s*:\s*/i, '').replace(/[<>]/g, ' ').trim() : '';

  const body = lines.filter(l => !/^\s*ПЕРЕВОД\s*:/i.test(l)).join('\n');
  const { sectors, warnings } = parseGlossFile(`<!-- ${id} -->\n${body}`);
  const raw = sectors.get(id);
  const good = [];
  const bad = warnings.slice();

  for (const e of (raw ? raw.entries : [])) {
    const tok = tokens[e.n - 1];
    if (!tok) { bad.push(`${e.n} ${e.word}: такого номера в секторе нет`); continue; }
    if (tok.word.toLowerCase() !== e.word.toLowerCase()) {
      bad.push(`${e.n}: в тексте «${tok.word}», модель прислала «${e.word}»`);
      continue;
    }
    if (!e.gloss && e.carrier == null) { bad.push(`${e.n} ${e.word}: пустая подпись без ссылки`); continue; }
    // огласовки снимаем кодом: просить модель писать единообразно недостаточно,
    // на трёх прогонах она дала и «توقع», и «توقّع»
    if (e.base) e.base = glossNormalizeBase(e.base);
    good.push(e);
  }
  good.sort((a, b) => a.n - b.n);
  return { good: resolveArrows(good, bad), bad, draft };
}

/*
 * Схлопывание цепочек стрелок.
 *
 * Модель охотно пишет «4 -> 6», где у слова 6 тоже стоит стрелка. Формально это
 * не ложь, но читателю такая запись не даёт ничего, а валидатор справедливо
 * ругается: смысл в итоге не несёт никто. Идём по цепочке до слова с настоящей
 * подписью и переставляем стрелку прямо на него.
 *
 * Если конца у цепочки нет (кольцо или всё пусто) — строку выбрасываем совсем.
 * Слово без строки это законно: не всякое слово оригинала обязано что-то значить
 * по-русски. А стрелка в никуда — брак.
 */
function resolveArrows(entries, bad) {
  const byN = new Map(entries.map(e => [e.n, e]));
  const out = [];
  for (const e of entries) {
    if (e.carrier == null) { out.push(e); continue; }
    let cur = byN.get(e.carrier);
    const seen = new Set([e.n]);
    while (cur && !cur.gloss && cur.carrier != null && !seen.has(cur.n)) {
      seen.add(cur.n);
      cur = byN.get(cur.carrier);
    }
    if (cur && cur.gloss) {
      if (cur.n !== e.carrier) e.carrier = cur.n;   // переставили на конец цепочки
      out.push(e);
    } else {
      bad.push(`${e.n} ${e.word}: стрелка в никуда, строка убрана`);
    }
  }
  return out;
}

/* ── запись файла ────────────────────────────────────────────────────────── */

function line(e) {
  const body = e.carrier != null ? `->${e.carrier}` : e.gloss;
  const meta = e.base ? ` :: ${e.base}${e.level ? ' ' + e.level : ''}` : '';
  return `${e.n}${e.cls || ''} ${e.word} ${body}${meta}`;
}

function renderGlossFile(sectors) {
  const out = [
    '<!-- Подстрочник (SPEC 3.4c). Сгенерировано tools/gloss-book.js.',
    '     Номер — порядковый номер слова в секторе, он обязан совпадать с текстом.',
    '     h=… — хеш слов на момент генерации; ok — сектор выверен человеком.',
    '     Строка «ru:» — рабочий перевод модели, из которого разложены подписи;',
    '     читателю он не показывается, он нужен тому, кто выверяет. -->',
    '',
  ];
  for (const s of sectors) {
    if (!s.entries.length) continue;
    out.push(`<!-- ${s.id} h=${s.hash}${s.verified ? ' ok' : ''} -->`);
    if (s.draft) out.push(`<!-- ru: ${s.draft} -->`);
    for (const e of s.entries) out.push(line(e));
    out.push('');
  }
  return out.join('\n');
}

function writeGloss(file, sectors) {
  const p = glossPath(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderGlossFile(sectors));
  const words = sectors.reduce((n, s) => n + s.entries.length, 0);
  const ok = sectors.filter(s => s.verified).length;
  console.log(`  ${p}: секторов ${sectors.filter(s => s.entries.length).length}, подписей ${words}, выверено ${ok}`);
}

/* ── обращение к модели ──────────────────────────────────────────────────── */

async function ask(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('нужен ANTHROPIC_API_KEY в окружении');
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('модель отказалась отвечать');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

/* ── режимы ──────────────────────────────────────────────────────────────── */

const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };

/*
 * Что оставить как есть, а что перегенерировать. Сектор трогаем, только если его
 * хеш разошёлся с текстом (или файла ещё нет). Совпал — переносим прежние подписи
 * вместе с флагом выверки: перегенерация ради перегенерации меняет синонимы и
 * обнуляет чужую работу по проверке.
 */
function plan(file, force) {
  const prev = existing(file);
  return sectorsOf(file).map(s => {
    const old = prev.get(s.id);
    const fresh = old && old.hash === s.hash && old.entries.length;
    return {
      id: s.id, html: s.html, hash: s.hash, tokens: s.tokens,
      keep: !!fresh && !force,
      old,
    };
  });
}

function kept(job) {
  return {
    id: job.id, hash: job.hash, verified: job.old.verified,
    draft: job.old.draft || '', entries: job.old.entries,
  };
}

async function main() {
  const files = chapterFiles();
  const force = !!flag('force');

  if (flag('prompt')) {
    const want = flag('sector');
    for (const file of files) {
      for (const s of sectorsOf(file)) {
        if (want && want !== true && s.id !== want) continue;
        if (!want) console.log(`\n═══ ${file} · ${s.id} ═══\n`);
        console.log(glossPrompt(s.html, lang));
      }
    }
    return;
  }

  if (flag('apply')) {
    const file = files[0];
    const reply = readStdin();
    if (!reply.trim()) { console.error('Пусто на входе: ответ модели подаётся через stdin'); process.exit(1); }
    /* Режем ответ по якорям сами, а не через parseGlossFile: в сыром ответе есть
       строки «ПЕРЕВОД: …» — рабочий перевод такта 1, который парсер файла законно
       не знает и пометил бы как мусор. Разбирать сырой ответ умеет parseReply. */
    const chunks = new Map();
    let curId = null, buf = [];
    for (const raw of reply.split(/\r?\n/)) {
      const m = raw.trim().match(/^<!--\s*(s\d+)[^>]*-->$/);
      if (m) { if (curId) chunks.set(curId, buf.join('\n')); curId = m[1]; buf = []; continue; }
      if (curId) buf.push(raw);
    }
    if (curId) chunks.set(curId, buf.join('\n'));

    const out = [];
    let bad = 0;
    for (const job of plan(file, force)) {
      /* Сектор не протух — оставляем как есть, даже если в ответе он есть.
         Иначе повторная вклейка обнуляет чужую выверку и меняет подписи на
         синонимы: на трёх прогонах одного сектора модель разошлась в каждой
         шестой строке. Перегенерировать непротухшее — только с --force. */
      if (job.keep) { out.push(kept(job)); continue; }
      const chunk = chunks.get(job.id);
      if (!chunk) { out.push(job.old ? kept(job) : { ...job, entries: [], verified: false, draft: '' }); continue; }
      const checked = parseReply(chunk, job.id, job.tokens);
      checked.bad.forEach(b => { console.error(`  ⚠ ${job.id}: ${b}`); bad++; });
      // перегенерация обнуляет выверку: проверяли не этот текст
      out.push({ id: job.id, hash: job.hash, verified: false, draft: checked.draft, entries: checked.good });
    }
    writeGloss(file, out);
    if (bad) console.error(`  отброшено строк: ${bad}`);
    return;
  }

  if (flag('run')) {
    for (const file of files) {
      console.log(`${file}:`);
      const out = [];
      for (const job of plan(file, force)) {
        if (job.keep) { out.push(kept(job)); console.log(`  ${job.id}: без изменений`); continue; }
        if (!job.tokens.length) { out.push({ ...job, entries: [], verified: false, draft: '' }); continue; }
        const { good, bad, draft } = parseReply(await ask(glossPrompt(job.html, lang)), job.id, job.tokens);
        bad.forEach(b => console.error(`  ⚠ ${job.id}: ${b}`));
        out.push({ id: job.id, hash: job.hash, verified: false, draft, entries: good });
        console.log(`  ${job.id}: ${good.length}/${job.tokens.length}`);
      }
      writeGloss(file, out);
    }
    return;
  }

  console.error('Укажите режим: --prompt, --apply или --run');
  process.exit(1);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
