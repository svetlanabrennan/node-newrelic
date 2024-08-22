@echo off
REM Call the PowerShell script
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1

REM Echo the exit code
echo %ERRORLEVEL%
