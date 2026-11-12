#!/usr/bin/env bash
# Installs Glass Reader into your GNOME session:
#   * an app-launcher entry (so it shows up in Activities)
#   * autostart in the background at login (so the hotkey is instant)
#   * a global keyboard shortcut that toggles the overlay
#   * Ctrl+Alt+C: reads what has focus: the Claude Code session in a kitty tab
#     (scripts/install-kitty.sh), the file in VS Code / Cursor or the page in Brave /
#     Chrome (scripts/install-extensions.sh); the Claude session picker elsewhere
#   * the `claude-read` command in ~/.local/bin (type `! claude-read` inside Claude Code)
#
# Usage:  scripts/install-gnome.sh ["<Control><Alt>r"] ["<Control><Alt>c"]
#         scripts/install-gnome.sh --uninstall
# Env:    GR_APP_DIR=/path   install for a copy of the app at another location
#         GR_NO_START=1      don't start the background process afterwards
set -euo pipefail

APP_DIR="${GR_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LAUNCH="bash \"$APP_DIR/bin/glass-reader\""
BINDING="${1:-<Control><Alt>r}"
CLAUDE_BINDING="${2:-<Control><Alt>c}"
APPS="$HOME/.local/share/applications"
AUTOSTART="$HOME/.config/autostart"
KB_SCHEMA="org.gnome.settings-daemon.plugins.media-keys"
KB_PATH="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/glass-reader/"
KB_ITEM="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$KB_PATH"
KB_PATH2="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/glass-reader-claude/"
KB_ITEM2="org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$KB_PATH2"

current_list() { gsettings get "$KB_SCHEMA" custom-keybindings; }

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$APPS/glass-reader.desktop" "$AUTOSTART/glass-reader.desktop"
  list="$(current_list | sed "s#, '$KB_PATH'##; s#'$KB_PATH', ##; s#'$KB_PATH'##; s#, '$KB_PATH2'##; s#'$KB_PATH2', ##; s#'$KB_PATH2'##")"
  [[ "$list" == "[]" || "$list" == "@as []" ]] && list="@as []"
  gsettings set "$KB_SCHEMA" custom-keybindings "$list"
  gsettings reset-recursively "$KB_ITEM" 2>/dev/null || true
  gsettings reset-recursively "$KB_ITEM2" 2>/dev/null || true
  [[ -L "$HOME/.local/bin/claude-read" ]] && rm -f "$HOME/.local/bin/claude-read"
  bash "$APP_DIR/bin/glass-reader" --quit >/dev/null 2>&1 || true
  echo "Glass Reader removed from launcher, autostart and shortcuts."
  exit 0
fi

mkdir -p "$APPS" "$AUTOSTART"
cat > "$APPS/glass-reader.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Glass Reader
Comment=Read any long document on a full-screen sheet of glass
Exec=$LAUNCH %f
Icon=accessories-text-editor
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;text/markdown;text/plain;application/epub+zip;application/vnd.openxmlformats-officedocument.wordprocessingml.document;
StartupWMClass=glass-reader
EOF

cat > "$AUTOSTART/glass-reader.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Glass Reader (background)
Exec=$LAUNCH --background
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF

for kp in "$KB_PATH" "$KB_PATH2"; do
  list="$(current_list)"
  if [[ "$list" != *"$kp"* ]]; then
    if [[ "$list" == "@as []" || "$list" == "[]" ]]; then list="['$kp']"
    else list="${list%]}, '$kp']"; fi
    gsettings set "$KB_SCHEMA" custom-keybindings "$list"
  fi
done
gsettings set "$KB_ITEM" name 'Glass Reader: toggle overlay'
gsettings set "$KB_ITEM" command "$LAUNCH --toggle"
gsettings set "$KB_ITEM" binding "$BINDING"
gsettings set "$KB_ITEM2" name "Glass Reader: read what has focus"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
gsettings set "$KB_ITEM2" command "$NODE_BIN \"$APP_DIR/bin/read-focused.js\""
gsettings set "$KB_ITEM2" binding "$CLAUDE_BINDING"

mkdir -p "$HOME/.local/bin"
ln -sfn "$APP_DIR/bin/claude-read" "$HOME/.local/bin/claude-read"

update-desktop-database "$APPS" >/dev/null 2>&1 || true
echo "Installed for $APP_DIR"
echo "Shortcuts: $BINDING toggles the reader, $CLAUDE_BINDING reads what has focus (kitty: Claude session, VS Code: file, browser: page)"
echo "           (change them in Settings → Keyboard → Custom Shortcuts)"
echo "Command:   claude-read   (inside Claude Code: ! claude-read)"
if [[ -z "${GR_NO_START:-}" ]]; then
  echo "Starting Glass Reader in the background…"
  nohup bash "$APP_DIR/bin/glass-reader" --background >/dev/null 2>&1 &
fi
