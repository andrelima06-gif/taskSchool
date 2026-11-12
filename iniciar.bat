@echo off
setlocal
title TaskSchool - Servidor Local
cd /d "%~dp0"

echo ============================================
echo   TaskSchool - Gerenciador de Tarefas
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo Baixe e instale em https://nodejs.org (versao 22 ou superior)
  echo e execute este arquivo novamente.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [1/2] Instalando dependencias... aguarde.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencias ja instaladas.
)

echo.
echo [2/2] Iniciando o servidor...
echo.
echo     URL:  http://localhost:3000
echo     API:  http://localhost:3000/api/tasks
echo.
echo     O navegador sera aberto em instantes.
echo     Para encerrar o servidor: pressione Ctrl+C nesta janela.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

call npm start

echo.
echo Servidor encerrado.
pause
