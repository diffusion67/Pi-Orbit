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

The desktop at commit `906994972` passed native Windows, macOS, and Linux
packaging and installed-app smoke checks on 2026-10-01
([verified run](https://github.com/diffusion67/Pi-Orbit/actions/runs/36880990428)),
including launch, native terminal I/O, local faux-provider chat, task
interruption and recovery, and platform-specific installation/cleanup.
Every new release must pass these checks again for its exact source commit.
Unsigned prereleases are supported; Windows publisher warnings and macOS
Gatekeeper restrictions may apply. Release notes state actual architectures,
signing/notarization status, and checksums. See the
[release process](./docs/release-process.md).

## Preferences and data

Use **Open project folder → Browse folders** to select a directory in the
native Windows, macOS, or Linux folder picker. You can also enter a path
manually. Canceling the picker keeps the current project unchanged.

In **Settings → Custom providers**, add a provider name and ID, API base URL,
credential, and one or more model IDs. Supported formats are Anthropic
Messages, OpenAI Chat Completions (including compatible gateways), OpenAI
Responses, and OpenAI Codex Responses. Enter the API base URL rather than a
Chat Completions request URL; for example, use `https://gateway.example/v1`
for an OpenAI-compatible gateway. The Codex transport uses `/codex/responses`
and requires an access token containing the ChatGPT account ID.

Each model has a display name, context window, output limit, and optional
reasoning/image support. Saved models appear in the session, default-model,
and role selectors. Custom providers can be edited or removed; leaving the
credential blank while editing preserves the saved key. A provider saved
without credentials still needs authentication before sending requests.
Wait for running sessions and tasks to finish before editing provider
configuration. Removing the selected model requires choosing another model
before continuing; it does not switch a conversation to another provider.

Connection metadata is stored in Pi's `models.json` and desktop ownership
IDs in `desktop-custom-providers.json`; credentials stay in `auth.json` and
are never returned in snapshots. Existing provider entries configured outside
the desktop app are preserved.

Settings support English and Simplified Chinese (`zh-CN`), Enter or
Ctrl/⌘+Enter as the send shortcut (Enter by default), system/dark/light
appearance, and a default model. On macOS, ⌘+Enter is equivalent to
Ctrl+Enter. **Confirm tool calls** is enabled by default and prompts before
each tool call. Changing it applies to live workers without restarting them.
Dismissed requests and unavailable confirmation UI block the tool call.

Choose **Plan** or **Build** beside the conversation composer while the session
is idle. Plan adds planning instructions and permits only the built-in read,
grep, find, ls, tool-search, and team-role discovery tools. Other tools,
including shell commands and custom tools, are blocked. This is a tool policy,
not an operating-system sandbox. The selected mode survives worker restart,
including for an empty session.

The composer shows pending steering and follow-up messages. **Clear queue**
removes them from Pi and appends the returned text to that session's draft.
It does not send another message. A successful queued-message acknowledgement
means Pi accepted the input; it does not promise the current reply has used it.

Subagents are disabled by default, including for preferences saved before this
setting existed. Enable **Settings → Enable subagents** to expose delegation
tools and create or resume tasks. Choose a per-project parallel-task limit from
1 to 4. Changing the switch requires idle main sessions. Disabling it prevents
new admissions; already running tasks continue, and their history, pause,
cancel, and merge controls remain available. Raising the limit or enabling the
switch admits ready queued tasks. Task starts and resumes enforce the same
dependency and concurrency checks, and settled workers are stopped.
Cancellation interrupts workers waiting for initialization and retains their
partial changes for inspection.

Use **Session details** for usage and estimated cost, supported thinking levels,
session cloning, conversation-branch navigation, resource reload, and manual
compaction with optional instructions. Branch navigation stays within the same
Pi session file. A user-message branch can restore text to append to the draft;
forking from it creates a separate session. Session renames are saved in Pi's
session metadata as well as the desktop registry.

Archive an idle session from its actions menu. **Archived sessions** shows
archived conversations and their Restore action. Archiving retains the native
session file and clears its active selection; restoration does not run it.

**Project changes** compares the current working tree (including staged and
untracked files), a base branch's merge base, or a selected commit. It displays
file status, diff line numbers, binary-file notices, and explicit truncation.
**Ask agent to review** prepares a draft for the selected session. Review does
not change the real Git index or apply the diff.

The import button beside **Sessions** opens a native JSONL file picker and
imports into the selected project. The source is preserved; a session ID
already registered in Orbit must be cloned instead of imported twice. **Session
details → Export session** saves Pi's native HTML or current-branch JSONL format
through a native save dialog. No transcript upload is involved. See the
[native feature comparison](./docs/native-features.md) for remaining boundaries.

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
