# Pi Orbit acceptance matrix

Status is evidence based: `unverified` means no installed desktop artifact has
passed the named check; `partial` means some checks passed but the full row
remains open. This list is derived from Pi's CLI, slash command,
session, settings, skills, template, extension documentation and the in-repo
subagent example. It is the release gate, not a promise that a control exists.

| Area | Desktop acceptance | Evidence | Status |
| --- | --- | --- | --- |
| Projects | Open local project, trust decision, grouped session search and switching | `packages/coding-agent/docs/cli.md`, `packages/coding-agent/docs/sessions.md` | unverified |
| Authentication | API key and OAuth setup/logout per provider without renderer secret access | `packages/coding-agent/docs/providers.md`, `/login`, `/logout` | unverified |
| Models | Browse/select provider and model, thinking level and scoped models | `packages/coding-agent/docs/cli.md`, `packages/coding-agent/docs/slash-commands.md` | unverified |
| Conversation | Streaming text/thinking, image/file input, tool calls/results, steering, follow-up, abort | `packages/coding-agent/docs/usage.md`, `AgentSession` | unverified |
| Sessions | New, resume, name, tree navigation, fork/clone, compact, import/export, stats | `packages/coding-agent/docs/sessions.md`, `packages/coding-agent/docs/slash-commands.md` | unverified |
| Settings | Model, tool, session, trust, display, network, retry, shell and resource settings | `packages/coding-agent/docs/settings.md` | unverified |
| Resources | Discover/use/reload skills, templates, commands and packages | `packages/coding-agent/docs/skills.md`, `packages/coding-agent/docs/prompt-templates.md`, `packages/coding-agent/docs/extensions.md` | unverified |
| MCP | List server state and tools, edit scoped configuration, reconnect, sign in/out, choose tool exposure, reload session | `packages/coding-agent/docs/mcp.md`, `packages/desktop/renderer/src/McpPanel.tsx` | unverified |
| Extensions | Dialogs, notifications, status, widgets and text controls rendered; TUI-only controls diagnosed | `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/docs/rpc-extension-ui.md`, `packages/coding-agent/examples/extensions` | unverified |
| Terminal | Dedicated interactive PTY for vim, htop and interactive shell extensions | `packages/coding-agent/docs/tmux.md`, `packages/coding-agent/examples/extensions/interactive-shell.ts` | unverified |
| Teams | Role editing, DAG and concurrency, message/pause/resume/cancel/wait, full task history/usage | `packages/coding-agent/examples/extensions/subagent`, `packages/desktop/docs/architecture.md` | unverified |
| Git | Clean HEAD worktree, diff review, conflict/delete protection, idempotent uncommitted merge | `packages/desktop/docs/architecture.md` | unverified |
| Recovery | Persist before notification, replay by sequence, interrupted work enters review | `packages/desktop/docs/architecture.md` | unverified |
| Windows | Signed NSIS install, launch, auth, chat, task, recovery, uninstall | Local unsigned NSIS smoke based on Pi commit `8ce69e9` passed on 2026-10-01; the later `0f8740bb6` sync, signing, and full UI acceptance need installed-artifact verification | partial |
| macOS | Signed and notarized DMG install, launch, auth, chat, task, recovery, uninstall | CI built the DMG and launched the copied app; smoke failed at terminal start (`posix_spawnp failed`). A local fix awaits native CI verification; signing, notarization, and full UI acceptance remain | partial |
| Linux | AppImage install, launch, auth, chat, task, recovery, uninstall | CI built the AppImage; smoke could not connect to Xvfb after `XAUTHORITY` was cleared. A local fix awaits native CI verification and full UI acceptance remains | partial |

Every in-repo extension must also be classified and exercised individually.
Examples using TUI `custom`, raw terminal input, custom header/footer/editor,
or overlays require a desktop implementation or an explicit user-facing
diagnostic naming the extension and unsupported operation.

## Local sync verification (2026-10-01)

The desktop changes were merged onto upstream commit `0f8740bb6`. The review
found and fixed a duplicate-instance bug: a second app could recover tasks
still running in the first. Electron now acquires its single-instance lock
before opening the shared database. The regression test failed before the fix
and passed afterward.

