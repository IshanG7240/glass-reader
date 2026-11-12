#!/usr/bin/env bash
# Lets Ctrl+Alt+C read what you're looking at in VS Code / Cursor and in Brave / Chrome.
#   * builds the VS Code extension (extension/vscode) and installs it into VS Code and
#     Cursor, whichever you have
#   * registers the browser helper (bin/browser-host.js) with Brave, Chrome and
#     Chromium so the browser extension can talk to it (native messaging; no network)
#   * the browser extension itself you load once by hand (Developer mode → Load
#     unpacked → extension/browser); browsers don't allow installing it from a script
#
# Usage:  scripts/install-extensions.sh
#         scripts/install-extensions.sh --uninstall
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_NAME=com.glassreader.host
EXT_ID=djjikkodnddhgoomkibakahammkgdppj   # fixed by the "key" in extension/browser/manifest.json
SHARE="$HOME/.local/share/glass-reader"
HOST_DIRS=(
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
)
EDITORS=(code cursor)

if [[ "${1:-}" == "--uninstall" ]]; then
  for e in "${EDITORS[@]}"; do command -v "$e" >/dev/null && "$e" --uninstall-extension local.glass-reader >/dev/null 2>&1 || true; done
  for d in "${HOST_DIRS[@]}"; do rm -f "$d/$HOST_NAME.json"; done
  rm -rf "$SHARE"
  echo "Removed. Remove the browser extension from brave://extensions (or chrome://extensions) yourself."
  exit 0
fi

mkdir -p "$SHARE"

# ---------- VS Code / Cursor ----------
VSIX="$SHARE/glass-reader.vsix"
VERSION=$(node -p "require('$APP_DIR/extension/vscode/package.json').version")
python3 - "$APP_DIR/extension/vscode" "$VSIX" "$VERSION" <<'PY'
import sys, zipfile
src, out, ver = sys.argv[1:4]
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="glass-reader" Version="{ver}" Publisher="local" />
    <DisplayName>Glass Reader</DisplayName>
    <Description xml:space="preserve">Lets Glass Reader's Ctrl+Alt+C read the file open in the editor.</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /></Types>
'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('extension.vsixmanifest', manifest)
    for f in ('package.json', 'extension.js'):
        z.write(f'{src}/{f}', f'extension/{f}')
PY
for e in "${EDITORS[@]}"; do
  if command -v "$e" >/dev/null; then
    "$e" --install-extension "$VSIX" --force >/dev/null && echo "Installed the extension in $e."
  fi
done

# ---------- browser helper ----------
NODE_BIN="$(command -v node || echo /usr/bin/node)"
HOST="$SHARE/browser-host"
printf '#!/bin/sh\nexec "%s" "%s/bin/browser-host.js"\n' "$NODE_BIN" "$APP_DIR" > "$HOST"
chmod 755 "$HOST"
for d in "${HOST_DIRS[@]}"; do
  [[ -d "$(dirname "$d")" ]] || continue   # that browser isn't installed
  mkdir -p "$d"
  cat > "$d/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Glass Reader: lets Ctrl+Alt+C read the current tab",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "Registered the browser helper in $d"
done

cat <<EOF

One step left, in each browser you use (Brave: brave://extensions, Chrome: chrome://extensions):
  1. turn on Developer mode (top right)
  2. Load unpacked → choose  $APP_DIR/extension/browser
VS Code / Cursor windows that were already open pick the extension up after
"Developer: Reload Window" (or a restart).
EOF
