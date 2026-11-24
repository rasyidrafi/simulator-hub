#!/usr/bin/env bash
# Register the current checkout as a systemd user service. Never restart an active unit.
set -euo pipefail
umask 077
repo=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cfg=${XDG_CONFIG_HOME:-$HOME/.config}
envfile=$cfg/simulator-hub/server.env
unitdir=$cfg/systemd/user
unit=$unitdir/simulator-hub.service
bun=$(bun -e 'console.log(process.execPath)')
adb=$(type -P adb)
emulator=$(type -P emulator)

# These paths are embedded in systemd directives and EnvironmentFile values.
for path in "$repo" "$cfg" "$HOME" "$bun" "$adb" "$emulator"; do
  [[ $path =~ ^/[a-zA-Z0-9_./@+\ -]+$ ]] || { echo "Unsupported characters in installation path: $path" >&2; exit 1; }
done
mkdir -p "$unitdir" "$(dirname "$envfile")"
if [[ ! -e $envfile ]]; then
  : "${HUB_AVD:?Set HUB_AVD to an existing AVD name for initial setup}"
  [[ $HUB_AVD =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid AVD name' >&2; exit 1; }
  emulator -list-avds | grep -Fx -- "$HUB_AVD" >/dev/null || { echo 'AVD not found' >&2; exit 1; }
  token=$(openssl rand -hex 32)
  (set -C; printf 'HUB_AVD=%s\nHUB_ADMIN_TOKEN=%s\nHUB_STATE_DIR="%s/.local/state/simulator-hub"\nPORT=8787\n' "$HUB_AVD" "$token" "$HOME" > "$envfile")
fi
tmp=$(mktemp "$unitdir/.simulator-hub.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
[Unit]
Description=Simulator Hub API

[Service]
WorkingDirectory=$repo
ExecStart="$bun" server.mjs
Environment=NODE_ENV=production
Environment="PATH=$(dirname "$adb"):$(dirname "$emulator"):/usr/bin:/bin"
EnvironmentFile=$envfile
Restart=on-failure

[Install]
WantedBy=default.target
EOF
if [[ -e $unit ]] && ! cmp -s "$tmp" "$unit"; then
  echo "Existing unit differs; leaving it untouched: $unit" >&2
  exit 1
fi
if [[ ! -e $unit ]]; then ln "$tmp" "$unit"; fi
systemctl --user daemon-reload
systemctl --user enable --now simulator-hub.service
