@echo off
cd /d "%~dp0"
start "Servidor" cmd /k "npm start"


start "Ngrok" cmd /k "ngrok http --domain=legible-chipmunk-only.ngrok-free.app 3000"

