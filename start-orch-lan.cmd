@echo off
REM Restart the always-on orch service and open the dashboard.
REM
REM NOTE: this file MUST keep CRLF line endings - cmd.exe mis-parses an LF-only
REM batch file (it eats the first character of every line). Same rule as
REM scripts\start-service.cmd; see .gitattributes.
REM
REM orch runs as a Task Scheduler task (AtLogOn) that serves the compiled
REM dist\server on port 3011, dashboard included - there is no separate Vite
REM port to start. So this restarts that one service rather than launching a
REM competing `pnpm serve:prod`, which would take the LAN service down for
REM anyone using it.

setlocal enabledelayedexpansion
title orch - restart service
cd /d "%~dp0"

REM Pin PATH to the Windows system dirs. Launched from the desktop shortcut the
REM inherited PATH is fine, but run from a Git Bash shell it puts coreutils
REM first, and GNU `timeout` takes different arguments than the Windows one -
REM the wait loop then busy-spins instead of sleeping. schtasks, netstat,
REM findstr, taskkill, ping and ipconfig all live in System32.
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem"

if not exist "dist\server\index.js" (
  echo [orch] dist\server\index.js is missing - the service cannot start.
  echo [orch] Run `pnpm build` in %CD% first.
  pause
  exit /b 1
)

echo [orch] Stopping the orch service ...
schtasks /End /TN "orch" >nul 2>&1

REM Ending the task kills the cmd wrapper but leaves its node child alive
REM holding port 3011, so the restart would hit EADDRINUSE. Kill the listener
REM by PID; /T takes the tree.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"TCP .*:3011 .*LISTENING"') do (
  echo [orch]   killing orphaned node PID %%P
  taskkill /PID %%P /T /F >nul 2>&1
)

echo [orch] Starting the orch service ...
schtasks /Run /TN "orch" >nul 2>&1
if errorlevel 1 (
  echo [orch] Could not start the scheduled task "orch".
  echo [orch] Check it exists:  schtasks /Query /TN "orch"
  pause
  exit /b 1
)

echo [orch] Waiting for port 3011 ...
set /a TRIES=0
:wait
netstat -ano | findstr /r /c:"TCP .*:3011 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto ready
set /a TRIES+=1
if !TRIES! gtr 60 (
  echo [orch] Timed out. Check the service log: %CD%\orch-service.log
  pause
  exit /b 1
)
REM `ping` rather than `timeout`: timeout.exe aborts with "Input redirection
REM is not supported" whenever stdin is not a real console, which is the case
REM when this script is run from a pipe or a task runner. ping -n 3 ~= 2s.
ping -n 3 127.0.0.1 >nul
goto wait

:ready
echo [orch] Up.
echo [orch]   Local : http://localhost:3011
REM Print every IPv4 address rather than guessing which one is "the" LAN
REM address - this machine also has Tailscale and Hyper-V adapters, and
REM whichever ipconfig lists first is not necessarily the one to share.
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  set "IP=%%I"
  echo [orch]   Also  : http://!IP: =!:3011
)

start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "http://localhost:3011"

echo.
echo [orch] The service keeps running after this window closes.
ping -n 7 127.0.0.1 >nul
endlocal
