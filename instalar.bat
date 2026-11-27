@echo off
title Instalador Roztypollo Bot - Windows
echo ==========================================
echo   INSTALADOR ROZTYPOLLO BOT (WINDOWS)
echo ==========================================

if not exist data mkdir data
if not exist sessions\main mkdir sessions\main
if not exist sessions\subbots mkdir sessions\subbots
if not exist temp mkdir temp
if not exist logs mkdir logs
if not exist backups mkdir backups

if not exist .env (
  copy .env.example .env
  echo [OK] Archivo .env creado.
)

call npm install

(
echo @echo off
echo title Roztypollo Bot
echo node index.js
echo pause
) > iniciar-bot.bat

(
echo @echo off
echo del /q temp\* 2^>nul
echo taskkill /f /im node.exe 2^>nul
echo start "" cmd /k "node index.js"
) > reiniciar-emergencia.bat

(
echo @echo off
echo powershell -ExecutionPolicy Bypass -File respaldar-todo.ps1
echo pause
) > respaldar-todo.bat

echo.
echo [LISTO] Ejecuta iniciar-bot.bat para arrancar.
pause
