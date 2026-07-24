-- supabase/schema.sql — схема бэкенда «Библиотеки Таухид» (слой L5).
-- Аккаунты, приватные/платные книги, права доступа, подписки. Дизайн — BACKEND.md.
--
-- Применение: Supabase → SQL Editor → вставить целиком → Run. Идемпотентно.
-- Безопасность живёт здесь, в RLS-политиках, а не в UI приложения.

-- ── Профили (1:1 к auth.users) ───────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- профиль заводится автоматически при регистрации
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Каталог непубличных книг ─────────────────────────────────────────────────
-- Публичные книги остаются в статическом books/index.json и здесь НЕ дублируются.
create table if not exists public.books (
  id           text primary key,            -- = bookId Контракта
  owner        uuid not null references auth.users(id) on delete cascade,
  visibility   text not null check (visibility in ('private','paid')),
  meta         jsonb not null,              -- запись реестра (title, category, langs, …)
  storage_base text not null,               -- префикс в бакете, напр. 'my-book/'
  created_at   timestamptz not null default now()
);

-- ── Права доступа ────────────────────────────────────────────────────────────
-- «есть непросроченная строка» = право читать книгу. Твои приватные книги — source='owner'.
create table if not exists public.entitlements (
  user_id    uuid not null references auth.users(id) on delete cascade,
  book_id    text not null references public.books(id) on delete cascade,
  source     text not null check (source in ('owner','subscription','purchase','grant')),
  expires_at timestamptz,                    -- null = бессрочно
  created_at timestamptz not null default now(),
  primary key (user_id, book_id, source)
);

-- ── Подписки (фаза 3; сейчас только схема, наполняется вебхуком под service_role) ────
create table if not exists public.subscriptions (
  user_id      uuid not null references auth.users(id) on delete cascade,
  plan         text not null,
  status       text not null,                -- active | past_due | canceled | …
  period_end   timestamptz,
  provider     text,                          -- stripe | paddle | lemonsqueezy | …
  provider_ref text,                          -- id подписки у провайдера
  updated_at   timestamptz not null default now(),
  primary key (user_id, plan)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.books         enable row level security;
alter table public.entitlements  enable row level security;
alter table public.subscriptions enable row level security;

-- профиль: свой читаю и правлю
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- книга видна владельцу или тому, у кого есть непросроченное право
drop policy if exists books_visible on public.books;
create policy books_visible on public.books for select using (
  owner = auth.uid()
  or exists (
    select 1 from public.entitlements e
    where e.book_id = books.id and e.user_id = auth.uid()
      and (e.expires_at is null or e.expires_at > now())
  )
);

-- свои права читаю; выдаёт/меняет их сервер (service_role обходит RLS)
drop policy if exists ent_self_read on public.entitlements;
create policy ent_self_read on public.entitlements for select using (user_id = auth.uid());

-- свою подписку читаю; пишет только сервер (вебхук под service_role)
drop policy if exists sub_self_read on public.subscriptions;
create policy sub_self_read on public.subscriptions for select using (user_id = auth.uid());

-- ── Storage: приватный бакет содержимого приватных/платных книг ───────────────
insert into storage.buckets (id, name, public)
values ('book-content', 'book-content', false)
on conflict (id) do nothing;

-- читать объект можно, если его префикс принадлежит книге, на которую есть право
drop policy if exists content_read on storage.objects;
create policy content_read on storage.objects for select using (
  bucket_id = 'book-content'
  and exists (
    select 1 from public.books b
    where name like b.storage_base || '%'
      and (
        b.owner = auth.uid()
        or exists (
          select 1 from public.entitlements e
          where e.book_id = b.id and e.user_id = auth.uid()
            and (e.expires_at is null or e.expires_at > now())
        )
      )
  )
);

-- Запись/изменение в бакете — только сервер (service_role, обходит RLS): заливка книг
-- идёт через tools/upload-private.js. Клиентских insert/update/delete-политик намеренно нет.
