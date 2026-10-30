@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Open SuperComputer setup did not complete. Review the error above.
  pause
  exit /b 1
)
exit /b 0
