-- supabase/statistika.sql — счётчик открытий и кнопка «Полезно» (23.11.2026).
-- Замысел и что считается — BACKEND.md, раздел «Счётчик открытий».
--
-- Применение: Supabase → SQL Editor → вставить файл целиком → Run. Можно перезапускать.
-- В ответе внизу должна стоять ВАША почта: это аккаунт, которому видна статистика.
--
-- Что хранится. Только суммы: запись (статья или книга) × день × откуда пришли →
-- сколько раз открыли, сколько новых читателей, сколько дочитали, сколько «Полезно».
-- Ни IP, ни номера устройства, ни cookie: кто именно читал, из этой таблицы не узнать.
-- «Новый читатель» и «дочитал» решает само устройство читателя (помнит у себя, что эту
-- запись уже открывало), в базу приходит только «+1».

-- ── Суммы по дням ────────────────────────────────────────────────────────────
create table if not exists public.stat_day (
  book_id  text    not null,
  day      date    not null,                 -- по UTC
  source   text    not null,                 -- tg | search | site | lib | direct | other
  opens    integer not null default 0,       -- заходов (повтор в течение получаса — тот же заход)
  readers  integer not null default 0,       -- устройств, открывших запись впервые
  finished integer not null default 0,       -- устройств, дочитавших запись впервые
  useful   integer not null default 0,       -- «Полезно» минус отмены
  primary key (book_id, day, source)
);
create index if not exists stat_day_day on public.stat_day (day);

-- ── Кому видна статистика ────────────────────────────────────────────────────
create table if not exists public.stat_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.stat_day    enable row level security;
alter table public.stat_admins enable row level security;

-- Supabase по умолчанию раздаёт anon и authenticated все права на новые таблицы; оставляем
-- только чтение вошедшим — чтобы защита держалась не на одних политиках ниже.
revoke all on public.stat_day, public.stat_admins from anon, authenticated;
grant select on public.stat_day, public.stat_admins to authenticated;

-- себя в списке видит каждый (так читалка узнаёт, показывать ли кнопку «Статистика»)
drop policy if exists stat_admins_self on public.stat_admins;
create policy stat_admins_self on public.stat_admins
  for select using (user_id = auth.uid());

-- суммы читает только тот, кто в списке
drop policy if exists stat_day_admin_read on public.stat_day;
create policy stat_day_admin_read on public.stat_day
  for select using (exists (select 1 from public.stat_admins a where a.user_id = auth.uid()));

-- Политик на запись нет намеренно: напрямую в таблицы не пишет никто, только stat_hit ниже.

-- ── Запись: одна функция на всё ──────────────────────────────────────────────
-- p_event: open | finished | useful | unuseful; p_new — первое открытие на этом устройстве.
-- Неизвестное молча пропускается: счётчик не должен ронять читалку ошибкой.
create or replace function public.stat_hit(
  p_book text, p_event text, p_source text default 'other', p_new boolean default false
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  d date := (now() at time zone 'utc')::date;
  s text := case when p_source in ('tg','search','site','lib','direct') then p_source else 'other' end;
begin
  if p_book is null or p_book !~ '^[A-Za-z0-9_-]{1,80}$' then return; end if;
  if p_event is null or p_event not in ('open','finished','useful','unuseful') then return; end if;
  -- страховка от мусора: за день не больше 5000 разных строк (у библиотеки их десятки)
  if not exists (select 1 from public.stat_day where book_id = p_book and day = d and source = s)
     and (select count(*) from public.stat_day where day = d) >= 5000 then
    return;
  end if;
  insert into public.stat_day as t (book_id, day, source, opens, readers, finished, useful)
  values (p_book, d, s,
          (p_event = 'open')::int,
          (p_event = 'open' and coalesce(p_new, false))::int,
          (p_event = 'finished')::int,
          case p_event when 'useful' then 1 when 'unuseful' then -1 else 0 end)
  on conflict (book_id, day, source) do update set
    opens    = t.opens    + excluded.opens,
    readers  = t.readers  + excluded.readers,
    finished = t.finished + excluded.finished,
    useful   = t.useful   + excluded.useful;
end $$;

revoke all on function public.stat_hit(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.stat_hit(text, text, text, boolean) to anon, authenticated;

-- ── Чтение: суммы за период (их рисует окно «Статистика» в читалке) ──────────
-- security invoker: работают от имени вошедшего, и RLS выше пускает только список stat_admins.
-- Суммы считает база: строк по дням со временем станет больше, чем PostgREST отдаёт за раз.
create or replace function public.stat_summary(p_from date default null)
returns table (book_id text, source text, opens bigint, readers bigint, finished bigint, useful bigint)
language sql stable security invoker set search_path = public as $$
  select book_id, source, sum(opens), sum(readers), sum(finished), sum(useful)
  from public.stat_day
  where p_from is null or day >= p_from
  group by book_id, source
$$;

create or replace function public.stat_by_day(p_from date default null)
returns table (day date, opens bigint, readers bigint)
language sql stable security invoker set search_path = public as $$
  select day, sum(opens), sum(readers)
  from public.stat_day
  where p_from is null or day >= p_from
  group by day
  order by day
$$;

-- Supabase выдаёт EXECUTE на новые функции anon и authenticated по имени — снимаем явно
revoke all on function public.stat_summary(date) from public, anon, authenticated;
revoke all on function public.stat_by_day(date)  from public, anon, authenticated;
grant execute on function public.stat_summary(date) to authenticated;
grant execute on function public.stat_by_day(date)  to authenticated;

-- ── Владелец ─────────────────────────────────────────────────────────────────
-- Регистрация в проекте закрыта, и первым заведён аккаунт владельца — ему и даём доступ.
-- Только пока список пуст: повторный запуск файла никого не добавит и не вернёт убранного.
-- Если ниже окажется не ваша почта — выполните отдельно (подставив адреса):
--   delete from public.stat_admins;
--   insert into public.stat_admins (user_id) select id from auth.users where email = 'ваша@почта';
insert into public.stat_admins (user_id)
select id from auth.users
where not exists (select 1 from public.stat_admins)
order by created_at limit 1;

select u.email as "статистику видит"
from public.stat_admins a join auth.users u on u.id = a.user_id;
