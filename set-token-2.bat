@echo off
chcp 65001 >nul
rem Вписать токен второго бота на сервер и запустить его (токен вводится скрытно, никуда не сохраняется)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\set-token-2.ps1"
pause
