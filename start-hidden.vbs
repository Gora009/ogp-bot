' Start the bot in the background (no window). Uses start.bat, which restarts the bot if it crashes.
' Stop: stop-bot.bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c start.bat", 0, False
