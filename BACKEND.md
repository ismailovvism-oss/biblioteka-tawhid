# BACKEND.md — Аккаунты, приватные книги и подписки

Дизайн-документ бэкенда для «Библиотеки Таухид». Реализует **слой L5** из
`ARCHITECTURE.md` (пользователи, синхронизация, приватный/платный контент) — тот, что
раньше был «заложен, но не построен». Пишется **до кода**: сначала согласуем схему, потом
режем на фазы и реализуем.

> **Принцип совместимости.** Читалка (`parser.js`, формат Контракта) и статический хостинг
> публичных книг **не меняются**. Бэкенд добавляется *сбоку*, за интерфейсами-провайдерами
> (`ARCHITECTURE.md`, «Швы под будущий бэкенд»). Публичные книги как отдавались с GitHub
> Pages / CDN, так и отдаются — бесплатно, кэшируемо, офлайн. Через бэкенд идёт **только**
> приватный и платный контент и состояние пользователя.

## Цель

1. **Приватные книги** — автор читает свои неопубликованные книги онлайн с любого
   устройства; посторонние их не видят и не могут скачать. *(Исходный запрос.)*
2. **Аккаунты** — вход, сессия, «моя библиотека» = публичные ∪ доступные мне.
3. **Подписки** *(на будущее)* — платный доступ к части каталога; платёж → право чтения.

Границы: НЕ переписываем читалку, НЕ трогаем формат Контракта, НЕ уносим публичные книги с
бесплатного статик-хоста. Бэкенд — тонкий слой доступа и состояния, не монолит.

## Стек: Supabase

Выбран (решение автора, 2026-07-24). Даёт три нужных куска одним сервисом:

- **Auth (GoTrue)** — email/пароль, магик-линк, OAuth. Свою аутентификацию НЕ пишем (это
  самая опасная часть любого бэкенда).
- **Postgres + Row-Level Security** — правило «пользователь X читает книгу Y» живёт **в
  БД как политика**, а не в коде приложения. Основа для прав доступа и подписок.
- **Storage + RLS** — приватные/платные файлы книг в закрытом бакете, отдаются только по
  праву доступа (через подписанные URL или авторизованный запрос).
- **Edge Functions** — серверные обработчики (вебхуки платёжки в фазе 3).

### Без npm-библиотеки и без сборки

Supabase снаружи — это **обычный HTTP API** (PostgREST + GoTrue + Storage). Клиент на голом
`fetch` пишется в ~150 строк и **не ломает** ни «vanilla JS без сборки», ни PWA/SW, ни
работу по `file://` при локальной разработке. Официальную `@supabase/supabase-js` **не
тянем** — она потребовала бы бандлер или ESM-CDN, а это против устоя проекта (CLAUDE.md).

Эндпоинты, которые дёргаем напрямую:

| Назначение | Метод + путь |
|---|---|
| Регистрация | `POST /auth/v1/signup` |
| Вход по паролю | `POST /auth/v1/token?grant_type=password` |
| Магик-линк | `POST /auth/v1/otp` |
| Обновление сессии | `POST /auth/v1/token?grant_type=refresh_token` |
| Чтение данных | `GET /rest/v1/<table>?...` (+ `Authorization: Bearer`) |
| Подписанный URL файла | `POST /storage/v1/object/sign/<bucket>/<path>` |

Заголовки на каждый вызов: `apikey: <ANON_KEY>` и (для приватного) `Authorization: Bearer
<access_token>`.

## Роли доступа книги

Новое поле `visibility` у книги:

- **`public`** — как сейчас. Лежит в `books/` на GitHub Pages, запись в `books/index.json`,
  видят все, читают все. **Ничего не меняется.**
- **`private`** — файлы в приватном бакете Supabase Storage. Видит и читает только владелец
  (запись `entitlements` с `source='owner'`).
- **`paid`** *(фаза 3)* — файлы в приватном бакете. Читают те, у кого активная подписка
  (или разовая покупка) даёт право.

## Модель данных (Postgres)

```sql
-- пользователи даёт сам Supabase Auth (schema auth.users). Профиль — по желанию:
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz default now()
);

-- каталог непубличных книг (публичные остаются в статическом books/index.json)
create table books (
  id          text primary key,          -- совпадает с bookId Контракта
  owner       uuid references auth.users(id),
  visibility  text not null check (visibility in ('private','paid')),
  meta        jsonb not null,            -- та же запись, что в index.json (title, category, langs…)
  storage_base text not null,            -- префикс в бакете: "<id>/"
  created_at  timestamptz default now()
);

-- кто что может читать. Твои приватные книги = строки source='owner'
create table entitlements (
  user_id  uuid references auth.users(id) on delete cascade,
  book_id  text references books(id)      on delete cascade,
  source   text not null check (source in ('owner','subscription','purchase','grant')),
  expires_at timestamptz,                 -- null = бессрочно
  primary key (user_id, book_id, source)
);

-- фаза 3: наполняется вебхуками платёжки, читается только политиками
create table subscriptions (
  user_id      uuid references auth.users(id) on delete cascade,
  plan         text not null,
  status       text not null,             -- active | past_due | canceled | …
  period_end   timestamptz,
  provider     text,                       -- stripe | paddle | lemonsqueezy | …
  provider_ref text,                        -- id подписки у провайдера
  primary key (user_id, plan)
);
```

