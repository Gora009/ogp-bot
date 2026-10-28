# OGP Bot — Discord-бот Офиса Генерального прокурора (GTA5RP)

Жалобы с форума gta5rp.com, распределение по прокурорам и дедлайны, уголовные дела и проверка судьёй,
отпуска и увольнения, кураторство, разбор документов (`/analyze`) через ИИ.

## Запуск

Нужен Node.js 22.5+.

```bash
npm ci --omit=dev
cp .env.example .env   # заполните DISCORD_TOKEN и остальное
node src/index.js
```

На Windows — `start.bat` (перезапускает бота при падении).

В Discord Developer Portal → Bot включите **Server Members Intent**. Бот приглашается со scope `bot applications.commands`.

## Настройка в Discord

- `/setup` — панели
- `/settings` — все настройки в одном окне
- права — `/settings` → Доступ; роли с названиями «Генеральный прокурор», «Заместитель ГП», «Советник ГП», «Прокурор», «Судья» получают права автоматически
- полное описание — [SPEC.md](SPEC.md)
- `/faq` — справка

## Сервер (Ubuntu, systemd)

```bash
useradd -r -s /usr/sbin/nologin ogpbot
# код в /opt/ogp-bot, затем:
cd /opt/ogp-bot && npm ci --omit=dev && chown -R ogpbot:ogpbot /opt/ogp-bot
cp deploy/ogp-bot.service /etc/systemd/system/ && systemctl enable --now ogp-bot
```

Обновление с Windows — `update-server.bat` (адрес сервера в `deploy/server.local`, например `root@1.2.3.4`).

## Разбор документов

`AI_API_KEY` в `.env` — ключ Claude, DeepSeek, OpenAI, Gemini, Groq, OpenRouter или xAI (сервис определяется по ключу).
Без ключа работает упрощённый разбор. Разборы кешируются в базе: повторный запрос того же документа бесплатен.

Данные хранятся в `data/bot.db` (SQLite) — в репозиторий не попадают.


