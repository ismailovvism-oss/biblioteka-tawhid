/* supabase/client.js — тонкий клиент Supabase на голом fetch: без зависимостей и сборки,
   в духе проекта (vanilla JS). Заготовка фазы 1 — дизайн в BACKEND.md.

   ⚠️ Пока НЕ подключён в index.html: это скелет, активируется после заполнения
   supabase/config.js и подключения <script> (фаза 1). Классический скрипт → window.SB.

   Публичные эндпоинты Supabase: /auth/v1 (GoTrue), /rest/v1 (PostgREST), /storage/v1. */
(function (global) {
  'use strict';
  const cfg  = global.SUPABASE_CONFIG || {};
  const BASE = (cfg.url || '').replace(/\/+$/, '');
  const ANON = cfg.anonKey || '';
  const SKEY = 'sb-session'; // localStorage: { access_token, refresh_token, expires_at }

  const configured = () => Boolean(BASE && ANON);
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ── сессия ──────────────────────────────────────────────────────────────────
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch { return null; }
  }
  function saveSession(s) {
    if (!s || !s.access_token) { localStorage.removeItem(SKEY); return null; }
    const sess = {
      access_token:  s.access_token,
      refresh_token: s.refresh_token,
      // Supabase шлёт expires_at (сек эпохи) и/или expires_in; берём что есть
      expires_at: s.expires_at || (nowSec() + (Number(s.expires_in) || 3600)),
    };
    localStorage.setItem(SKEY, JSON.stringify(sess));
    return sess;
  }

  // возврат магик-линка: токены прилетают в hash (#access_token=…&refresh_token=…)
  function consumeAuthCallback() {
    if (!location.hash || location.hash.indexOf('access_token=') < 0) return null;
    const p  = new URLSearchParams(location.hash.slice(1));
    const at = p.get('access_token');
    if (!at) return null;
    const sess = saveSession({
      access_token:  at,
      refresh_token: p.get('refresh_token'),
      expires_in:    p.get('expires_in'),
    });
    history.replaceState(null, '', location.pathname + location.search); // убрать токены из URL
    return sess;
  }

  async function authPost(path, body) {
    const res  = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.msg || data.error || `HTTP ${res.status}`);
    return data;
  }

  async function refreshIfNeeded() {
    const s = loadSession();
    if (!s) return null;
    if (s.expires_at - 60 > nowSec()) return s;         // ещё жив
    try { return saveSession(await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })); }
    catch { return saveSession(null); }                  // протух → разлогин
  }

  // ── публичный API ─────────────────────────────────────────────────────────────
  const SB = {
    configured,
    consumeAuthCallback,
    signOut() { saveSession(null); },

    // отправить магик-линк на почту. Регистрация закрыта → create_user:false
    async sendMagicLink(email, redirectTo) {
      if (!configured()) throw new Error('Supabase не настроен (supabase/config.js)');
      const q = redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '';
      await authPost('/auth/v1/otp' + q, { email, create_user: false });
    },

    async getToken()   { const s = await refreshIfNeeded(); return s ? s.access_token : null; },
    async isSignedIn() { return Boolean(await SB.getToken()); },

    // синхронно: кто вошёл (из payload access-токена, без обращения к сети)
    getUser() {
      const s = loadSession();
      if (!s || !s.access_token) return null;
      try {
        const b64 = s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const p   = JSON.parse(atob(b64));
        return { id: p.sub || null, email: p.email || null };
      } catch { return null; }
    },

    // запрос к PostgREST под пользователем (RLS решает видимость строк).
    // Ключ нового формата (sb_publishable_…) — только в apikey; Bearer'ом шлём лишь
    // пользовательский access-токен, если есть.
    async rest(pathAndQuery, opts = {}) {
      const token   = await SB.getToken();
      const headers = Object.assign({ apikey: ANON }, opts.headers || {});
      if (token) headers.Authorization = 'Bearer ' + token;
      const res     = await fetch(BASE + '/rest/v1/' + pathAndQuery, Object.assign({}, opts, { headers }));
      if (!res.ok) throw new Error(`REST ${res.status}`);
      return res.json();
    },

    // короткоживущий подписанный URL на файл приватного бакета
    async signedUrl(bucket, objectPath, expiresIn = 60) {
      const token = await SB.getToken();
      if (!token) throw new Error('нужен вход');
      const res = await fetch(BASE + '/storage/v1/object/sign/' + bucket + '/' + objectPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: 'Bearer ' + token },
        body: JSON.stringify({ expiresIn }),
      });
      if (!res.ok) throw new Error(`sign ${res.status}`);
      const data = await res.json();          // { signedURL: '/object/sign/…' }
      return BASE + '/storage/v1' + data.signedURL;
    },
  };

  global.SB = SB;
})(typeof window !== 'undefined' ? window : globalThis);
