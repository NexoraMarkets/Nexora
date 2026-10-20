@echo off
setlocal
set "APP_DIR=%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%APP_DIR%server.js" (
  echo Nexora project files are incomplete.
  pause
  exit /b 1
)
if not exist "%APP_DIR%.env" (
  echo Copy your .env file into this folder first.
  echo For an existing BANK installation, use its current .env file.
  pause
  exit /b 1
)
if not exist "%NODE%" (
  echo Node.js 22 was not found at:
  echo %NODE%
  pause
  exit /b 1
)
if not exist "%APP_DIR%node_modules\express" (
  cd /d "%APP_DIR%"
  call npm install --omit=dev
  if errorlevel 1 exit /b 1
)
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',3000);$c.Close();exit 0}catch{exit 1}"
if not errorlevel 1 (
  echo Nexora BANK is already running on localhost:3000. No extra browser tab was opened.
  exit /b 0
)
start "Nexora BANK server" /D "%APP_DIR%" "%NODE%" "%APP_DIR%server.js"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient;try{$c.Connect('127.0.0.1',3000);$c.Close();exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Nexora BANK did not start. Check the server window.
  pause
  exit /b 1
)
start "" "http://localhost:3000/"
endlocal