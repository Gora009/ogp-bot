@echo off
rem Запуск бота двойным щелчком. Сам переходит в папку проекта и перезапускает бота, если он упал.
cd /d "%~dp0"
:loop
node src/index.js
rem код 2 = бот уже запущен в другом окне: не перезапускаем по кругу
if errorlevel 2 goto stop
echo.
echo Bot stopped. Restart in 5 seconds (close this window to quit)...
timeout /t 5 /nobreak >nul
goto loop
:stop
echo.
echo Bot is already running in another window. Close that one first.
pause
