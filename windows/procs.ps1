# Prints one snapshot from procs.cs: {"fg":pid,"title":"...","procs":[[pid,ppid,"name.exe","startFileTime"],...]}
# startFileTime matches the "procStart" Claude Code writes in ~/.claude/sessions/<pid>.json.
# Used by bin/claude-to-reader.js when run from a terminal; the reader's window host has the
# same code built in, so its Ctrl+Alt+C doesn't pay PowerShell's start-up.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) # window titles can be any script
Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $PSScriptRoot 'procs.cs'))
[Console]::Out.WriteLine([GlassReaderProcs]::Snapshot())
