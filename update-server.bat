@echo off
chcp 65001 >nul
rem Обновляет одного бота на сервере: update-server.bat 1 — первый (ветка main), update-server.bat 2 — второй (ветка server2).
rem Код берётся из ветки git (только закоммиченное). База и .env на сервере не трогаются.
cd /d "%~dp0"
if not exist deploy\server.local (echo Создайте файл deploy\server.local с адресом сервера, например: root@1.2.3.4 & pause & exit /b 1)
set /p SERVER=<deploy\server.local
set KEY=-i "%USERPROFILE%\.ssh\ogp_server"

set BOT=%1
if "%BOT%"=="" set /p BOT=Какого бота обновить? 1 — первый, 2 — второй:
if "%BOT%"=="1" (set BRANCH=main& set DIR=/opt/ogp-bot& set SVC=ogp-bot) else if "%BOT%"=="2" (set BRANCH=server2& set DIR=/opt/ogp-bot-2& set SVC=ogp-bot-2) else (echo Нужно 1 или 2. & pause & exit /b 1)

echo [1/3] Упаковка ветки %BRANCH%...
git archive --format=tar.gz -o "%TEMP%\ogp-update-%BOT%.tgz" %BRANCH% src assets/logo.webp package.json package-lock.json deploy
if errorlevel 1 goto fail

echo [2/3] Отправка на сервер...
scp %KEY% "%TEMP%\ogp-update-%BOT%.tgz" %SERVER%:/tmp/
if errorlevel 1 goto fail

echo [3/3] Установка и перезапуск %SVC%...
ssh %KEY% %SERVER% "rm -rf %DIR%/src && tar -xzf /tmp/ogp-update-%BOT%.tgz -C %DIR% && cd %DIR% && npm ci --omit=dev --no-audit --no-fund && chown -R ogpbot:ogpbot %DIR% && systemctl restart %SVC% && sleep 5 && journalctl -u %SVC% -n 15 --no-pager"
if errorlevel 1 goto fail

echo.
echo Готово: бот %BOT% обновлён.
pause
exit /b 0

:fail
echo.
echo Ошибка — обновление не завершено. Пришлите текст выше.
pause
exit /b 1
