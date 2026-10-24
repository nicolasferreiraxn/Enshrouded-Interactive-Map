@echo off
rem Compila o mapa (a DLL dos pins em injector\marcador é compilada e embutida automaticamente pelo build.rs)
rem e deixa o exe pronto em release\
setlocal
cd /d "%~dp0app" || exit /b 1
call npm install || exit /b 1
call npm run dist || exit /b 1
cd /d "%~dp0"
if not exist release mkdir release
copy /y "app\src-tauri\target\release\embervale-map.exe" "release\Mapa Interactive Enshrouded.exe" >nul || exit /b 1
echo.
echo Pronto: release\Mapa Interactive Enshrouded.exe
