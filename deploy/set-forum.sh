#!/usr/bin/env bash
# Логин и пароль аккаунта форума gta5rp.com для ботов (форум не пускает гостей).
# Запуск на сервере:  bash /opt/ogp-bot/deploy/set-forum.sh
# Пароль при вводе не виден и никуда, кроме .env ботов, не записывается.
set -euo pipefail

read -r -p "Логин форума: " FUSER
read -r -s -p "Пароль форума (не отображается): " FPASS; echo
if [[ -z "$FUSER" || -z "$FPASS" ]]; then echo "Логин и пароль не должны быть пустыми."; exit 1; fi

for d in /opt/ogp-bot /opt/ogp-bot-2; do
  [[ -f "$d/.env" ]] || continue
  sed -i '/^FORUM_USER=/d;/^FORUM_PASSWORD=/d' "$d/.env"
  printf 'FORUM_USER=%s\nFORUM_PASSWORD=%s\n' "$FUSER" "$FPASS" >> "$d/.env"
  echo "Записано в $d/.env"
done
unset FPASS

# старая сессия другого аккаунта больше не нужна — бот войдёт заново при первом запросе
systemctl restart ogp-bot
sleep 15
journalctl -u ogp-bot --since "20 sec ago" --no-pager | grep -E "Запущен|Вход на форум|вход на форум|Forum HTTP" || true
echo "Готово. Строка «Вход на форум: …» — бот вошёл."