- Desktop Vitest tests: 48 passed across 14 files.
- Desktop Node integration tests: 28 passed across 5 suites.
- MCP manager, OAuth storage/refresh, and extension runner tests: 68 passed.
- Renderer typecheck and signing-workflow boundary tests: passed.
- Desktop and runtime dependency TypeScript compilation: passed.
- `./test.sh`: failed on Windows in the agent, Chord, client, coding-agent,
  durable, server, and TUI suites. Failures include POSIX path assumptions,
  unavailable symlink privileges, Unix sockets, and permission/signal behavior.
  `agent-session-concurrent.test.ts` also timed out in the full run; all seven
  tests passed in an isolated rerun. The full test run is not a release gate pass.

No new installed-artifact or macOS/Linux result is claimed for this sync.

## In-repository extension examples

The following per-example audit supplements the release-gate row above. It is
based on the example inventory in `packages/coding-agent/examples/extensions/README.md`
and includes standalone examples omitted from that inventory. `Runtime diagnostic`
means a terminal-only API reports `unsupported_desktop_ui` with migration guidance.
`Bridge only` means the graphical bridge exists; that sample still needs an
end-to-end acceptance run.

| Example | Desktop status | Surface or remaining work |
| --- | --- | --- |
| `permission-gate.ts` | Bridge only | `confirm` request maps to a desktop dialog. |
| `project-trust.ts` | Supported | Lifecycle hook; no terminal UI. |
| `protected-paths.ts` | Supported | Tool hook; no terminal UI. |
| `confirm-destructive.ts` | Bridge only | `confirm` request maps to a desktop dialog. |
| `dirty-repo-guard.ts` | Bridge only | `notify` is surfaced as a diagnostic notice. |
| `sandbox/` | Runtime diagnostic | Reads `ctx.ui.theme`; use desktop theme tokens in an adapter. |
| `gondolin/` | Runtime diagnostic | Reads `ctx.ui.theme`; use desktop theme tokens in an adapter. |
| `todo.ts` | Runtime diagnostic | `/todos` uses `ui.custom`; replace with a desktop task view or typed command. |
| `hello.ts` | Supported | Tool example; no terminal UI. |
| `question.ts` | Runtime diagnostic | Uses `ui.custom`; replace with `select`/`input` or a desktop form. |
| `questionnaire.ts` | Runtime diagnostic | Multi-step `ui.custom`; replace with a desktop form. |
| `tool-override.ts` | Bridge only | Uses `notify`; tool behavior is UI independent. |
| `dynamic-tools.ts` | Supported | Dynamic tool registration; no terminal UI. |
| `structured-output.ts` | Supported | Tool execution; no terminal UI. |
| `built-in-tool-renderer.ts` | Runtime diagnostic | Custom TUI tool renderer; implement a serializable desktop tool renderer. |
| `minimal-mode.ts` | Runtime diagnostic | Custom TUI tool renderer; implement a serializable desktop tool renderer. |
| `truncated-tool.ts` | Supported | Tool wrapper; no terminal UI. |
| `ssh.ts` | Runtime diagnostic | Status calls `ctx.ui.theme`; replace terminal colors with plain status text. |
| `subagent/` | Bridge only | Uses confirmation and task tools; verify dialogs and task reporting end to end. |
| `preset.ts` | Runtime diagnostic | Uses `ui.custom` and `ui.theme`; use native selection and desktop status. |
| `plan-mode/` | Runtime diagnostic | Reads `ui.theme`; use plain status and serializable widgets. |
| `tools.ts` | Runtime diagnostic | `/tools` uses `ui.custom`; replace with desktop tool controls. |
| `handoff.ts` | Runtime diagnostic | Uses `ui.custom`; replace with a native dialog or desktop session picker. |
| `qna.ts` | Runtime diagnostic | Uses `ui.custom`; replace with a native dialog or desktop editor action. |
| `status-line.ts` | Runtime diagnostic | Reads `ui.theme`; use desktop status tokens. |
| `github-issue-autocomplete.ts` | Runtime diagnostic | Wraps terminal autocomplete; implement a desktop composer suggestion provider. |
| `widget-placement.ts` | Bridge only | String widgets render in the extension panel with placement metadata. |
| `hidden-thinking-label.ts` | Bridge only | Label is retained and shown in the extension panel. |
| `working-indicator.ts` | Runtime diagnostic | Reads `ui.theme`; use plain text and desktop status rendering. |
| `working-message-test.ts` | Bridge only | Working message and indicator updates appear in the extension panel. |
| `model-status.ts` | Bridge only | Status text is retained and shown in the extension panel. |
| `snake.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop view with explicit controls. |
| `tic-tac-toe.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop view with explicit controls. |
| `send-user-message.ts` | Bridge only | Uses notifications and session message APIs. |
| `timed-confirm.ts` | Bridge only | Abort and timeout cancel and dismiss the dialog; no countdown is shown. |
| `rpc-demo.ts` | Bridge only | Select, confirm, text input, and multiline editor use native dialogs. |
| `modal-editor.ts` | Runtime diagnostic | Custom terminal editor; use the desktop editor API. |
| `rainbow-editor.ts` | Runtime diagnostic | Custom terminal editor; use the desktop editor API. |
| `border-status-editor.ts` | Runtime diagnostic | Custom TUI editor, footer, and theme; use desktop editor and status controls. |
| `notify.ts` | Runtime diagnostic | Sends terminal OSC notifications; use desktop notification events. |
| `titlebar-spinner.ts` | Bridge only | Terminal title maps to status text in the extension panel. |
| `summarize.ts` | Runtime diagnostic | Uses `ui.custom`; show the result in a desktop panel. |
| `custom-footer.ts` | Runtime diagnostic | TUI footer component; map its fields into desktop status data. |
| `custom-header.ts` | Runtime diagnostic | TUI header component; implement a desktop header adapter. |
| `overlay-test.ts` | Runtime diagnostic | Terminal overlay; use desktop modal components. |
| `overlay-qa-tests.ts` | Runtime diagnostic | Terminal overlay tests; use desktop modal components. |
| `doom-overlay/` | Runtime diagnostic | Terminal game overlay; implement a dedicated desktop view. |
| `space-invaders.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop view with explicit controls. |
| `shutdown-command.ts` | Supported | Command and shutdown API; no terminal UI. |
| `reload-runtime.ts` | Supported | Runtime reload APIs; no terminal UI. |
| `interactive-shell.ts` | Runtime diagnostic | Requires terminal access; use the dedicated desktop terminal panel. |
| `inline-bash.ts` | Supported | Input transformation; no terminal UI. |
| `input-transform-streaming.ts` | Supported | Input hook; no terminal UI. |
| `git-checkpoint.ts` | Supported | Git lifecycle behavior; no terminal UI. |
| `auto-commit-on-exit.ts` | Bridge only | Uses notification; remaining behavior is UI independent. |
| `pirate.ts` | Supported | System prompt hook; no terminal UI. |
| `claude-rules.ts` | Supported | Resource discovery and system prompt; no terminal UI. |
| `custom-compaction.ts` | Supported | Compaction hook; no terminal UI. |
| `trigger-compact.ts` | Bridge only | Uses notifications and command hooks. |
| `mac-system-theme.ts` | Runtime diagnostic | `setTheme` cannot apply terminal themes; map names to desktop theme settings. |
| `dynamic-resources/` | Incomplete bridge | Resource loading works; terminal theme resources need a desktop theme adapter. |
| `message-renderer.ts` | Runtime diagnostic | Custom TUI message renderer; provide a serializable desktop message renderer. |
| `entry-renderer.ts` | Runtime diagnostic | TUI-only entry renderer; provide a desktop entry renderer. |
| `debug-provider.ts` | Runtime diagnostic | Uses TUI-only session entries; show diagnostics in a desktop panel. |
| `event-bus.ts` | Supported | Inter-extension event bus; no terminal UI. |
| `session-name.ts` | Bridge only | Session metadata works; notification is surfaced as a notice. |
| `bookmark.ts` | Bridge only | Session labels work; notifications are surfaced as notices. |
| `custom-provider-anthropic/` | Supported | Provider registration; no terminal UI. |
| `custom-provider-gitlab-duo/` | Supported | Provider registration; no terminal UI. |
| `with-deps/` | Supported | Dependency resolution example; no terminal UI. |
| `file-trigger.ts` | Supported | File watcher and input injection; no terminal UI. |

The adapter tests cover serializable UI controls, editor read/write behavior, and
diagnostics for terminal input, overlays, component widgets, headers, footers,
autocomplete, custom editors, and themes. They do not replace sample-level
acceptance runs.
