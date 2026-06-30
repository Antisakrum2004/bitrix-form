# Vercel Environment Variables — bitrix-form-AI

> **Проект:** https://vercel.com/antisakrum2004/bitrix-form-AI/settings/environment-variables
> **Дата:** 2026-06-30
> **Зачем:** Эндпоинт `/api/ai-similar` ходит в Supabase pgvector и OpenRouter за эмбеддингами. Без этих env vars фронт-енд с GitHub Pages будет получать пустой массив `similar: []` и падать в fallback на старый `/ai-search`.

## Что добавить (3 переменные)

Все три — **Production + Preview + Development** окружения (или минимум Production).

| Name | Value | Sensitivity |
|------|-------|-------------|
| `OPENROUTER_API_KEY` | (см. `scripts/.env.local` локально — не коммитим в репо) | 🔴 Secret — не коммитить |
| `SUPABASE_URL` | `https://nopccnooivztriqdkbie.supabase.co` | 🟢 Public |
| `SUPABASE_SERVICE_KEY` | (см. `scripts/.env.local` локально — не коммитим в репо) | 🔴 Secret — service_role, полный доступ к БД |

> **Где взять реальные значения:** `scripts/.env.local` (локально на машине, где запускали индексацию). Либо из Supabase Dashboard → Settings → API → `service_role` key. Либо из Vercel — после первого добавления их можно прочитать в Settings → Environment Variables.

## Способ 1 — через Dashboard (быстрее)

1. Открыть: https://vercel.com/antisakrum2004/bitrix-form-AI/settings/environment-variables
2. Для каждой переменной:
   - "Create Variable"
   - Name = из таблицы выше
   - Value = из таблицы выше
   - Environment = отметить все три (Production, Preview, Development)
   - "Save"
3. После добавления всех трёх — Redeploy: https://vercel.com/antisakrum2004/bitrix-form-AI/deployments → "Redeploy" на последнем деплое

## Способ 2 — через Vercel CLI

```bash
# Из директории проекта:
cd bitrix-form
vercel login
vercel link  # выбрать antisakrum2004 / bitrix-form-AI

# Добавить три переменные (CLI попросит значение и окружения):
vercel env add OPENROUTER_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_KEY

# Применить к production:
vercel env pull .vercel.env.production --environment=production
vercel --prod  # redeploy
```

## Проверка после деплоя

```bash
curl -X POST https://bitrix-form-ai.vercel.app/api/ai-similar \
  -H 'Content-Type: application/json' \
  -d '{"text":"минус резерв","threshold":0.3,"limit":5}'
```

Ожидаемый ответ (если всё ок):
```json
{
  "similar": [
    {"id":"7932","title":"Проверить резервы","responsible":"Ольга","similarity":0.78,...},
    {"id":"7646","title":"Проверить почему пишет минус резерв по остатки","responsible":"Ольга","similarity":0.74,...},
    ...
  ],
  "total": 5,
  "source": "supabase"
}
```

Если `total: 0` и `reason: "missing_env"` — переменные не подхватились, проверить拼写 и окружения.

## Что уже есть на Vercel (не трогать)

Из предыдущих сессий в Vercel env уже должны быть:
- `BITRIX24_WEBHOOK` — для `/api/send-report`, `/api/send-reminder` и т.д.
- `OPENAI_API_KEY` — для `/api/ai-task`, `/api/ai-search`, `/api/ai-decompose`, `/api/ai-duplicate` (чат-маршруты, не embeddings)
- `GITHUB_TOKEN` — для записи в репозиторий
- `CRON_SECRET` — для защиты cron-эндпоинтов

Новые три переменные **НЕ заменяют** существующий `OPENAI_API_KEY` — чат-маршруты продолжат работать как есть. `OPENROUTER_API_KEY` используется **только** в `/api/ai-similar` для embeddings.

## Откат

Если что-то пойдёт не так:
1. Удалить три новые env vars из Vercel
2. Redeploy последний стабильный деплой
3. Фронт-енд автоматически откатится на старый `/ai-search` (fallback в `handleAiGenerate()`)
4. Гит-тег: `v7.25-rollback-2026-06-30` — резервная точка отката кода
