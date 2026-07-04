@echo off
REM Tabduct native host launcher (Windows). Chrome invokes this via the
REM native-messaging manifest. stdout carries protocol frames only; log to stderr.
REM `register` writes node_path.txt (absolute node) so Chrome's minimal-env spawn
REM resolves the right runtime; fall back to PATH `node` if absent.
setlocal
set "DIR=%~dp0"
set "NODE=node"
if exist "%DIR%node_path.txt" set /p NODE=<"%DIR%node_path.txt"
"%NODE%" "%DIR%src\index.js"
exit /B %ERRORLEVEL%
