@echo off
REM ---------------------------------------------------------------------------
REM Rebuilds dist\CoachIQ_Rotation_Planner_Client.html -- the single self-contained file the client ships
REM as -- plus dist\sw.js, the service worker that makes it installable offline.
REM Double-click it, or run `build.bat` from any directory.
REM
REM Runs `npm run build`, i.e. scripts\build-prod.mjs: concatenates the src\*.js
REM modules in dependency order, inlines them with styles.css into src\index.html,
REM then hardens the result -- terser minifies and drops console/debugger,
REM javascript-obfuscator renames identifiers and encodes string literals, and
REM the HTML and CSS are minified. No source maps are emitted.
REM
REM The shipped dist\CoachIQ_Rotation_Planner_Client.html is therefore NOT readable. For a readable build,
REM run `npm run build:dev`, which writes dist-dev\CoachIQ_Rotation_Planner_Client.html and leaves dist\
REM alone. src\ is never modified by either.
REM
REM This build has npm devDependencies, so `npm install` must have been run once.
REM This script runs it automatically if node_modules\ is missing.
REM
REM Run `npm test` for the unit tests (test\*.test.mjs) and `npm run verify` to
REM confirm in a headless browser that the hardened build renders identically to
REM the readable one.
REM ---------------------------------------------------------------------------
setlocal

REM Work from this script's own folder, whatever directory it was launched from.
pushd "%~dp0"

REM `call` is required throughout: npm is npm.cmd, and without it this batch file
REM would hand over control and never reach the lines below.
if not exist "node_modules" (
  echo Installing build dependencies...
  call npm install
  REM Use `if errorlevel 1` here, NOT `if %ERRORLEVEL% NEQ 0` or a `set` capture
  REM of %ERRORLEVEL%: cmd.exe parses this whole parenthesised block up front
  REM and expands every bare %VAR% at parse time, before `npm install` even
  REM runs, so either form would always test the errorlevel from before the
  REM install. `if errorlevel 1` performs no variable expansion -- it queries
  REM the live errorlevel at execution time -- so it works correctly here.
  REM Also: jump out via `goto` rather than `exit /b` directly inside this
  REM nested if-in-if block -- `exit /b` executed two parens deep does not
  REM reliably propagate its code to the invoking process (verified: it
  REM silently becomes exit 0), so the actual exit happens at :install_failed,
  REM outside every parenthesised block.
  if errorlevel 1 goto :install_failed
  echo.
)

echo Building coachiq-stats-client ^(hardened^)...
echo.

call npm run build
set BUILD_EXIT=%ERRORLEVEL%

echo.
if %BUILD_EXIT% NEQ 0 (
  echo *** BUILD FAILED ^(exit code %BUILD_EXIT%^) -- dist\ was NOT updated. ***
) else (
  echo Build OK -- dist\CoachIQ_Rotation_Planner_Client.html updated ^(minified + obfuscated^).
  for %%F in ("%~dp0dist\CoachIQ_Rotation_Planner_Client.html") do echo    %%~zF bytes, %%~tF
  for %%F in ("%~dp0dist\sw.js") do echo    sw.js: %%~zF bytes, %%~tF
)

popd

REM Hold the window open when there'd be nobody left to read it -- a double-click
REM from Explorer closes the console the instant this script ends. Pass `nopause`
REM (build.bat nopause) to skip it when calling from another script.
if /i "%~1"=="nopause" goto :done
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

:done

exit /b %BUILD_EXIT%

:install_failed
echo *** npm install FAILED -- cannot build. ***
popd
exit /b 1
