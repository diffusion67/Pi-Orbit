#!/usr/bin/env bash
set -euo pipefail

release_dir="packages/desktop/release"
dmg="$(find "$release_dir" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
if [[ -z "$dmg" ]]; then
	echo "DMG not found in $release_dir" >&2
	exit 1
fi

scratch="$(mktemp -d)"
mount_path="$scratch/mount"
app_path="$scratch/Pi Orbit.app"
mkdir -p "$mount_path"
cleanup() {
	if [[ -n "${app_pid:-}" ]]; then kill "$app_pid" 2>/dev/null || true; fi
	hdiutil detach "$mount_path" -quiet 2>/dev/null || hdiutil detach "$mount_path" -force -quiet 2>/dev/null || true
	if [[ ! -e "$mount_path/Pi Orbit.app" ]]; then rm -rf "$scratch"; fi
}
trap cleanup EXIT

hdiutil attach "$dmg" -mountpoint "$mount_path" -nobrowse -readonly -quiet
ditto "$mount_path/Pi Orbit.app" "$app_path"
app_exec="$app_path/Contents/MacOS/Pi Orbit"
if [[ ! -x "$app_exec" ]]; then
	echo "Installed application executable not found: $app_exec" >&2
	exit 1
fi

helper_dir="$app_path/Contents/Resources/app.asar.unpacked/node_modules/node-pty"
if [[ ! -d "$helper_dir" ]]; then
	echo "Installed node-pty helper directory not found: $helper_dir" >&2
	exit 1
fi
helper_executable=""
while IFS= read -r helper; do
	if [[ -x "$helper" ]]; then helper_executable="$helper"; break; fi
done < <(find "$helper_dir" -type f -name spawn-helper)
if [[ -z "$helper_executable" ]]; then
	echo "Installed node-pty spawn-helper is missing or not executable" >&2
	exit 1
fi

node test/smoke/desktop-api-smoke.mjs "$app_exec"
