'use strict';

/*
 * ПОДСТРОЧНИК — перевод под каждым словом изучаемого языка.
 *
 * Глоссы ПОСТАВЛЯЮТСЯ ВМЕСТЕ С КНИГОЙ и лежат в её папке: `gloss/<язык>/<глава>.md`,
 * по списку на сектор (SPEC 3.4c). Это часть формата книги, а не личный слой читателя:
 * книга с подстрочником — просто видоизменённая двуязычная книга, где к сектору
 * приложены ещё и пословные подписи.
 *
 * ⚠️ Почему НЕ встроенный словарь (так было до 20.08.2026, откатывать не надо):
 * словарь даёт перевод леммы, а не слова в этом месте. `left` он подписывал как
 * «оставлять» посреди «left hand», `saw` — как «видеть» вместо пилы, `light` — как
 * «свет» вместо «лёгкий». Подстрочник, слепой к предложению, приносит меньше пользы,
 * чем вреда. Глоссы готовит ИИ, видя весь абзац, и пишет их на каждое ВХОЖДЕНИЕ
 * слова отдельно — поэтому одно и то же слово в разных местах сектора может (и
 * должно) получить разный перевод.
 *
 * ⚠️ Глоссу рисует CSS из атрибута: <span class="gl" data-g="карандаш">pencil</span>
 * плюс `.gl[data-g]::after { content: attr(data-g) }`. НЕ <ruby><rt>, и это важно:
 * псевдоэлемент не входит в textContent. От textContent члена пары считаются
 * смещения пометок (selectionOffsets/highlightRange), выделение в режиме перевода
 * (caretOffset/wordAt) и поиск по книге — <ruby> влил бы туда русские слова, и
 * поехало бы всё сразу, включая копирование абзаца в буфер.
 *
 * Файл браузерный (как translate.js): DOM нужен, Node здесь не при чём. Нумерация
 * слов и разбор файла живут в parser.js — они общие с генератором и валидатором.
 */

/* Разобранные главы: "<bookId>/<lang>/<file>" → Map<sectorId, [{n, word, gloss}]> | null.
   null значит «файла нет» — переспрашивать сеть на каждую перерисовку незачем. */
const GL_CHAPTERS = new Map();
const GL_LOADING = new Map();

/*
 * Загрузить подстрочник главы. `fetcher` приходит из app.js (fetchBookText): у
 * приватных книг путь идёт через подписанный URL, и знать об этом движку незачем.
 */
async function glLoadChapter(key, url, fetcher) {
  if (GL_CHAPTERS.has(key)) return GL_CHAPTERS.get(key);
  if (GL_LOADING.has(key)) return GL_LOADING.get(key);
  const p = (async () => {
    let parsed = null;
    try {
      parsed = parseGlossFile(await fetcher(url)).sectors;
    } catch {
      parsed = null;   // подстрочника у главы нет — это норма, а не ошибка
    }
    GL_CHAPTERS.set(key, parsed);
    GL_LOADING.delete(key);
    return parsed;
  })();
  GL_LOADING.set(key, p);
  return p;
}

const glChapter = key => GL_CHAPTERS.get(key) || null;

function glForget() {
  GL_CHAPTERS.clear();
  GL_LOADING.clear();
}

/* ── обход текста члена пары ─────────────────────────────────────────────── */

const GL_SKIP_UPPER = new Set(GLOSS_SKIP_TAGS.map(t => t.toUpperCase()));

function glSkipped(node, root) {
  for (let p = node.parentElement; p && p !== root.parentElement; p = p.parentElement) {
    if (GL_SKIP_UPPER.has(p.tagName)) return true;
    if (p.classList && (p.classList.contains('gl') || p.classList.contains('mt-card'))) return true;
    if (p === root) return false;
  }
  return false;
}

function glTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue || !/\S/.test(n.nodeValue)) continue;
    if (glSkipped(n, root)) continue;
    out.push(n);
  }
  return out;
}

