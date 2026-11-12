#!/usr/bin/env bash
# Adds (or removes) the Claude Code "Stop" hook that sends long answers to Glass Reader.
# It goes in your user settings (~/.claude/settings.json), so it applies to every project.
# Existing settings are kept; a backup is written next to the file first.
#
# Usage:  scripts/install-claude-hook.sh            install
#         scripts/install-claude-hook.sh --uninstall
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS="$HOME/.claude/settings.json"
CMD="node $APP_DIR/bin/claude-to-reader.js --hook 2>/dev/null || true"
command -v jq >/dev/null || { echo "jq is required (sudo apt install jq)" >&2; exit 1; }
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak-glass-reader"

# Drop any previous Glass Reader entry, then (unless uninstalling) add the current one.
jq --arg cmd "$CMD" --arg mode "${1:-install}" '
  .hooks.Stop = ([(.hooks.Stop // [])[]
                  | .hooks |= map(select((.command // "") | contains("claude-to-reader.js") | not))
                  | select(.hooks | length > 0)]
                 + (if $mode == "--uninstall" then []
                    else [{hooks: [{type: "command", command: $cmd, timeout: 10, async: true}]}] end))
  | if (.hooks.Stop | length) == 0 then del(.hooks.Stop) else . end
  | if (.hooks | length) == 0 then del(.hooks) else . end
' "$SETTINGS.bak-glass-reader" > "$SETTINGS.tmp"
jq -e . "$SETTINGS.tmp" >/dev/null && mv "$SETTINGS.tmp" "$SETTINGS"

if [[ "${1:-}" == "--uninstall" ]]; then echo "Removed the Glass Reader hook from $SETTINGS"
else
  echo "Installed. Claude Code answers of 250+ words now go to Glass Reader."
  echo "Takes effect in Claude Code sessions started from now on. Backup: $SETTINGS.bak-glass-reader"
fi
