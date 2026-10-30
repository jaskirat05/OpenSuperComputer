@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "PATH=%ROOT%.runtime\node24;%USERPROFILE%\.local\bin;%PATH%"
if /I "%~1"=="comfy" goto :comfy
if /I "%~1"=="next" goto :next

where node >nul 2>nul
if errorlevel 1 goto :missing_node
where npm >nul 2>nul
if errorlevel 1 goto :missing_npm
where uv >nul 2>nul
if errorlevel 1 goto :missing_uv

if not exist "%ROOT%comfy_service\.env" copy "%ROOT%comfy_service\.env.example" "%ROOT%comfy_service\.env" >nul
if not exist "%ROOT%node_modules\next" (
  echo Installing the Next.js dependencies...
  pushd "%ROOT%"
  call npm ci
  if errorlevel 1 goto :npm_install_failed
  popd
)
set "COMFY_SERVICE_URL=http://127.0.0.1:8012"
set "COMFY_WORKFLOWS_DIR=%ROOT%workflows"
set "VFX_GURU_ORIGINS=http://localhost:3000,http://127.0.0.1:3000"
if not defined COMFY_SERVICE_TOKEN for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"COMFY_SERVICE_TOKEN=" "%ROOT%comfy_service\.env"') do set "COMFY_SERVICE_TOKEN=%%B"

start "Open SuperComputer - Comfy MCP :8012" "%ComSpec%" /k ""%~f0" comfy"
start "Open SuperComputer - Next.js :3000" "%ComSpec%" /k ""%~f0" next"
echo Launched the ComfyUI MCP bridge and Open SuperComputer in separate terminal windows.
echo App: http://localhost:3000
echo Leave those server windows open while using the app. This launcher can now be closed.
pause >nul
exit /b 0

:missing_node
echo ERROR: Node.js is missing. Run install-open-supercomputer.bat first.
goto :startup_failed
:missing_npm
echo ERROR: npm is missing from the installed Node.js runtime. Run install-open-supercomputer.bat again.
goto :startup_failed
:missing_uv
echo ERROR: uv is missing. Run install-open-supercomputer.bat first.
goto :startup_failed
:npm_install_failed
popd
echo ERROR: npm dependency installation failed.
goto :startup_failed
:startup_failed
pause
exit /b 1

:comfy
cd /d "%ROOT%comfy_service"
set "COMFY_WORKFLOWS_DIR=%ROOT%workflows"
set "VFX_GURU_ORIGINS=http://localhost:3000,http://127.0.0.1:3000"
set "UV_PROJECT_ENVIRONMENT=%ROOT%comfy_service\.venv-launch"
uv python install 3.12
if errorlevel 1 (echo Could not install the managed Python 3.12 runtime.& pause & exit /b 1)
set "VENV_PY=%UV_PROJECT_ENVIRONMENT%\Scripts\python.exe"
if not exist "%VENV_PY%" goto :create_python_env
goto :sync_python_deps
:create_python_env
echo Creating or repairing the Comfy MCP Python environment...
uv venv --clear --python 3.12 "%UV_PROJECT_ENVIRONMENT%"
if errorlevel 1 (echo Could not create a Python 3.12+ environment. Check the Python installation above.& pause & exit /b 1)
:sync_python_deps
echo Syncing ComfyUI MCP dependencies...
uv sync --project "%ROOT%comfy_service" --frozen --python 3.12
if errorlevel 1 (echo Dependency setup failed. Review the uv error above.& pause & exit /b 1)
"%UV_PROJECT_ENVIRONMENT%\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8012 --env-file .env
pause
exit /b

:next
cd /d "%ROOT%"
set "COMFY_SERVICE_URL=http://127.0.0.1:8012"
set "NEXT_DIST_DIR=.next-open-supercomputer"
call npm run dev -- --hostname 127.0.0.1 --port 3000
pause
