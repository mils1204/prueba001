@echo off
rem Abre el club en http://localhost:8080. Cierra esta ventana para apagarlo.
set "PATH=%LOCALAPPDATA%\Programs\node-v24.22.2-win-x64;%PATH%"
cd /d "%~dp0"
node server.js
pause
