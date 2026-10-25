# Закулисье Майнкрафта Вики — экспертный портал

Статический фронтенд + API на Cloudflare Pages Functions + база Cloudflare D1.

## Структура репозитория

```
public/                  ← публикуется как сайт (Build output directory = public)
  index.html
  assets/style.css, app.js
  _headers               ← CSP и заголовки безопасности
  robots.txt, sitemap.xml
functions/api/[[route]].js   ← весь серверный API (не публичный код)
schema.sql                   ← схема базы (не публикуется)
README.md
```

## Настройка Cloudflare (один раз)

1. **База D1.** Dashboard → Storage & Databases → D1 → *Create database* (например, `zmv-wiki`).
   Откройте вкладку *Console*, вставьте весь `schema.sql` и выполните.
2. **Настройки Pages-проекта** (Workers & Pages → ваш проект):
   - Settings → Build: *Build command* — пусто, *Build output directory* — `public`.
   - Settings → Bindings (Functions) → *Add* → **D1 database** → имя переменной **`DB`** → ваша база.
     Сделайте это для Production (и Preview, если нужен).
   - Settings → Variables and Secrets → добавьте секрет **`ADMIN_PASSWORD`** (минимум 12 символов, лучше длинная фраза).
   - Необязательно, защита от ботов Cloudflare Turnstile: создайте виджет (Dashboard → Turnstile), добавьте
     секрет `TURNSTILE_SECRET` и переменную `TURNSTILE_SITE_KEY`. Пока их нет, форма защищена
     ловушкой для ботов, лимитом отправок (3/час с адреса) и ручной модерацией.
3. Сделайте новый деплой (push в GitHub).
4. Замените `https://YOUR-DOMAIN.pages.dev` на реальный адрес в `public/index.html`
   (canonical, og:url), `public/robots.txt`, `public/sitemap.xml`.

## Перенос старых данных

Откройте старую версию сайта → «Экспорт JSON» (или файл `data.json` из репозитория).
В новой версии: «Вход админа» → «Импорт» → выберите файл. Старый формат
(`reviewsData`/`authorsData`) поддерживается; баллы пересчитываются сервером, повторный импорт
дубликатов не создаёт.

## ВАЖНО: безопасность

- **Отзовите все GitHub-токены**, которые вы вводили в старую версию сайта (GitHub → Settings →
  Developer settings → Personal access tokens). Они хранились открытым текстом в localStorage.
  В новой версии токен не нужен: данные лежат в D1, резервная копия — кнопка «Экспорт JSON».
- Админ-режим теперь настоящий: вход по паролю, сессия в HttpOnly-cookie на 8 часов,
  все изменяющие операции проверяются на сервере.
- Рецензии посетителей попадают в очередь («🛡 Модерация») и публикуются только после одобрения.
  Рецензии от имени ИИ-критиков может добавлять только админ.

## Локальный запуск

```
npx wrangler d1 execute zmv-wiki --local --file=schema.sql
npx wrangler pages dev public --d1=DB --binding ADMIN_PASSWORD=long-local-password
```
