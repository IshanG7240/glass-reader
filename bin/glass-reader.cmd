@echo off
rem Windows launcher (bin/glass-reader is the Linux one).
rem Usage: glass-reader [--toggle | --show | --hide | --quit | --background | --claude-picker | FILE]
rem Hands the arguments to the running reader over its pipe, or starts it.
node -e "require(process.argv[1]).launch(process.argv.slice(2)).then((r) => { if (!r.ok) { console.error(r.error); process.exit(1); } })" "%~dp0claude-to-reader.js" %*
