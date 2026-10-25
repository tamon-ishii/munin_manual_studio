#!/usr/bin/env bash
set -euo pipefail
# Run inside dbus-run-session + xvfb-run. Do not touch the user's desktop.
openbox > /tmp/munin-ci-window-manager.log 2>&1 &
munin_wm_pid=$!
trap 'kill "$munin_wm_pid" 2>/dev/null || true' EXIT
export GTK_MODULES=atk-bridge
export NO_AT_BRIDGE=0
export WEBKIT_DISABLE_COMPOSITING_MODE=1
for munin_attempt in $(seq 1 30); do
  if wmctrl -m >/dev/null 2>&1; then break; fi
  sleep 0.1
done
npm run manual:check-desktop
node scripts/check_manual_studio_coverage.mjs --cases P05.resource-array,P05.resource-elements,P05.manuscript-managed,P05.resource-exit-import-retry,P05.ordinary-manuscript --report native-workflow-results/result.json --require-complete --output ui-coverage-results/native-gate.json
