#Requires -Version 7.0
<#
.SYNOPSIS
  Sets Glass Reader up on Windows for reading Claude Code sessions.

.DESCRIPTION
  The Windows version runs on parts Windows already trusts (Node, Windows PowerShell and
  Microsoft's WebView2), so it works with Smart App Control on, where Electron is blocked.

  - installs the npm dependencies
  - downloads Microsoft's WebView2 SDK (three signed DLLs) into %LOCALAPPDATA%\glass-reader
  - puts bin\ on your user PATH, for the claude-read and glass-reader commands
  - starts the reader at sign-in, hidden in the background, and adds it to the Start menu
  - starts it now

  The reader registers its own shortcuts: Ctrl+Alt+C opens the Claude Code session in the
  window you're looking at (the active Windows Terminal tab), Ctrl+Alt+R shows / hides it.

  -Hook also adds Claude Code's Stop hook (~\.claude\settings.json, backed up first): every
  answer of 250+ words is then queued in the reader with a notification. Off by default.

.EXAMPLE
  scripts\install-windows.ps1
.EXAMPLE
  scripts\install-windows.ps1 -ToggleKey 'Control+Shift+F9' -ReadKey 'Control+Shift+F10'
.EXAMPLE
  scripts\install-windows.ps1 -Uninstall
#>
param(
  # Electron-style accelerators ("Control+Alt+R", "Ctrl+Shift+F9", "Super+R"); 'none' for no shortcut.
  [string]$ToggleKey = 'Control+Alt+R',
  [string]$ReadKey = 'Control+Alt+C',
  [switch]$Hook,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$AppDir    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BinDir    = Join-Path $AppDir 'bin'
$Reader    = Join-Path $AppDir 'windows\reader.js'
$SdkDir    = Join-Path $env:LOCALAPPDATA 'glass-reader\webview2-sdk'
$SdkVer    = '1.0.2903.40'
$Settings  = Join-Path $HOME '.claude\settings.json'
$Startup   = Join-Path ([Environment]::GetFolderPath('Startup')) 'Glass Reader.lnk'
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Glass Reader.lnk'
$Conhost   = Join-Path $env:WINDIR 'System32\conhost.exe'
$HookCmd   = 'node "' + ($AppDir -replace '\\', '/') + '/bin/claude-to-reader.js" --hook'

function Step($msg) { Write-Host "  $msg" }

# ---------- PATH ----------
function Set-UserPath([bool]$add) {
  $cur = [Environment]::GetEnvironmentVariable('Path', 'User') ?? ''
  $parts = @($cur -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $BinDir.TrimEnd('\')) })
  if ($add) { $parts += $BinDir }
  $new = $parts -join ';'
  if ($new -ne $cur) { [Environment]::SetEnvironmentVariable('Path', $new, 'User') }
  if ($add -and -not (($env:Path -split ';') -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }
}

# ---------- Claude Code hook ----------
# Removes any Glass Reader Stop hook, then (with $add) adds the current one. Other hooks stay.
function Set-Hook([bool]$add) {
  if (-not (Test-Path $Settings)) {
    if (-not $add) { return $false }
    New-Item -ItemType Directory -Force (Split-Path $Settings) | Out-Null
    Set-Content -Path $Settings -Value '{}' -Encoding utf8NoBOM
  }
  $raw = Get-Content -Raw -Path $Settings
  $json = if ($raw.Trim()) { $raw | ConvertFrom-Json -AsHashtable } else { [ordered]@{} }
  $had = "$raw" -like '*claude-to-reader.js*'
  if (-not $add -and -not $had) { return $false }
  Copy-Item $Settings "$Settings.bak-glass-reader" -Force

  if (-not $json.Contains('hooks')) { $json['hooks'] = [ordered]@{} }
  $stop = @()
  foreach ($group in @($json['hooks']['Stop'] ?? @())) {
    $kept = @($group['hooks'] | Where-Object { -not ("$($_['command'])" -like '*claude-to-reader.js*') })
    if ($kept.Count) { $group['hooks'] = $kept; $stop += , $group }
  }
  if ($add) {
    $stop += , ([ordered]@{ hooks = @([ordered]@{ type = 'command'; command = $HookCmd; timeout = 10; async = $true }) })
  }
  if ($stop.Count) { $json['hooks']['Stop'] = $stop } else { $json['hooks'].Remove('Stop') }
  if ($json['hooks'].Count -eq 0) { $json.Remove('hooks') }

  $out = $json | ConvertTo-Json -Depth 100
  $null = $out | ConvertFrom-Json # refuse to write anything that doesn't read back
  Set-Content -Path $Settings -Value $out -Encoding utf8NoBOM
  return $true
}

# ---------- shortcuts ----------
# conhost --headless runs Node without a console window.
function New-Shortcut($path, [string[]]$readerArgs, $description) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($path)
  $lnk.TargetPath = $Conhost
  $lnk.Arguments = (@('--headless', 'node', "`"$Reader`"") + $readerArgs) -join ' '
  $lnk.WorkingDirectory = $AppDir
  $lnk.Description = $description
  $lnk.Save()
}

function Stop-Reader { node $Reader --quit 2>$null | Out-Null }

# ---------- uninstall ----------
if ($Uninstall) {
  Write-Host 'Removing Glass Reader from Windows:'
  Stop-Reader; Step 'stopped it'
  Remove-Item $Startup, $StartMenu -ErrorAction SilentlyContinue; Step 'removed the Startup and Start menu shortcuts'
  Set-UserPath $false; Step 'removed bin\ from your PATH'
  if (Set-Hook $false) { Step "removed the Stop hook from $Settings" }
  Write-Host "Done. Left in place: this folder, and $(Split-Path $SdkDir) (the WebView2 SDK and the reader's settings)."
  return
}

# ---------- install ----------
Write-Host "Setting up Glass Reader in $AppDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required: https://nodejs.org (or  winget install OpenJS.NodeJS.LTS)' }
$wv2 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if (-not $wv2) { $wv2 = Get-ItemProperty 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue }
if (-not $wv2) { throw 'The WebView2 Runtime is missing (Windows 11 has it built in): https://go.microsoft.com/fwlink/p/?LinkId=2124703' }

if (-not (Test-Path (Join-Path $AppDir 'node_modules\marked'))) {
  Step 'npm install…'
  Push-Location $AppDir
  try { npm install --no-audit --no-fund | Out-Host; if ($LASTEXITCODE) { throw 'npm install failed' } } finally { Pop-Location }
}

$dlls = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
if (@($dlls | Where-Object { -not (Test-Path (Join-Path $SdkDir $_)) }).Count) {
  Step "downloading Microsoft's WebView2 SDK $SdkVer from nuget.org…"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "glass-reader-wv2-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Force $tmp, $SdkDir | Out-Null
  try {
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$SdkVer" -OutFile "$tmp\wv2.zip"
    Expand-Archive "$tmp\wv2.zip" "$tmp\x"
    $arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' } } else { 'win-x86' }
    foreach ($f in "$tmp\x\lib\net462\Microsoft.Web.WebView2.Core.dll", "$tmp\x\lib\net462\Microsoft.Web.WebView2.WinForms.dll", "$tmp\x\runtimes\$arch\native\WebView2Loader.dll") {
      if ((Get-AuthenticodeSignature $f).Status -ne 'Valid') { throw "$(Split-Path -Leaf $f) isn't validly signed; not installing it." }
      Copy-Item $f $SdkDir -Force
    }
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

Set-UserPath $true
Step 'bin\ is on your PATH: claude-read and glass-reader work in new terminals'

if ($Hook) {
  $null = Set-Hook $true
  Step "added the Stop hook to $Settings (backup: settings.json.bak-glass-reader)"
} elseif (Set-Hook $false) {
  Step "removed an earlier Glass Reader Stop hook from $Settings"
}

$keys = @("--toggle-key=$ToggleKey", "--read-key=$ReadKey")
New-Shortcut $Startup (@('--background') + $keys) 'Glass Reader (in the background)'
New-Shortcut $StartMenu $keys 'Glass Reader'
Step 'starts at sign-in; "Glass Reader" is in the Start menu'

# Restart it so the shortcut keys and this version take effect.
Stop-Reader
Start-Sleep -Milliseconds 1500
Start-Process -FilePath $Conhost -ArgumentList (@('--headless', 'node', "`"$Reader`"", '--background') + $keys) -WorkingDirectory $AppDir
Step 'started it (the page icon in the tray)'

$fmt = { param($k) if ($k -eq 'none') { '(none)' } else { $k -replace 'Control', 'Ctrl' } }
Write-Host ''
Write-Host 'Ready.'
Write-Host "  $(& $fmt $ReadKey)   read the Claude Code session in the window you're looking at"
Write-Host "  $(& $fmt $ToggleKey)   show / hide the reader"
Write-Host '  ! claude-read    from inside Claude Code (sessions started from now on)'
if ($Hook) { Write-Host '  Answers of 250+ words are queued automatically, with a notification.' }
