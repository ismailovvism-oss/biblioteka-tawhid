# Edge Functions

## `translate` — ИИ-перевод фрагмента

Зачем функция, а не вызов из браузера: сайт статический и лежит на GitHub Pages,
исходники видны всем. Ключ Anthropic, положенный в клиент, утечёт в первый же день.

### Что нужно для развёртывания

| Секрет | Где взять | Зачем |
|---|---|---|
| Персональный токен Supabase (`sbp_…`) | Dashboard → Account → Access Tokens | право деплоить функции. **Сервисный ключ (`sb_secret_…`) сюда не годится** — он для данных, не для управления проектом |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | без него функция честно отвечает 503 |

### Развернуть

```sh
export SUPABASE_ACCESS_TOKEN=sbp_...
npx supabase@latest functions deploy translate --project-ref cbcyrfqclhlunfdjxxav
npx supabase@latest secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref cbcyrfqclhlunfdjxxav
```

Проверить:

```sh
curl -s -X POST https://cbcyrfqclhlunfdjxxav.supabase.co/functions/v1/translate \
  -H "apikey: <publishable-ключ из supabase/config.js>" \
  -H "Content-Type: application/json" \
  -d '{"text":"The speckled band.","from":"en","to":"ru"}'
```

Пока не развёрнуто, приложение работает как работало: в карточке перевода
пункт «ИИ» гаснет после первой попытки, бесплатный MyMemory продолжает работать.
