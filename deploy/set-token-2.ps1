# Записывает токен второго бота в /opt/ogp-bot-2/.env на сервере и запускает его.
# Токен вводится здесь скрытно и уходит на сервер по SSH — в чат, в git и в историю команд он не попадает.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
$server = (Get-Content 'deploy\server.local' -TotalCount 1).Trim()
$key = Join-Path $env:USERPROFILE '.ssh\ogp_server'

# токен берётся из буфера обмена (скопируйте его в Developer Portal и запустите скрипт); если там не токен — спросим
$isToken = { param($t) $t -match '^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$' }
$token = ''
try { $token = ([string](Get-Clipboard -Raw)).Trim() } catch { }
if (& $isToken $token) {
  Write-Host ('Токен из буфера обмена: ' + $token.Substring(0, 6) + '…' + $token.Substring($token.Length - 4))
} else {
  $token = (Read-Host 'Вставьте токен второго бота и нажмите Enter').Trim()
}
if ($token -notmatch '^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$') { Write-Host 'Это не похоже на токен бота. Ничего не изменено.'; exit 1 }

# токен идёт через стандартный ввод, а не в командной строке
$remote = 'cd /opt/ogp-bot-2 && read -r T && grep -v "^DISCORD_TOKEN=" .env > .env.new && printf "DISCORD_TOKEN=%s\n" "$T" | cat - .env.new > .env && rm .env.new && chmod 600 .env && chown ogpbot:ogpbot .env && systemctl enable --now ogp-bot-2 && systemctl restart ogp-bot-2 && sleep 8 && journalctl -u ogp-bot-2 -n 6 --no-pager -o cat'
$token | ssh -i $key $server $remote
Write-Host ''
Write-Host 'Готово. Если выше «Запущен как …» — второй бот работает.'
