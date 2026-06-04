@echo off
echo Starting Mobik 2D Animator...
echo.

:: Build TypeScript if dist folder doesn't exist
if not exist "dist" (
    echo Building TypeScript...
    call npm run build
    echo.
)

:: Start the application
echo Launching application...
call npm start
