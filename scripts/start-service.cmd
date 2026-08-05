@echo off
REM Launcher for the always-on orch service (Task Scheduler AtLogOn).
REM
REM NOTE: this file MUST keep CRLF line endings. cmd.exe mis-parses an LF-only
REM batch file (it eats the first character of every line). See .gitattributes.
REM
REM Why a wrapper instead of a bare -Execute action:
REM   1. cwd must be the repo root - dotenv/config loads .env from cwd, and
REM      REPOS_BASE_DIR=../ in .env is cwd-relative.
REM   2. Node is pinned to an explicit fnm version dir, NOT
REM      %APPDATA%\fnm\aliases\default - that symlink tracks the fnm *default*
REM      (v22 today) while .nvmrc asks for 24.
REM   3. Task Scheduler discards stdout/stderr; we need a log to debug a boot.
REM
REM claude / git / gh need no PATH surgery here: they live on the registry user
REM PATH (%USERPROFILE%\.local\bin, Program Files\Git\cmd, Program Files\GitHub
REM CLI), which Task Scheduler inherits. runSupportQuery spawns `claude` by bare
REM name, so that inheritance is load-bearing - see README "Always-on LAN service".

setlocal

set "ORCH_DIR=%~dp0.."
set "NODE_EXE=%APPDATA%\fnm\node-versions\v24.14.1\installation\node.exe"
set "LOG=%ORCH_DIR%\orch-service.log"

cd /d "%ORCH_DIR%" || exit /b 1

if not exist "%NODE_EXE%" (
  echo [start-service] node not found at %NODE_EXE% >> "%LOG%"
  echo [start-service] run `fnm install 24`, or repoint NODE_EXE in this script >> "%LOG%"
  exit /b 1
)

if not exist "dist\server\index.js" (
  echo [start-service] dist\server\index.js missing - run `pnpm build` first >> "%LOG%"
  exit /b 1
)

echo. >> "%LOG%"
echo ===== start-service %DATE% %TIME% ===== >> "%LOG%"
"%NODE_EXE%" dist\server\index.js >> "%LOG%" 2>&1
echo ===== exited with %ERRORLEVEL% at %DATE% %TIME% ===== >> "%LOG%"

endlocal
