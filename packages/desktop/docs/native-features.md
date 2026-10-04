# Native Pi features in Orbit

This comparison describes source-level desktop integration. Local automated
checks cover the command bridge and state handling; it does not certify an
installed application on all platforms.

| Pi capability | Orbit entry point |
| --- | --- |
| API key/OAuth and custom model providers | Settings and Custom providers |
| Model and supported thinking levels | Model selector and Session details |
| Streaming, tools, image/text attachments, steering, follow-up, abort | Conversation composer and Stop |
| Inspect and clear queued steering/follow-up input | Composer queue controls; cleared text returns to the draft |
| New/resume/search/name sessions | Sessions sidebar and Rename; names also persist in Pi JSONL |
| Clone and fork | Session details; fork from a selected branch entry |
| Navigate existing session branches | Session details → Conversation branches |
| Message/token totals and estimated cost | Session details → Session statistics |
| Manual compaction with instructions | Session details → Compact session |
| Reload skills/templates/commands/extensions and MCP resources | Session details → Reload Pi resources |
| Import local JSONL | Import button beside Sessions; imports into the selected project |
| Export HTML/current-branch JSONL | Session details → Export session |
| Skills/templates/extension commands | Library; insert or run in the active session |
| MCP setup/authentication/tool exposure | MCP servers |
| Interactive shell programs | Dedicated terminal |

Resource discovery and execution follow Pi's configuration. Resource path
activation, package installation, and the full native runtime settings remain
managed through Pi configuration rather than dedicated Orbit controls. Session
deletion and remote transcript sharing do not have desktop commands. Terminal
component renderers, overlays, terminal themes, and custom terminal editors
require desktop extension adapters; unsupported calls produce diagnostics.

MCP scope is shown per server. Enable, exposure, edit, and remove actions save
to the displayed scope: global servers update the user-level `mcp.json`, while
project servers and existing project overrides update `.pi/mcp.json`. These
switches do not create a project override for a global server; add a project
server explicitly when project-only configuration is needed.

Orbit's delegated-task scheduler is an additional desktop capability. It defaults
off, uses project-scoped roles and isolated Git worktrees, supports prerequisites
and a configurable per-project concurrency limit, and keeps manual review and
merge controls. It does not represent a core Pi multi-agent scheduler.
Session archiving, project diff review, and the Plan/Build tool policy are desktop
capabilities adapted to the native session and extension APIs.
