#!/usr/bin/env bash
# Installs the on-demand LaunchAgent that starts the loop from the GUI
# session, where the login keychain is unlocked. Run once on the loop host;
# afterwards the loop starts with
#   launchctl kickstart gui/$(id -u)/ooo.workflow.sandcastle.portuni
# from any ssh session, no password prompt.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="ooo.workflow.sandcastle.portuni"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.sandcastle/logs"
sed "s|__REPO__|$REPO|g" "$REPO/.sandcastle/launchd/$LABEL.plist" > "$DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed $DEST"
echo "start:  launchctl kickstart gui/$(id -u)/$LABEL"
echo "logs:   $REPO/.sandcastle/logs/launchd.{out,err}.log, then tmux attach -t sandcastle-portuni"
