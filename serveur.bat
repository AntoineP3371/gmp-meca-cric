@echo off
SET NODE=C:\Users\antpietri\nodejs-portable\node-v24.18.0-win-x64\node.exe
SET DOSSIER=%~dp0
REM Meme port que les autres projets : ne lance donc qu'UNE application a la fois.
SET PORT=8080

echo.
echo === Demarrage du serveur local (port %PORT%) ===

REM Si le port est occupe par un AUTRE projet, on s'arrete : sinon le tunnel
REM publierait silencieusement le mauvais site dans le casque.
curl -s http://127.0.0.1:%PORT%/ | findstr /C:"Statique en realite mixte" > nul 2>&1
if not errorlevel 1 (
    echo Un serveur de CE projet tourne deja sur le port %PORT%, on le reutilise.
    goto :tunnel
)
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" > nul 2>&1
if not errorlevel 1 (
    echo.
    REM Pas de parentheses dans les echo : elles fermeraient ce bloc "if".
    echo ERREUR : le port %PORT% est occupe par une AUTRE application,
    echo probablement VR CEC, ou un serveur laisse ouvert precedemment.
    echo.
    echo Ferme la fenetre noire "Serveur local" de l'autre projet, puis
    echo relance ce fichier.
    echo.
    pause
    exit /b
)

pushd "%DOSSIER%"
start "Serveur local - VR Statique" cmd /k ""%NODE%" server.js %PORT%"
popd

echo Attente du demarrage de Node...
timeout /t 5 /nobreak > nul

echo.
echo === Verification que le serveur repond ===
curl -s http://127.0.0.1:%PORT%/ | findstr /C:"Statique en realite mixte" > nul 2>&1
if errorlevel 1 (
    echo.
    echo ERREUR : le serveur ne repond pas correctement sur le port %PORT%.
    echo Regarde la fenetre "Serveur local - VR Statique" pour voir l'erreur.
    echo.
    pause
    exit /b
)
echo Serveur OK !

:tunnel
echo.
echo === Ouverture du tunnel HTTPS ===
echo Une adresse https://xxxxx.trycloudflare.com va s'afficher.
echo Tape cette adresse dans Wolvic sur ton Quest 3.
echo.
"%DOSSIER%cloudflared.exe" tunnel --url http://127.0.0.1:%PORT%

pause
