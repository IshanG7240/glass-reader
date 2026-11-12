#!/usr/bin/env bash
# Ubuntu 23.10+ blocks unprivileged user namespaces unless an app has an AppArmor
# profile allowing them. Electron's sandbox needs them, so without this profile Glass
# Reader crashes when GNOME launches it (hotkeys, autostart, launcher):
#   "The SUID sandbox helper binary was found, but is not configured correctly"
# VS Code, Chrome and Cursor ship the same kind of profile. Needs sudo.
#
# Usage:  sudo scripts/install-apparmor.sh            install
#         sudo scripts/install-apparmor.sh --uninstall
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
PROFILE=/etc/apparmor.d/glass-reader

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo $0 $*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  apparmor_parser -R "$PROFILE" 2>/dev/null || true
  rm -f "$PROFILE"
  echo "Removed $PROFILE"
  exit 0
fi

[[ -x "$ELECTRON" ]] || { echo "Electron not found at $ELECTRON — run npm install first." >&2; exit 1; }

cat > "$PROFILE" <<EOF
# Glass Reader (Electron). Allows everything; exists so Electron's sandbox may use
# user namespaces. Same shape as the profiles Ubuntu ships for VS Code and Chrome.
abi <abi/4.0>,
include <tunables/global>

profile glass-reader "$ELECTRON" flags=(unconfined) {
  userns,

  include if exists <local/glass-reader>
}
EOF
apparmor_parser -r "$PROFILE"
echo "Installed $PROFILE for $ELECTRON"
