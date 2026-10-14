@echo off
chcp 65001 >nul
rem Отправляет новый код бота на сервер и перезапускает его. База и .env на сервере не трогаются.
cd /d "%~dp0"
rem адрес сервера (например root@1.2.3.4) — в файле deploy\server.local, он не попадает в git
if not exist deploy\server.local (echo Создайте файл deploy\server.local с адресом сервера, например: root@1.2.3.4 & pause & exit /b 1)
set /p SERVER=<deploy\server.local
set KEY=-i "%USERPROFILE%\.ssh\ogp_server"

echo [1/3] Упаковка кода...
tar -czf "%TEMP%\ogp-update.tgz" src assets/logo.webp package.json package-lock.json deploy
if errorlevel 1 goto fail

echo [2/3] Отправка на сервер — если спросит пароль — введите его (символы не видны)...
scp %KEY% "%TEMP%\ogp-update.tgz" %SERVER%:/tmp/
if errorlevel 1 goto fail

echo [3/3] Установка и перезапуск — если спросит пароль — введите его ещё раз...
ssh %KEY% %SERVER% "rm -rf /opt/ogp-bot/src && tar -xzf /tmp/ogp-update.tgz -C /opt/ogp-bot && cd /opt/ogp-bot && npm ci --omit=dev --no-audit --no-fund && chown -R ogpbot:ogpbot /opt/ogp-bot && systemctl restart ogp-bot && sleep 5 && journalctl -u ogp-bot -n 15 --no-pager"
if errorlevel 1 goto fail

echo.
echo Готово: бот на сервере обновлён.
pause
exit /b 0

:fail
echo.
echo Ошибка — обновление не завершено. Пришлите текст выше.
pause
exit /b 1
