# Desktop extension acceptance matrix

This matrix audits the example extensions listed in `packages/coding-agent/examples/extensions/README.md`.
“Runtime diagnostic” means the extension can load and use its non-UI hooks, but invoking the listed terminal UI API emits `unsupported_desktop_ui` with migration guidance. “Bridge only” means a desktop equivalent exists in the extension panel or dialog bridge; each sample still needs a sample-level acceptance run.

| Example | Desktop status | Surface or remaining work |
| --- | --- | --- |
| `permission-gate.ts` | Bridge only | `confirm` request is mapped to a desktop dialog. |
| `project-trust.ts` | Supported | Lifecycle hook; no terminal UI. |
| `protected-paths.ts` | Supported | Tool hook; no terminal UI. |
| `confirm-destructive.ts` | Bridge only | `confirm` request is mapped to a desktop dialog. |
| `dirty-repo-guard.ts` | Bridge only | `notify` is surfaced as a diagnostic notice. |
| `sandbox/` | Runtime diagnostic | Reads `ctx.ui.theme`; use desktop theme tokens in an adapter. |
| `gondolin/` | Runtime diagnostic | Reads `ctx.ui.theme`; use desktop theme tokens in an adapter. |
| `todo.ts` | Runtime diagnostic | `/todos` uses `ui.custom`; replace with a desktop-owned task view or typed command. |
| `hello.ts` | Supported | Tool example; no terminal UI. |
| `question.ts` | Runtime diagnostic | Uses `ui.custom`; replace with `select`/`input` or a desktop-owned form. |
| `questionnaire.ts` | Runtime diagnostic | Multi-step `ui.custom`; replace with a desktop-owned form. |
| `tool-override.ts` | Bridge only | Uses `notify`; other tool behavior is UI independent. |
| `dynamic-tools.ts` | Supported | Dynamic tool registration; no terminal UI. |
| `structured-output.ts` | Supported | Tool execution; no terminal UI. |
| `built-in-tool-renderer.ts` | Runtime diagnostic | Custom TUI tool renderer; implement a serializable desktop tool renderer. |
| `minimal-mode.ts` | Runtime diagnostic | Custom TUI tool renderer; implement a serializable desktop tool renderer. |
| `truncated-tool.ts` | Supported | Tool wrapper; no terminal UI. |
| `ssh.ts` | Runtime diagnostic | Status text calls `ctx.ui.theme`; replace terminal colors with plain status text. |
| `subagent/` | Bridge only | Uses confirmation and task tools; verify dialogs and task reporting end to end. |
| `preset.ts` | Runtime diagnostic | Uses `ui.custom` and `ui.theme`; use native selection plus desktop status. |
| `plan-mode/` | Runtime diagnostic | Reads `ui.theme` for status and plan formatting; use plain status and serializable widgets. |
| `tools.ts` | Runtime diagnostic | `/tools` uses `ui.custom`; replace with desktop tool controls. |
| `handoff.ts` | Runtime diagnostic | Uses `ui.custom`; replace with a native dialog or desktop session picker. |
| `qna.ts` | Runtime diagnostic | Uses `ui.custom`; replace with a native dialog or desktop editor action. |
| `status-line.ts` | Runtime diagnostic | Reads `ui.theme`; use desktop status tokens and status rendering. |
| `github-issue-autocomplete.ts` | Runtime diagnostic | Wraps terminal autocomplete; implement a desktop composer suggestion provider. |
| `widget-placement.ts` | Bridge only | String widgets render in the extension panel with their requested placement metadata. |
| `hidden-thinking-label.ts` | Bridge only | The label is retained in extension UI state and shown in the extension panel. |
| `working-indicator.ts` | Runtime diagnostic | Reads `ui.theme` before setting status; use plain text and desktop status rendering. |
| `working-message-test.ts` | Bridge only | Working message and indicator updates are shown in the extension panel. |
| `model-status.ts` | Bridge only | Status text is retained and shown in the extension panel. |
| `snake.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop React view with explicit controls. |
| `tic-tac-toe.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop React view with explicit controls. |
| `send-user-message.ts` | Bridge only | Uses notifications and session message APIs. |
| `timed-confirm.ts` | Bridge only | Abort and timeout resolve as cancellation and dismiss the outstanding dialog; no countdown display is provided. |
| `rpc-demo.ts` | Bridge only | Select, confirm, text input, and multiline editor use native dialogs; dialog closure follows timeout or abort. |
| `modal-editor.ts` | Runtime diagnostic | Custom terminal editor; use the desktop editor API. |
| `rainbow-editor.ts` | Runtime diagnostic | Custom terminal editor; use the desktop editor API. |
| `border-status-editor.ts` | Runtime diagnostic | Custom TUI editor, footer, and theme access; use the desktop editor API and status controls. |
| `notify.ts` | Runtime diagnostic | Sends terminal OSC notifications; use desktop notification events. |
| `titlebar-spinner.ts` | Bridge only | The terminal title maps to status text shown in the extension panel. |
| `summarize.ts` | Runtime diagnostic | Uses `ui.custom`; show the result in a desktop-owned panel. |
| `custom-footer.ts` | Runtime diagnostic | Uses `setFooter` with a TUI component; map required fields into desktop status data. |
| `custom-header.ts` | Runtime diagnostic | Uses `setHeader` with a TUI component; implement a desktop header adapter. |
| `overlay-test.ts` | Runtime diagnostic | Exercises terminal overlays; use desktop-owned modal components. |
| `overlay-qa-tests.ts` | Runtime diagnostic | Exercises terminal overlays; use desktop-owned modal components. |
| `doom-overlay/` | Runtime diagnostic | Terminal game overlay; implement a dedicated desktop view. |
| `space-invaders.ts` | Runtime diagnostic | Interactive TUI game; provide a desktop React view with explicit controls. |
| `shutdown-command.ts` | Supported | Command and shutdown API; no terminal UI. |
| `reload-runtime.ts` | Supported | Runtime reload APIs; no terminal UI. |
| `interactive-shell.ts` | Runtime diagnostic | Requires terminal access; use the dedicated desktop terminal panel. |
| `inline-bash.ts` | Supported | Input transformation; no terminal UI. |
| `input-transform-streaming.ts` | Supported | Input hook; no terminal UI. |
| `git-checkpoint.ts` | Supported | Git lifecycle behavior; no terminal UI. |
| `auto-commit-on-exit.ts` | Bridge only | Uses notification; other behavior is UI independent. |
| `pirate.ts` | Supported | System prompt hook; no terminal UI. |
| `claude-rules.ts` | Supported | Resource discovery and system prompt; no terminal UI. |
| `custom-compaction.ts` | Supported | Compaction hook; no terminal UI. |
| `trigger-compact.ts` | Bridge only | Uses notifications and command hooks. |
| `mac-system-theme.ts` | Runtime diagnostic | `setTheme` cannot apply terminal themes; map theme names to the desktop theme setting. |
| `dynamic-resources/` | Incomplete bridge | Resource loading works; terminal theme resources need a desktop theme adapter. |
| `message-renderer.ts` | Runtime diagnostic | Custom TUI message renderer; provide a serializable message presentation adapter. |
| `entry-renderer.ts` | Runtime diagnostic | TUI-only session entry renderer; provide a desktop entry renderer. |
| `debug-provider.ts` | Runtime diagnostic | Debug output uses TUI-only session entries; show diagnostics in a desktop panel. |
| `event-bus.ts` | Supported | Inter-extension event bus; no terminal UI. |
| `session-name.ts` | Bridge only | Session metadata works; notification is surfaced as a notice. |
| `bookmark.ts` | Bridge only | Session labels work; notifications are surfaced as notices. |
| `custom-provider-anthropic/` | Supported | Provider registration; no terminal UI. |
| `custom-provider-gitlab-duo/` | Supported | Provider registration; no terminal UI. |
| `with-deps/` | Supported | Dependency resolution example; no terminal UI. |
| `file-trigger.ts` | Supported | File watcher and input injection; no terminal UI. |

## Adapter test coverage

`test/extensions/desktop-ui-context.test.ts` verifies dialog and serializable control mapping, editor write/read consistency, and actionable diagnostics for terminal input, custom overlays, component widgets, headers, footers, autocomplete, custom editors, and TUI themes. This unit coverage does not replace the end-to-end renderer checks listed above.
