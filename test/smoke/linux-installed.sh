#!/usr/bin/env bash
set -euo pipefail

release_dir="packages/desktop/release"
appimage="$(find "$release_dir" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
if [[ -z "$appimage" ]]; then
	echo "AppImage not found in $release_dir" >&2
	exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/pi-orbit-smoke.XXXXXX")"
trap 'rm -r -- "$scratch"' EXIT
installed_app="$scratch/Pi Orbit.AppImage"
install -m 755 "$appimage" "$installed_app"
xvfb-run -a node test/smoke/desktop-api-smoke.mjs "$installed_app"
