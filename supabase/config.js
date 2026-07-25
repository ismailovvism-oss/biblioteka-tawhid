/* Публичные параметры проекта Supabase. Коммитить МОЖНО: и URL, и ключ — не секреты,
   доступ решает RLS (BACKEND.md → «Безопасность»). service_role/secret-ключ сюда НЕ вписывать.
   Проект: biblioteka-tawhid, регион eu-central-1 (Франкфурт), заведён 2026-07-25.
   Ключ — новый формат Supabase (sb_publishable_…, пришёл на смену anon-JWT); шлётся
   в том же заголовке apikey, поле называется anonKey ради совместимости с client.js. */
window.SUPABASE_CONFIG = {
     url: 'https://cbcyrfqclhlunfdjxxav.supabase.co',
     anonKey: 'sb_publishable_YAYNCCrW0ZEWbSwJRNR1hA_Zxfl3kLN',
};
