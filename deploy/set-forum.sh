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

# оба бота перезапускаются и входят на форум при первом запросе
systemctl restart ogp-bot
systemctl list-unit-files ogp-bot-2.service >/dev/null 2>&1 && systemctl restart ogp-bot-2
sleep 15
journalctl -u ogp-bot -u ogp-bot-2 --since "20 sec ago" --no-pager | grep -E "Запущен|Вход на форум|вход на форум|Forum HTTP" || true
echo "Готово. Строка «Вход на форум: …» — бот вошёл."