/* Текстовый узел → куски с пометкой «слово / не слово». Тот же Intl.Segmenter, что
   и в glossWords (parser.js): тот считает слова для нумерации, этот режет узел под
   обёртку — и оба обязаны видеть границы слов одинаково. */
function glPieces(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)]
      .map(s => ({ t: s.segment, word: s.isWordLike }));
  }
  const out = [];
  const re = /[\p{L}\p{M}\p{N}_'’-]+/gu;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), word: false });
    out.push({ t: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), word: false });
  return out;
}

/* ── наложение и снятие ──────────────────────────────────────────────────── */

/*
 * Разложить подписи по словам одного члена пары. `entries` — список этого сектора:
 * [{ n, word, gloss }], где n — порядковый номер слова с единицы.
 *
 * Слово из записи служит контрольной суммой: если под номером n в тексте стоит не
 * оно, подпись НЕ ставится. Так правка текста после генерации теряет отдельные
 * подписи, а не сдвигает весь рой на слово вбок — сдвинутую подпись читатель принял
 * бы за перевод и подмены не заметил.
 *
 * Возвращает { placed, skipped }.
 */
function glApplyEntries(root, entries, opts) {
  if (!entries || !entries.length) return { placed: 0, skipped: 0 };
  const showFunc = !!(opts && opts.showFunction);
  const byN = new Map();
  for (const e of entries) {
    /* Стрелка «->12» — намеренно пустая подпись: смысл несёт другое слово, рисовать
       под этим нечего. Строка при этом в файле есть, и это не то же самое, что
       потерянная строка: пустоту видно и глазами, и валидатору.
       Служебные слова по умолчанию не рисуем — плотность решается на показе, в
       данных лежит максимум (показать меньше бесплатно, больше — перегенерация). */
    if (e.carrier !== null && e.carrier !== undefined) continue;
    if (!e.gloss) continue;
    if (e.cls === 'f' && !showFunc) continue;
    byN.set(e.n, e);
  }
  if (!byN.size) return { placed: 0, skipped: 0 };
  let idx = 0;              // сквозной номер слова в секторе
  let placed = 0, skipped = 0;

  for (const node of glTextNodes(root)) {
    const pieces = glPieces(node.nodeValue);
    if (!pieces.some(p => p.word)) continue;

    const text = node.nodeValue;
    let frag = null;
    let consumed = 0;       // сколько символов узла уже перенесено во фрагмент
    let pos = 0;

    for (const piece of pieces) {
      const start = pos;
      pos += piece.t.length;
      if (!piece.word) continue;
      idx++;
      const e = byN.get(idx);
      if (!e) continue;
      if (e.word.toLowerCase() !== piece.t.toLowerCase()) { skipped++; continue; }

      /* Хвостовую пунктуацию забираем внутрь обёртки. Ячейка подписанного слова шире
         самого слова (её ширина = max(слово, глосса)), и запятая, оставшись снаружи,
         отъезжала от своего слова: «twice :», «One . On». Пробел не трогаем — по нему
         строка переносится. */
      let end = pos;
      while (end < text.length && /[^\s\p{L}\p{N}]/u.test(text[end])) end++;

      if (!frag) frag = document.createDocumentFragment();
      if (start > consumed) frag.appendChild(document.createTextNode(text.slice(consumed, start)));
      const span = document.createElement('span');
      span.className = 'gl';
      span.dataset.g = e.gloss;
      span.dataset.n = String(idx);
      if (e.cls) span.dataset.cls = e.cls;
      if (e.level) span.dataset.lvl = String(e.level);
      span.textContent = text.slice(start, end);
      frag.appendChild(span);
      consumed = end;
      placed++;
    }

    if (frag) {
      if (consumed < text.length) frag.appendChild(document.createTextNode(text.slice(consumed)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  return { placed, skipped };
}

/* Снять подстрочник. normalize() обязателен: иначе текст остаётся нарезанным на
   куски, и каждое следующее наложение дробит его дальше. */
function glClear(root) {
  const spans = root.querySelectorAll('span.gl');
  if (!spans.length) return;
  for (const s of spans) s.replaceWith(document.createTextNode(s.textContent));
  root.normalize();
}
