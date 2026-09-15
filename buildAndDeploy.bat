@echo off
REM ---------------------------------------------------------------------------
REM Builds AND publishes the app to GitHub Pages in one step.
REM Double-click it, or run `buildAndDeploy.bat` from any directory.
REM
REM Use this instead of build.bat when you want coaches' phones to actually get
REM the change. build.bat only refreshes dist\ on this machine; `git push` only
REM publishes the SOURCE. Pages serves from the `gh-pages` branch, which is
REM updated by nothing except the subtree push this script runs last.
REM
REM That gap has bitten this project once already: contract v3 was merged to
REM main, verified locally and pushed, while every phone kept loading the
REM previous build and refusing the new roster payloads with "made by a newer
REM version of the Rotation Planner". Nothing was broken -- the deployment
REM branch had simply never been updated. This script exists so that cannot
REM happen again, by making the deploy impossible to forget or half-do.
REM
REM Runs `npm run deploy`, i.e. scripts\deploy.mjs, which in order:
REM   1. refuses if the current branch is ahead of origin  (build output whose
REM      source is not on GitHub is output nobody can reproduce or bisect)
REM   2. npm test                                          (105+ unit tests)
REM   3. npm run build                                     (hardened dist\)
REM   4. refuses if the rebuild left dist\ uncommitted     (see below -- this is
REM      the check that matters most)
REM   5. npm run verify                                    (headless-browser
REM      parity of the obfuscated bundle, plus the CIQR3 golden vector decoded
REM      and rendered in the shipped file)
REM   6. git subtree push --prefix dist origin gh-pages
REM   7. polls the live URL until it serves the bytes just verified
REM
REM Step 4 is the subtle one. `git subtree push` publishes the COMMITTED dist\,
REM not the working tree, so a rebuild whose output differs from the last commit
REM would ship stale bytes while the verify you just watched pass applied to
REM different ones. If it stops there, commit dist\ and run this again.
REM
REM A rejected subtree push is NOT retried with --force: that rewrites the
REM deployment branch and is a decision for a person. The script prints the
REM documented recovery command and stops.
REM
REM Nothing is published unless every check above passes, and the push is the
REM last thing that happens. To rehearse the whole thing without publishing:
REM   npm run deploy:dry-run
REM
REM This build has npm devDependencies, so `npm install` must have been run once.
REM This script runs it automatically if node_modules\ is missing. It also needs
REM git on PATH and push rights to origin.
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

echo Building and deploying coachiq-stats-client to GitHub Pages...
echo.

call npm run deploy
set DEPLOY_EXIT=%ERRORLEVEL%

echo.
if %DEPLOY_EXIT% NEQ 0 (
  echo *** DEPLOY FAILED ^(exit code %DEPLOY_EXIT%^) -- gh-pages was NOT updated. ***
  echo     Read the message above: the checks stop BEFORE publishing, so the
  echo     live site is untouched and still serving the previous build.
) else (
  echo Deploy OK -- gh-pages now serves this build.
  for %%F in ("%~dp0dist\CoachIQ_Rotation_Planner_Client.html") do echo    %%~zF bytes, %%~tF
  for %%F in ("%~dp0dist\sw.js") do echo    sw.js: %%~zF bytes, %%~tF
  echo.
  echo Open the app on the phone once while online. The service worker is
  echo network-first, so it fetches the new build instead of the cached one.
  echo The version line in the ... menu confirms which build is running.
)

popd

REM Hold the window open when there'd be nobody left to read it -- a double-click
REM from Explorer closes the console the instant this script ends. Pass `nopause`
REM (buildAndDeploy.bat nopause) to skip it when calling from another script.
if /i "%~1"=="nopause" goto :done
echo %CMDCMDLINE% | find /i "/c" >nul
if not errorlevel 1 pause

:done

exit /b %DEPLOY_EXIT%

:install_failed
echo *** npm install FAILED -- cannot build or deploy. ***
popd
exit /b 1
