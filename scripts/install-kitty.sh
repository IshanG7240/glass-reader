#!/usr/bin/env bash
# Adds a kitty watcher that records which kitty window has focus. The global
# Ctrl+Alt+C shortcut (scripts/install-gnome.sh) reads it, so one key opens the
# Claude Code session in the focused kitty tab, or the session picker anywhere else.
# No kitty remote control is needed. Your kitty.conf is backed up first; the added
# lines sit between marker comments. Only kitty windows opened afterwards report
# focus, so restart existing kitty windows once.
#
# Usage:  scripts/install-kitty.sh
#         scripts/install-kitty.sh --uninstall
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${KITTY_CONFIG_DIRECTORY:-$HOME/.config/kitty}/kitty.conf"
BEGIN='# >>> glass-reader >>>'
END='# <<< glass-reader <<<'

mkdir -p "$(dirname "$CONF")"
touch "$CONF"
cp "$CONF" "$CONF.bak-glass-reader"
# drop any previous Glass Reader block
awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$CONF.bak-glass-reader" > "$CONF.tmp"
# and the blank line it was appended after
sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$CONF.tmp"

if [[ "${1:-}" == "--uninstall" ]]; then
  mv "$CONF.tmp" "$CONF"
  echo "Removed the Glass Reader shortcut from $CONF"
else
  {
    cat "$CONF.tmp"
    printf '\n%s\n' "$BEGIN"
    printf '# tells Glass Reader which kitty window has focus (for the Ctrl+Alt+C shortcut)\n'
    printf 'watcher %s/bin/kitty_focus_watcher.py\n' "$APP_DIR"
    printf '%s\n' "$END"
  } > "$CONF"
  rm -f "$CONF.tmp"
  echo "Added the focus watcher to $CONF (backup: $CONF.bak-glass-reader)"
fi

# Running kitty windows reload their config on SIGUSR1, but watchers only attach to
# windows created afterwards.
pkill -USR1 -x kitty 2>/dev/null || true
echo "Open new kitty windows (or restart kitty) so they report focus."
