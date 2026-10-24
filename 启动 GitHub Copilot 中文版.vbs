Option Explicit
Dim shell, fso, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
launcher = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "启动 GitHub Copilot 中文版.cmd")
shell.Run """" & launcher & """", 0, False
