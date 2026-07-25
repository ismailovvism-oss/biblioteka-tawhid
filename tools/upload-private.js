#!/usr/bin/env node
'use strict';

/*
 * Заливка непубличной книги в бэкенд (BACKEND.md, фаза 2).
 *
 * Использование:
 *   SUPABASE_SERVICE_KEY=… node tools/upload-private.js <папка-книги> --owner <почта> [--paid]
 * Например:
 *   SUPABASE_SERVICE_KEY=sb_secret_… node tools/upload-private.js ~/books/moya --owner me@example.com
 *
 * Что делает: проверяет Контракт валидатором (руками — прогнать до заливки), заливает
 * содержимое папки в приватный бакет `book-content` под префикс `<id>/`, заводит строку
 * в public.books и право доступа owner в public.entitlements. Идемпотентно: повторный
 * запуск перезаливает файлы (upsert) и обновляет запись — так же, как переимпорт книги.
 *
 * Работает под service_role/secret-ключом, который ОБХОДИТ RLS. Ключ берётся только из
 * окружения и никогда не пишется в файлы репозитория — в отличие от publishable-ключа
 * в supabase/config.js, он настоящий секрет. Из браузера этот скрипт не вызывается.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ── аргументы ───────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
let dir = null, ownerEmail = null, visibility = 'private';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--owner') ownerEmail = argv[++i];
  else if (a === '--paid') visibility = 'paid';
  else if (!a.startsWith('--') && !dir) dir = a;
}

if (!dir || !ownerEmail) {
  console.error('Использование: SUPABASE_SERVICE_KEY=… node tools/upload-private.js <папка-книги> --owner <почта> [--paid]');
  process.exit(1);
}

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error('Нет SUPABASE_SERVICE_KEY в окружении (Supabase → Project Settings → API keys → secret).');
  process.exit(1);
}

/* URL проекта берём из того же config.js, что и приложение, чтобы не разъехались */
const cfgSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'config.js'), 'utf8');
const urlMatch = cfgSrc.match(/url:\s*'([^']+)'/);
if (!urlMatch) {
  console.error('В supabase/config.js не нашёлся url проекта.');
  process.exit(1);
}
const URL_BASE = urlMatch[1].replace(/\/+$/, '');

/* ── книга ───────────────────────────────────────────────────────────────── */
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
const bookId = manifest.bookId;
if (!bookId) {
  console.error('В book.json нет bookId.');
  process.exit(1);
}
const prefix = bookId + '/';

// собираем все файлы книги (главы, манифест, media/, img/) — рекурсивно, как лежат
function walk(base, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(base, rel))) {
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(path.join(base, r)).isDirectory()) out.push(...walk(base, r));
    else out.push(r);
  }
  return out;
}
const files = walk(dir);

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
};
const mimeOf = f => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

/* ── запросы ─────────────────────────────────────────────────────────────── */
const head = extra => Object.assign({
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
}, extra || {});

async function req(pathname, opts = {}) {
  const res = await fetch(URL_BASE + pathname, Object.assign({}, opts, { headers: head(opts.headers) }));
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${pathname} → ${res.status}: ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

// почта → uuid пользователя (admin API; пользователь должен быть уже заведён)
async function findUser(email) {
  const list = await req('/auth/v1/admin/users?per_page=200');
  const users = Array.isArray(list) ? list : (list.users || []);
  const u = users.find(x => (x.email || '').toLowerCase() === email.toLowerCase());
  if (!u) throw new Error(`Пользователь ${email} не найден. Заведите его в Supabase → Authentication → Users.`);
  return u.id;
}

async function main() {
  const owner = await findUser(ownerEmail);
  console.log(`Книга ${bookId} → бакет book-content/${prefix} (владелец ${ownerEmail})`);

  for (const rel of files) {
    const body = fs.readFileSync(path.join(dir, rel));
    await req(`/storage/v1/object/${'book-content'}/${prefix}${rel}`, {
      method: 'POST',
      headers: { 'Content-Type': mimeOf(rel), 'x-upsert': 'true' },
      body,
    });
    console.log('  ↑ ' + rel);
  }

  // meta — готовая запись реестра: полка рисует её теми же полями, что и публичные книги
  const meta = {
    title: manifest.title,
    author: manifest.author,
    description: manifest.description,
    langs: manifest.languages,
    category: manifest.category,
    tags: manifest.tags || [],
    authors: manifest.authors || [],
  };

  await req('/rest/v1/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id: bookId, owner, visibility, meta, storage_base: prefix }),
  });

  await req('/rest/v1/entitlements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ user_id: owner, book_id: bookId, source: 'owner' }),
  });

  console.log(`Готово: ${files.length} файлов, книга видна владельцу после входа.`);
}

main().catch(err => { console.error('Ошибка: ' + err.message); process.exit(1); });