Право чтения = «есть строка в `entitlements` с непросроченным `expires_at`». Подписка в
фазе 3 материализуется в `entitlements` (или проверяется вью) — приложение всегда смотрит в
одно место, `entitlements`, и не знает про платёжку. Это и есть абстракция под «любую
платёжку потом».

## RLS-политики (суть)

```sql
alter table books        enable row level security;
alter table entitlements enable row level security;
alter table subscriptions enable row level security;

-- книгу видно, если она твоя по entitlements (или ты владелец)
create policy books_visible on books for select using (
  owner = auth.uid()
  or exists (select 1 from entitlements e
             where e.book_id = books.id and e.user_id = auth.uid()
               and (e.expires_at is null or e.expires_at > now()))
);

-- свои права видит каждый; выдаёт/меняет их только сервер (service_role) или владелец книги
create policy ent_read on entitlements for select using (user_id = auth.uid());

-- подписку читает только её владелец; пишет только сервер (вебхук, service_role)
create policy sub_read on subscriptions for select using (user_id = auth.uid());
```

Storage-бакет `book-content` — приватный; политика на `storage.objects` пускает `select`,
если префикс объекта принадлежит книге, на которую у юзера есть право:

```sql
create policy content_read on storage.objects for select using (
  bucket_id = 'book-content'
  and exists (
    select 1 from books b join entitlements e on e.book_id = b.id
    where e.user_id = auth.uid()
      and (e.expires_at is null or e.expires_at > now())
      and name like b.storage_base || '%'
  )
);
```

Итог: **безопасность в БД, а не в UI.** Даже если кто-то знает URL файла приватной книги —
без валидного JWT с правом доступа Storage вернёт 403.

## Швы в приложении (`app.js`)

Три тонких провайдера. Каждый — точка, где статика подменяется бэкендом; UI их не различает.

### 1. `authProvider` — новый

Сессия (`access_token`/`refresh_token`) в `localStorage`, автопродление по refresh-токену.
Экспортирует `signIn/signOut/getUser/getToken`. UI: кнопка входа в шапке, экран
логина/магик-линка. Аноним — как сейчас, просто без приватных книг.

### 2. `catalogProvider` — оборачивает загрузку реестра

Сейчас: `books/index.json` грузится напрямую (`app.js:2087`). Становится:

```
visibleBooks = staticPublicIndex            // books/index.json, как сейчас
             ∪ (авторизован ? GET /rest/v1/books : [])   // приватные/платные по RLS
```

Аноним → только публичный `index.json` (нулевой регресс). Вошёл → сверху приезжают его
книги. Записи одинаковой формы (`meta` в таблице = запись реестра), полка их не различает.

### 3. `contentProvider` — оборачивает `fetchText` содержимого

Сейчас `loadChapterData` (`app.js:106`) и `openBook` (`app.js:2001`) зовут `fetchText(base +
…)`. Становится диспетчер по `visibility`/`base` книги:

- **public** → прямой `fetch` с CDN, как сейчас (кэш SW, офлайн — без изменений).
- **private/paid** → получить подписанный URL (`POST /storage/v1/object/sign/...`) или
  авторизованный `GET` в Storage, затем прочитать текст. Формат Контракта на выходе тот же —
  `buildChapter` не трогаем.

`fetchText` остаётся для публичного пути; приватный путь — новая ветка внутри провайдера.
`chapterCache` и `buildChapter(texts, langs, {base})` работают без изменений.

## Поток аутентификации

1. Пользователь жмёт «Войти» → email + пароль (или «прислать ссылку» — магик-линк).
2. `POST /auth/v1/token` → `{access_token, refresh_token, expires_in}` в `localStorage`.
3. Каждый запрос к `/rest`/`/storage`: заголовки `apikey` + `Authorization: Bearer`.
4. За минуту до истечения — тихий refresh. Ошибка refresh → разлогин, откат к анон-режиму.
5. Выход → чистим токены, `catalogProvider` возвращается к публичному индексу.

## Подписки (фаза 3, проектируем, не строим)

