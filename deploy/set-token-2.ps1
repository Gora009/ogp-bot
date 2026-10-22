# Записывает токен второго бота в /opt/ogp-bot-2/.env на сервере и запускает его.
# Токен вводится здесь скрытно и уходит на сервер по SSH — в чат, в git и в историю команд он не попадает.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
$server = (Get-Content 'deploy\server.local' -TotalCount 1).Trim()
$key = Join-Path $env:USERPROFILE '.ssh\ogp_server'

$secure = Read-Host 'Токен второго бота (Developer Portal -> Bot -> Reset Token), ввод не виден' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if ($token -notmatch '^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$') { Write-Host 'Это не похоже на токен бота. Ничего не изменено.'; exit 1 }

# токен идёт через стандартный ввод, а не в командной строке
$remote = 'cd /opt/ogp-bot-2 && read -r T && grep -v "^DISCORD_TOKEN=" .env > .env.new && printf "DISCORD_TOKEN=%s\n" "$T" | cat - .env.new > .env && rm .env.new && chmod 600 .env && chown ogpbot:ogpbot .env && systemctl enable --now ogp-bot-2 && systemctl restart ogp-bot-2 && sleep 8 && journalctl -u ogp-bot-2 -n 6 --no-pager -o cat'
$token | ssh -i $key $server $remote
Write-Host ''
Write-Host 'Готово. Если выше «Запущен как …» — второй бот работает.'
