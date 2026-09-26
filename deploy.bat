@echo off
REM Deploiement du bot WhatsApp en daemon via PM2 (Windows).
REM Usage : double-clic ou .\deploy.bat
cd /d %~dp0
node --version >nul 2>&1
if errorlevel 1 ( echo [ERREUR] Node.js introuvable. & exit /b 1 )

echo [1/4] Installation des dependances...
call npm install --omit=dev
if errorlevel 1 ( echo [ERREUR] npm install a echoue. & exit /b 1 )

echo [2/4] Verification PM2...
where pm2 >nul 2>nul
if errorlevel 1 ( echo PM2 absent, installation... & call npm install -g pm2 )

echo [3/4] Demarrage du bot...
call pm2 start ecosystem.config.js --update-env
if errorlevel 1 ( echo [ERREUR] pm2 start a echoue. & exit /b 1 )

echo [4/4] Sauvegarde...
call pm2 save
echo.
echo [OK] Bot deploye. Logs : pm2 logs whatsapp-bot
echo Interface : http://localhost:3000  ^| Admin : http://localhost:3000/admin