- Платёж проводит внешний провайдер; его **вебхук** бьёт в **Edge Function**, которая
  (под `service_role`) пишет `subscriptions` и заводит/снимает `entitlements`. Клиент к
  платёжке и к записи прав **не прикасается** — только читает свои `entitlements`.
- **География платежей — открытый вопрос.** Stripe в РФ не работает; Paddle/LemonSqueezy
  (merchant-of-record, берут на себя НДС) — с оговорками. Выбор провайдера НЕ влияет на
  фазы 1–2 и на схему: `entitlements`/`subscriptions` абстрактны, `provider` — просто поле.
  Решаем ближе к запуску подписок.

## Безопасность — что можно и что нельзя

- **`ANON_KEY` — публичный**, его можно и нужно вшить в клиент: это идентификатор проекта +
  роль `anon`; всё решает RLS. Не секрет.
- **`SERVICE_ROLE_KEY` — никогда в клиент, никогда в git.** Обходит RLS. Живёт только в
  секретах Edge Functions (фаза 3).
- Никаких «паролей в JS» и «спрятанных» файлов на публичном хосте — приватный контент
  физически в приватном бакете, иначе смысла нет.
- Приватные книги **не кэшировать** в SW как публичные: network-only для приватного пути,
  иначе токен-гейт обходится через кэш. Публичные — как сейчас.

## Совместимость с PWA / офлайн

- Оболочка (`index.html`/`app.js`/`parser.js`/`style.css`) и **публичные** книги — офлайн
  как сейчас (SW network-first).
- **Приватные** книги офлайн в фазе 1 не кэшируем (безопасность важнее). Опционально позже —
  шифрованный офлайн-кэш, но это отдельная задача, не в MVP.
- Бампать `VERSION` в `sw.js` при правках оболочки — как обычно (CLAUDE.md).

## Что понадобится от автора (вне кода)

1. Завести проект на supabase.com (бесплатный тариф с запасом на старт).
2. **SQL Editor → выполнить `supabase/schema.sql`** (таблицы + RLS + бакет; идемпотентно).
3. **Authentication → Providers → Email:** включить, **выключить публичную регистрацию**
   («Allow new users to sign up» = off) — регистрация закрытая (решение №3). В **URL
   Configuration** прописать адрес приложения в Site URL и Redirect URLs (для магик-линка).
4. **Settings → API:** взять **Project URL** и **anon public key** и вписать в
   `supabase/config.js` (это публичные значения, коммитить можно — всё решает RLS).
5. `service_role`-ключ — **НЕ в git и не в приложение.** Нужен только локально для
   `tools/upload-private.js` (через env) и позже для Edge Functions (секреты Supabase).

Шаги 2–5 делает автор в своём аккаунте (проект и биллинг — его); остальное — код в репо.

## Фазы

| Фаза | Что | Результат |
|---|---|---|
| **0** | Этот док + `supabase/schema.sql` (таблицы, RLS, бакет) | Схема согласована и готова к применению |
| **1** | `authProvider` + UI входа; `catalogProvider` (публичные ∪ мои) | Аккаунты, «моя библиотека» |
| **2** | `contentProvider` для приватного пути; загрузка приватной книги в бакет | **Приватное чтение онлайн — цель достигнута** |
| **3** | Edge Function + вебхук платёжки → `entitlements`; платные книги | Подписки |

Фаза 2 закрывает исходный запрос; фаза 3 добавляет монетизацию, ничего не ломая.

## Решения (приняты 2026-07-24, ревью автора делегирован)

1. **Вход — магик-линк** (ссылка на почту, без пароля). Для одного автора проще и
   безопаснее: нет хранения/утечки паролей, нет формы сброса. Пароль можно добавить позже
   тем же `authProvider` — схема этого не касается.
2. **Заливка приватных книг — CLI-скрипт** (`tools/upload-private.js`): берёт папку книги в
   формате Контракта → заливает файлы в бакет `book-content/<id>/`, заводит строку в `books`
   и `entitlements(owner)`. Работает под `service_role`-ключом из локального env (в git не
   попадает). Форма загрузки в приложении — потом, не в MVP.
3. **Регистрация — закрытая, только владелец.** Публичный signup выключен в настройках Auth;
   пока книга приватная и одна, доступ = владелец. Приглашение других — позже (грант
   `entitlements` или инвайт), схема готова (`source='grant'`).
4. **Провайдер платежей** — отложено до фазы 3 (см. «География»). На фазы 0–2 не влияет.

Эти решения обратимы и не меняют схему БД — они лишь фиксируют MVP-путь.

---
Менялось — см. `CHANGELOG.md`. Формат книг — `SPEC.md`. Целевая архитектура — `ARCHITECTURE.md`.
