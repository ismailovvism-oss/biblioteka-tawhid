'use strict';

/*
 * supabase/client.js — тонкий клиент бэкенда «Библиотеки Таухид» (BACKEND.md).
 *
 * Почему не официальный SDK: у проекта нет сборки, всё грузится тегами <script> и
 * должно работать офлайн из кеша SW. Нам нужны ровно четыре вещи — вход по ссылке
 * на почту, обновление токена, чтение таблиц (PostgREST) и подписанный URL объекта
 * в бакете. Это несколько fetch'ей, ради них тянуть бандл не за чем.
 *
 * Наружу выставляется один объект `window.SB`. Никакой работы с DOM: показ состояния
 * и полка — забота app.js. Ключей-секретов здесь нет: publishable-ключ публичен, доступ
 * решают RLS-политики (supabase/schema.sql).
 *
 * Поток входа — implicit: на POST /auth/v1/otp Supabase шлёт письмо со ссылкой на свой
 * /auth/v1/verify, тот редиректит на наш redirect_to и кладёт токены во фрагмент URL
 * (#access_token=…&refresh_token=…). consumeAuthCallback() снимает их и чистит адрес.
 */

window.SB = (function () {
  const CFG = window.SUPABASE_CONFIG || {};
  const KEY = 'chitalka:auth';          // где лежит сессия (та же семья ключей, что и настройки)
  const SIGN_TTL = 3600;                // сек: время жизни подписанного URL книги
  const SKEW = 60;                      // сек: обновляем токен заранее, не в упор к сроку

  const configured = () => Boolean(CFG.url && CFG.anonKey);

  /* ── сессия ────────────────────────────────────────────────────────────────
     Храним в localStorage: PWA переживает перезапуск, а вход по ссылке с почты
     переживает возврат в приложение. sessionStorage тут не годится. */
  let session = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return s && s.access_token ? s : null;
    } catch { return null; }
  }
  function save(s) {
    session = s;
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch { /* приватный режим браузера — живём сессией в памяти */ }
  }

  // GoTrue отдаёт expires_in (сек от «сейчас»); переводим в абсолютный момент
  function normalize(raw) {
    if (!raw || !raw.access_token) return null;
    const secs = Number(raw.expires_in) || 3600;
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token || null,
      expires_at: raw.expires_at ? Number(raw.expires_at) * 1000 : Date.now() + secs * 1000,
      user: raw.user || null,
    };
  }

  /* ── низкий уровень: запросы к проекту ─────────────────────────────────────
     apikey нужен всегда; Authorization — токен пользователя, а без входа тот же
     publishable-ключ (так PostgREST видит роль anon). */
  function headers(extra) {
    const h = Object.assign({ apikey: CFG.anonKey }, extra || {});
    if (!h.Authorization) h.Authorization = 'Bearer ' + CFG.anonKey;
    return h;
  }

  async function call(path, opts = {}) {
    if (!configured()) throw new Error('Бэкенд не настроен');
    const res = await fetch(CFG.url + path, Object.assign({}, opts, {
      headers: headers(opts.headers),
    }));
    const body = await res.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = body; }
    if (!res.ok) {
      // у GoTrue сообщение в error_description/msg, у PostgREST — в message
      const msg = (data && (data.error_description || data.msg || data.message))
        || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && (data.error_code || data.code);   // GoTrue: otp_disabled и т.п.
      throw err;
    }
    return data;
  }

  /* ── токен доступа с автообновлением ───────────────────────────────────────
     Одновременные вызовы (полка + открытие книги) не должны гнать два refresh:
     держим общий промис на время обновления. */
  let refreshing = null;

  async function accessToken() {
    if (!session) return null;
    if (Date.now() < session.expires_at - SKEW * 1000) return session.access_token;
    if (!session.refresh_token) { save(null); return null; }
    if (!refreshing) {
      refreshing = call('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      }).then(raw => {
        save(normalize(raw));
        return session ? session.access_token : null;
      }).catch(() => {
        // протухший или отозванный refresh — это не ошибка приложения, просто выход
        save(null);
        return null;
      }).finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // заголовки от имени пользователя; без входа — те же анонимные
  async function authHeaders(extra) {
    const t = await accessToken();
    return headers(Object.assign({}, extra, t ? { Authorization: 'Bearer ' + t } : null));
  }

  /* ── публичный API ─────────────────────────────────────────────────────── */

  async function isSignedIn() {
    return Boolean(await accessToken());
  }

  // текущий пользователь (или null) — пригодится для подписи «вошли как …»
  async function currentUser() {
    if (!(await accessToken())) return null;
    if (session.user) return session.user;
    try {
      const u = await call('/auth/v1/user', { headers: await authHeaders() });
      save(Object.assign({}, session, { user: u }));
      return u;
    } catch { return null; }
  }

  /* Письмо со ссылкой для входа. create_user:false — регистрации нет: ссылка придёт
     только тому, кто уже заведён в проекте (владелец, позже — подписчики, которых
     создаёт сервер). Незнакомая почта не создаёт аккаунт; Supabase при этом отвечает
     успехом и на неё, чтобы нельзя было перебором узнать список пользователей. */
  async function sendMagicLink(email, redirectTo) {
    const q = redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '';
    await call('/auth/v1/otp' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, create_user: false }),
    });
  }

  /* Возврат по ссылке из письма: токены во фрагменте, ошибка — тоже. Фрагмент сразу
     затираем (replaceState), чтобы токен не остался в адресной строке, истории и в
     заголовке Referer. Возвращает 'signed-in' | 'error' | null (обычная загрузка). */
  function consumeAuthCallback() {
    const hash = location.hash || '';
    if (!hash.includes('access_token=') && !hash.includes('error=')) return null;
    const p = new URLSearchParams(hash.slice(1));
    const clean = location.pathname + location.search;
    history.replaceState(null, '', clean);
    if (p.get('error') || p.get('error_description')) {
      return { status: 'error', message: p.get('error_description') || p.get('error') };
    }
    save(normalize({
      access_token: p.get('access_token'),
      refresh_token: p.get('refresh_token'),
      expires_in: p.get('expires_in'),
    }));
    return { status: 'signed-in' };
  }

  /* Выход. Синхронный по сути: сессию гасим сразу, отзыв на сервере — фоном, его
     неудача (офлайн) не должна оставлять пользователя «вошедшим» в интерфейсе. */
  function signOut() {
    const t = session && session.access_token;
    save(null);
    if (t && configured()) {
      fetch(CFG.url + '/auth/v1/logout', {
        method: 'POST',
        headers: headers({ Authorization: 'Bearer ' + t }),
      }).catch(() => {});
    }
  }

  /* Чтение таблиц: путь и фильтры — синтаксис PostgREST,
     напр. rest('books?select=id,meta&order=id'). RLS решает, что вернётся. */
  async function rest(path, opts = {}) {
    return call('/rest/v1/' + path, Object.assign({}, opts, {
      headers: await authHeaders(opts.headers),
    }));
  }

  /* Подписанный URL объекта приватного бакета. Сервер выдаёт его, только если RLS
     пускает пользователя к этому префиксу; ссылка живёт SIGN_TTL секунд и дальше
     скачивается обычным fetch (SW её не кеширует — см. isBackend в sw.js). */
  async function signedUrl(bucket, path, expiresIn = SIGN_TTL) {
    const obj = String(path).replace(/^\/+/, '');
    const r = await call(`/storage/v1/object/sign/${bucket}/${obj}`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn }),
    });
    // ответ: { signedURL: "/object/sign/<bucket>/<path>?token=…" }
    if (!r || !r.signedURL) throw new Error('Подписанная ссылка не получена');
    return CFG.url + '/storage/v1' + r.signedURL.replace(/^\/storage\/v1/, '');
  }

  return {
    configured, isSignedIn, currentUser,
    sendMagicLink, consumeAuthCallback, signOut,
    rest, signedUrl,
  };
})();
