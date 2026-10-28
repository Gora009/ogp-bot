#!/usr/bin/env bash
# Вход ботов на форум gta5rp.com (форум не пускает гостей, а логин и пароль форума не работают — вход через сайт).
# Владелец входит в браузере под аккаунтом бота с «Запомнить меня» и вписывает сюда куку xf_user.
# Запуск на сервере:  bash /opt/ogp-bot/deploy/set-forum.sh
# Кука при вводе не видна и никуда, кроме .env ботов, не записывается.
set -euo pipefail

read -r -s -p "Значение куки xf_user (или «xf_session=…», если xf_user нет; не отображается): " FCOOKIE; echo
if [[ -z "$FCOOKIE" ]]; then echo "Пусто — ничего не изменено."; exit 1; fi
# только значение — это xf_user; «имя=значение; имя2=значение2» (например xf_session) — как есть
[[ "$FCOOKIE" == *=* ]] || FCOOKIE="xf_user=$FCOOKIE"

for d in /opt/ogp-bot /opt/ogp-bot-2; do
  [[ -f "$d/.env" ]] || continue
  sed -i '/^FORUM_USER=/d;/^FORUM_PASSWORD=/d;/^FORUM_COOKIE=/d' "$d/.env"
  printf 'FORUM_COOKIE=%s\n' "$FCOOKIE" >> "$d/.env"
  echo "Записано в $d/.env"
done
unset FCOOKIE

systemctl restart ogp-bot
systemctl list-unit-files ogp-bot-2.service >/dev/null 2>&1 && systemctl restart ogp-bot-2
echo "Проверяю вход (20 секунд)…"
sleep 20
LOG=$(journalctl -u ogp-bot -u ogp-bot-2 --since "25 sec ago" --no-pager)
echo "$LOG" | grep -E "Запущен|Вход на форум|Форум:" || true
if echo "$LOG" | grep -q "Вход на форум"; then
  echo "Готово: бот вошёл на форум."
else
  echo "Бот НЕ вошёл. Проверьте, что скопировали значение xf_user целиком и что в браузере стояло «Запомнить меня»."
fi
