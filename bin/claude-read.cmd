@echo off
rem Open this Claude Code session in Glass Reader (Windows; bin/claude-read is the Linux one).
rem In Claude Code, type:  ! claude-read
node "%~dp0claude-to-reader.js" --last %*
