@echo off
rem Stops the bot started by start-hidden.vbs or start.bat (only node.exe running src/index.js, other node processes are untouched)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*src/index.js*' -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*start.bat*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('stopped ' + $_.ProcessId) }"
pause
