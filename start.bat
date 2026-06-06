@echo off
setlocal enableextensions
cd /d "%~dp0"

echo ============================================
echo    PRONUNCIATION LAB - launcher
echo ============================================
echo.

REM ---- 1. Ensure ffmpeg is available (needed by yt-dlp for video merge) ----
set "FFDIR="
where ffmpeg >nul 2>&1
if %errorlevel%==0 (
  echo [ffmpeg] found on PATH
  goto :ollama
)
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" (
  set "FFDIR=%~dp0ffmpeg\bin"
  echo [ffmpeg] using bundled copy in .\ffmpeg\bin
  goto :setpath
)

echo [ffmpeg] not found - downloading a static build (first run only)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $u='https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'; $z=Join-Path $env:TEMP 'ffmpeg_dl.zip'; Write-Host 'Downloading ffmpeg...'; Invoke-WebRequest -Uri $u -OutFile $z; $tmp=Join-Path $env:TEMP 'ffmpeg_ex'; if(Test-Path $tmp){Remove-Item $tmp -Recurse -Force}; Write-Host 'Extracting...'; Expand-Archive $z $tmp -Force; $bin=(Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).DirectoryName; $dest='%~dp0ffmpeg\bin'; if(Test-Path $dest){Remove-Item $dest -Recurse -Force}; New-Item -ItemType Directory -Force -Path '%~dp0ffmpeg' | Out-Null; Copy-Item -Path $bin -Destination $dest -Recurse -Force; Remove-Item $z -Force; Remove-Item $tmp -Recurse -Force; Write-Host 'ffmpeg installed into .\ffmpeg\bin' } catch { Write-Host ('ffmpeg auto-install failed: ' + $_.Exception.Message); exit 1 }"

if exist "%~dp0ffmpeg\bin\ffmpeg.exe" (
  set "FFDIR=%~dp0ffmpeg\bin"
  echo [ffmpeg] install complete
) else (
  echo [ffmpeg] WARNING: automatic install failed.
  echo          Video download/merge may fail. Install ffmpeg manually
  echo          from https://ffmpeg.org/download.html and re-run this file.
)

:setpath
if defined FFDIR set "PATH=%FFDIR%;%PATH%"

REM ---- 2. Ollama: CPU inference tuning + ensure running ----
:ollama
REM (1) keep models in RAM 30 min to avoid reloading 4b<->2b each run
REM (3) one request at a time -> do not split limited CPU compute
REM setx = persist for future launches (incl. tray app); set = apply to this session
setx OLLAMA_KEEP_ALIVE 30m >nul
setx OLLAMA_NUM_PARALLEL 1 >nul
set "OLLAMA_KEEP_ALIVE=30m"
set "OLLAMA_NUM_PARALLEL=1"
set "OLLAMA_ORIGINS=http://localhost:8080"

powershell -NoProfile -Command "try{ $null=Invoke-RestMethod -Uri 'http://localhost:11434/api/tags' -TimeoutSec 3; exit 0 }catch{ exit 1 }"
if %errorlevel%==0 (
  echo [ollama] already running - tuning saved, but RESTART Ollama once to apply
  echo          ^(quit the Ollama tray icon, then run this file again^)
  goto :launch
)
where ollama >nul 2>&1
if %errorlevel%==0 goto :startollama
echo [ollama] WARNING: 'ollama' not found on PATH. Install from https://ollama.com/download
goto :launch

:startollama
echo [ollama] starting with KEEP_ALIVE=30m, NUM_PARALLEL=1 ...
start "Ollama" cmd /k "ollama serve"
timeout /t 3 >nul
goto :launch

:launch
echo.
echo Starting backend (port 8000) and frontend (port 8080)...
start "PronLab Backend"  cmd /k "python -m uvicorn main:app --port 8000"
timeout /t 2 >nul
start "PronLab Frontend" cmd /k "python -m http.server 8080"
timeout /t 2 >nul
start "" http://localhost:8080/pronunciation_learner.html

echo.
echo   Backend : http://localhost:8000   (health check: /health)
echo   App     : http://localhost:8080/pronunciation_learner.html
echo.
echo This window can be closed. The two opened windows keep the servers running.
echo.
pause
endlocal
