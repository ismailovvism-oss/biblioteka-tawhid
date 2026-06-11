'use strict';

/*
 * Service worker: офлайн-чтение.
 * Стратегия:
 *  - шрифты (Google Fonts) — cache-first (иммутабельны);
 *  - всё остальное GET (свой origin + контент книг, в т.ч. внешний raw github) —
 *    network-first с откатом в кеш: онлайн всегда свежее, офлайн читаем последнее
 *    виденное. Навигация офлайн отдаёт закешированный index.html.
 * Версию бампать при изменении оболочки — старый кеш чистится на activate.
 */

const VERSION = 'chitalka-v12';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'parser.js',
  'app.js',
  'manifest.webmanifest',
  'books/index.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isFont = url => /(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname);
const cacheable = res => res && res.ok && (res.type === 'basic' || res.type === 'cors');

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  // навигации (?book=…&s=…) кешируем под одним ключом index.html — иначе кеш пухнет
  // по записи на каждый URL с query
  const key = req.mode === 'navigate' ? 'index.html' : req;
  try {
    const res = await fetch(req);
    if (cacheable(res)) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(key)) || (req.mode === 'navigate' && await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isFont(url)) event.respondWith(cacheFirst(req));
  else event.respondWith(networkFirst(req));
});
