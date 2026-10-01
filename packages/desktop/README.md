# Pi Orbit Desktop

Pi Orbit is a local Electron desktop host for Pi. It provides project and
session navigation, model-provider settings, chat, an interactive terminal,
and delegated tasks in Git worktrees. The desktop package is still undergoing
release validation; see the [acceptance matrix](./docs/acceptance.md) for
verified coverage and remaining gaps.

The [architecture overview](./docs/architecture.md) describes process
boundaries, local data ownership, sessions, extensions, tasks, and Git
worktrees.

## Requirements

- Node.js 22.19 or later and npm.
- Git for project worktrees and delegated tasks.
- A model provider configured through Pi, or credentials entered in Pi Orbit
  Settings.
- Native build tools for `node-pty` when preparing a local development
  install. The release workflow installs the required tools on its runners.

## Install dependencies and build

Run these commands from the repository root. Install with lifecycle scripts
disabled, then explicitly install Electron and build `node-pty` for the local
platform:

```bash
npm install --ignore-scripts
node node_modules/electron/install.js
npm rebuild node-pty --workspace=@earendil-works/pi-orbit
```

Build the Pi runtime workspaces required by the desktop app, then the desktop
main process and renderer:

```bash
npm run build --workspace=@earendil-works/chord
npm run build --workspace=@earendil-works/pi-tui
npm run build --workspace=@earendil-works/pi-telemetry
npm run build --workspace=@earendil-works/pi-codemode
npm run build --workspace=@earendil-works/pi-mcp
npm run hydrate-model-data --workspace=@earendil-works/pi-ai
npm run build:offline --workspace=@earendil-works/pi-ai
npm run build --workspace=@earendil-works/pi-agent-core
npm run build --workspace=@earendil-works/pi-durable
npm run build:unbundled --workspace=@earendil-works/pi-coding-agent
npm run build --workspace=@earendil-works/pi-orbit
```

Model catalog hydration may access the network. If the catalog is already
available locally, skip `hydrate-model-data` and use the offline AI build.

## Run in development

The desktop `dev` script starts only the Vite renderer server. After completing
the build above, start it in one terminal:

```bash
npm run dev --workspace=@earendil-works/pi-orbit
```

In a second terminal, launch Electron with the loopback renderer URL. For
PowerShell:

```powershell
$env:PI_ORBIT_DEV_SERVER_URL = "http://127.0.0.1:5173"
npm exec --prefix packages/desktop -- electron .
```

For macOS or Linux:

```bash
PI_ORBIT_DEV_SERVER_URL=http://127.0.0.1:5173 npm exec --prefix packages/desktop -- electron .
```

To launch the built renderer instead, omit `PI_ORBIT_DEV_SERVER_URL`:

```bash
npm exec --prefix packages/desktop -- electron .
```

## Package and install

Run the package command on the target operating system:

```bash
npm run package:win --workspace=@earendil-works/pi-orbit
npm run package:mac --workspace=@earendil-works/pi-orbit
npm run package:linux --workspace=@earendil-works/pi-orbit
```

The commands create an NSIS installer, a DMG, or an AppImage under
`packages/desktop/release/`. Install the Windows NSIS executable and follow
its prompts. On macOS, mount the DMG and copy Pi Orbit to Applications. On
Linux, make the AppImage executable and launch it. These are packaging targets;
they do not imply that each platform has passed installed-app validation.

The Windows x64 unsigned NSIS installer based on Pi commit `8ce69e9` passed a local
installed-app smoke on 2026-10-01, including installation, launch, native
terminal I/O, local faux provider chat, task interruption and recovery, and
uninstall. The later sync to `0f8740bb6`, macOS, and Linux installed builds have not been verified. Windows
packages are unsigned. Public Windows distribution requires code signing;
macOS distribution requires code signing and notarization. See the
[release process](./docs/release-process.md).

## Preferences and data

Settings support English and Simplified Chinese (`zh-CN`), Enter or
Ctrl/⌘+Enter as the send shortcut (Enter by default), system/dark/light
appearance, and a default model. On macOS, ⌘+Enter is equivalent to
Ctrl+Enter. The tool-confirmation preference is currently stored but does not
change behavior: tool execution follows Pi's configured tool policy, and Pi
Orbit does not add confirmation prompts from that preference.

Project metadata, application preferences, team task records, event history,
and delegated-task worktrees live in Electron's local application data
directory (`orbit.sqlite` and related files). Pi session files and provider
credentials use Pi's local data directory. Project source files remain in the
folders you open. The app does not send data to a coordination server, but
prompts and relevant context are sent to the model provider configured for the
session. Local tools run with the permissions of the desktop process.

Pi Orbit is not a sandbox. Review tool activity and changes before relying on
them, and use a separate operating-system sandbox when stronger isolation is
needed. See the root README's [permissions and containerization guidance](../../README.md#permissions--containerization).
