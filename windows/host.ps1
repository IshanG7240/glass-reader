# Starts Glass Reader's window (host.cs) under Windows PowerShell 5.1. Run by windows/reader.js,
# which talks to it over stdin/stdout; not meant to be started by hand.
param(
  [Parameter(Mandatory)][string]$Url,
  [string]$Sdk = (Join-Path $env:LOCALAPPDATA 'glass-reader\webview2-sdk'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'glass-reader\webview2-data'),
  [switch]$DevTools
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false

$core = Join-Path $Sdk 'Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $Sdk 'Microsoft.Web.WebView2.WinForms.dll'
if (-not (Test-Path $core)) {
  [Console]::Out.WriteLine('{"t":"error","message":"The WebView2 SDK is missing. Run scripts\\install-windows.ps1"}')
  exit 2
}
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
Add-Type -Path $core, $forms
[Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($Sdk)

$src = (Get-Content -Raw (Join-Path $PSScriptRoot 'procs.cs')) + "`n" + (Get-Content -Raw (Join-Path $PSScriptRoot 'host.cs'))
# Both files have their own using lines; C# wants them all at the top.
$usings = [regex]::Matches($src, '(?m)^using [\w.]+;\s*$') | ForEach-Object { $_.Value.Trim() } | Sort-Object -Unique
$body = [regex]::Replace($src, '(?m)^using [\w.]+;\s*$', '')
Add-Type -TypeDefinition (($usings -join "`n") + "`n" + $body) -ReferencedAssemblies @(
  'System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', $core, $forms)

[System.Windows.Forms.Application]::EnableVisualStyles()
New-Item -ItemType Directory -Force $DataDir | Out-Null
$bridge = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'bridge.js')
$form = New-Object GlassReaderHost $Url, $bridge, $DataDir, ([bool]$DevTools)
$form.Start()
[System.Windows.Forms.Application]::Run()
