# kitty watcher: records which kitty window has keyboard focus, so a global shortcut
# (Ctrl+Alt+C, grabbed by GNOME) can open the Claude Code session in that window.
# GNOME on Wayland can't tell apps which window is focused; kitty can.
#
# kitty.conf (scripts/install-kitty.sh adds this):
#   watcher /path/to/glass-reader/bin/kitty_focus_watcher.py

import json
import os
import time

STATE = os.path.join(os.path.expanduser('~'), '.cache', 'glass-reader', 'kitty-focus.json')


def _write(data):
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        tmp = STATE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, STATE)
    except Exception:
        pass


def on_focus_change(boss, window, data):
    try:
        if data.get('focused'):
            _write({'focused': True, 'window': window.id, 'pid': window.child.pid, 't': time.time()})
        else:
            # Only clear it if this window is still the one on record; another
            # window may already have claimed focus.
            try:
                with open(STATE) as f:
                    cur = json.load(f)
            except Exception:
                cur = {}
            if cur.get('window') in (None, window.id):
                _write({'focused': False, 'window': window.id, 't': time.time()})
    except Exception:
        pass
