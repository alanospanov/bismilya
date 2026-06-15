# 🚀 nFactorial Teens — Стартовый шаблон

Твоя отправная точка. Здесь уже готово: страница, **вход по email**, **профиль** и **база данных**
(пример: список записей). Дальше ты переделаешь это под свою идею с помощью **Codex**.

Стек: **Vite + React + TypeScript + Supabase + Vercel**.

---

## ✅ Запуск за 8 шагов (День 2)

> Всё по галочкам. Застрял на шаге — подними руку, не прыгай дальше.

1. **Возьми свою копию.** На GitHub нажми зелёную кнопку **«Use this template» → Create a new
   repository**. Назови репозиторий своим именем проекта. Это твоя копия, не оригинал.

2. **Открой в VSCode.** Скопируй ссылку своего репо → в терминале:
   ```bash
   git clone <ссылка-твоего-репо>
   cd <папка-проекта>
   code .
   ```

3. **Установи зависимости.** В терминале VSCode:
   ```bash
   npm install
   ```

4. **Создай проект в Supabase.** Зайди на [supabase.com](https://supabase.com) → **New project**.
   Запомни пароль базы. Подожди ~2 минуты, пока проект поднимется.

5. **Вставь ключи.** Скопируй файл `.env.example` → переименуй копию в `.env.local`.
   В Supabase: **Project Settings → API**. Скопируй **Project URL** и **anon public** ключ,
   вставь в `.env.local`:
   ```
   VITE_SUPABASE_URL=https://твой-проект.supabase.co
   VITE_SUPABASE_ANON_KEY=твой-anon-ключ
   ```
   ⚠️ `.env.local` НЕ коммить — он уже в `.gitignore`.

6. **Создай таблицу КОМАНДОЙ (не вручную).** Базу настраиваем миграциями — это по-взрослому:
   ```bash
   npm run db:login          # откроется браузер, подтверди вход
   npm run db:link           # выбери свой проект из списка (спросит пароль базы)
   npm run db:push           # применит supabase/migrations/* — создаст таблицу entries
   ```
   `db:push` берёт SQL из `supabase/migrations/` и применяет к твоей базе. Таблицы созданы — без ручного копипаста.

7. **Запусти локально.**
   ```bash
   npm run dev
   ```
   Открой ссылку из терминала (обычно `http://localhost:5173`). Зарегистрируйся, добавь запись —
   она сохранится в твоей базе. Работает? 🎉

8. **Выложи в интернет (Vercel).** Залей код на GitHub:
   ```bash
   git add .
   git commit -m "first version"
   git push
   ```
   На [vercel.com](https://vercel.com) → **Add New → Project** → выбери свой репозиторий.
   В **Environment Variables** добавь те же `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` →
   **Deploy**. Через минуту у тебя будет **живая ссылка**. Это и есть твой проект в интернете.

---

## 🔁 Главный цикл (каждый день)

```
просишь Codex что-то сделать  →  смотришь что он изменил  →
проверяешь что всё работает (npm run dev)  →  git push  →  Vercel сам обновляет ссылку
```

**Проверка перед push:** приложение запускается? нет красных ошибок? Тогда коммить.

---

## 📂 Что где лежит

| Файл | Что это |
|------|---------|
| `src/App.tsx` | Главный экран: показывает вход или приложение |
| `src/components/Auth.tsx` | Вход и регистрация |
| `src/components/Entries.tsx` | Пример работы с базой (читать/добавить/удалить) |
| `src/lib/supabase.ts` | Подключение к Supabase |
| `supabase/migrations/` | Таблицы базы (применяются `npm run db:push`) |
| `supabase/functions/ai/` | AI на бесплатном ключе Gemini (день 5) |
| `AGENTS.md` | Контекст для Codex — он читает это сам |
| `CODEX_SETUP.md` | Готовые промпты для Codex по дням |

---

## 🤖 AI (день 5) — бесплатный Gemini

Внутри уже есть AI-функция (`supabase/functions/ai`). Чтобы включить:
1. Возьми бесплатный ключ: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Положи его в секрет: `npm run ai:secret -- GEMINI_API_KEY=твой_ключ`
3. Задеплой: `npm run ai:deploy`
4. Вызывай из кода: `supabase.functions.invoke('ai', { body: { prompt, system } })` → `data.text`

---

## 🆘 Если сломалось

- **Белый экран + ошибка про ключи** → не вставил ключи в `.env.local` (шаг 5).
- **«relation entries does not exist»** → не сделал `npm run db:push` (шаг 6).
- **`db:push` ругается на доступ** → сначала `npm run db:login`, потом `npm run db:link`.
- **На Vercel пусто, локально работает** → забыл добавить Environment Variables на Vercel (шаг 8).
- **Codex сломал код** → не коммить! Попроси Codex починить или откати изменения в VSCode.
