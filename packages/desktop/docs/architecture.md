# Pi Orbit desktop architecture

## Product boundary

Pi Orbit is a local desktop host for Pi. The renderer presents projects, Pi
sessions, team tasks, file changes, settings, and extension interactions. Pi
sessions remain Pi JSONL sessions. Team records and their ordered events live in
an application owned SQLite database. Nothing is sent to a coordination server.

## Processes and authority

| Process | Owns | May call |
| --- | --- | --- |
| Electron main | Windows, project registry, task database, Git, worker lifecycle, IPC validation | Named desktop commands only |
| Agent worker, one per active session | `AgentSessionRuntime`, `SessionManager`, credentials, extensions, one Pi session file | Restricted messages from main |
| Sandboxed renderer | React views and temporary input state | Preload's named, validated commands |
| Preload | Frozen `piOrbit` bridge | The same command allowlist |

Main never writes a worker's Pi session file. Workers never write the team
database. Main persists each task transition and event in one SQLite transaction
before publishing its sequence number to renderer subscribers. On connection,
the renderer reads a snapshot and its sequence, then subscribes from that
sequence; a gap triggers replay from the database.

## Sessions and extensions

Workers create a Pi runtime with `createAgentSessionServices`,
`createAgentSessionFromServices`, and `createAgentSessionRuntime`; the runtime
handles new, resume, fork, and import. `AgentSession` supplies prompt, stream,
abort, model, thinking, compaction, and resource reload. The worker serializes
only approved event fields. Authentication and settings stay on the worker side
and are never returned with secret values.

Main coalesces concurrent initialization for a session and reserves a unique
run ID before sending a prompt. Terminal state and queued-message input are
checked against that run. Native steering/follow-up operations acknowledge their
actual disposition and publish queue state. Renderer snapshots reject older
sequences and session-selection responses that were superseded.

Archive state is persisted in the desktop registry without deleting Pi files.
An archived session cannot start a worker until restored. The selected tool mode
uses native custom session entries and a desktop preference for empty sessions;
global confirmation settings also apply to workers already running. A built-in
desktop extension enforces tool confirmation and Plan's explicit read-tool list.

The extension mode is `desktop`. Select, confirm, input, editor, notifications,
status, title, and text widgets use a desktop UI request/response protocol.
Terminal-only component factories cannot cross the process boundary: invoking
one produces an explicit diagnostic with the extension path and migration
guidance. A separate interactive terminal panel owns programs such as vim and
htop; it does not become a generic renderer process API.

## Team tasks and Git

Each task has a durable ID, project/parent/role IDs, prompt, prerequisites,
status, baseline `HEAD`, worktree and session paths, and last settled Pi entry.
Delegation is disabled by default and can be enabled in desktop settings.
The scheduler admits a configurable one to four tasks per project and only when all
prerequisites completed successfully. It rejects dependency cycles. Startup
changes previously running tasks to `review` without replaying a tool call;
the user explicitly resumes or cancels them.
Starts are serialized per project and use the same transactional admission checks
as resumes. Worker startup runs concurrently within an admitted batch. Disabling
delegation prevents new admissions without interrupting running tasks. Settled
task workers stop while their sessions and worktrees remain available for review.

A writable task starts from an exact Git `HEAD` in a separate worktree. Dirty
base workspaces block its creation. A completed task remains in its worktree
while the main agent reviews its diff. The merge operation checks the original
base, conflicting target edits, deletions, and prior merge identity, then
applies safe changes to the main workspace without committing. Any conflict or
deletion is presented for user resolution. The worktree survives until the
applied result is verified.

## Release gate

The desktop package uses Electron, React, and Vite. Each direct dependency has
an exact version. Windows NSIS, macOS DMG, and Linux AppImage jobs must test
installed artifacts on native runners. Public release requires Windows and
macOS signatures, macOS notarization, release notes, and checksums; signing
material remains in CI secrets. The candidate cannot be called publicly ready
until these jobs actually pass.
