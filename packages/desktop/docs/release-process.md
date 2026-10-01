# Pi Orbit desktop release process

`.github/workflows/desktop-release-candidate.yml` builds one unsigned native artifact on
each platform: an NSIS installer on Windows, a DMG on macOS, and an AppImage on
Linux. Artifacts are attached to the workflow run for 14 days. The workflow
is triggered by changes to relevant paths on `main`, pull requests, or manual
dispatch. It does not create a Git tag or publish a GitHub Release. The separate
manual `.github/workflows/desktop-signed-candidate.yml` signs Windows and macOS
artifacts from reviewed `main` after the protected `desktop-signing` environment
approves access to its secrets.

The workflow installs dependencies with lifecycle scripts disabled, then runs
Electron's runtime download script and the `node-pty` install scripts
explicitly. It hydrates current model catalog data before running the AI
package's offline build, then builds only the Pi workspaces required by the
desktop runtime; it does not run the monorepo-wide build script. It typechecks
the renderer and runs desktop service and worker tests before packaging. The workflow
rebuilds `node-pty` before packaging, and Electron Builder packages the desktop
workspace with its own native rebuild disabled. The installed-artifact smoke
exercises the packaged coding-agent, AI, durable storage, and worker paths.
Missing workspace runtime packages therefore fail during the smoke instead of
passing a simple window-start check.

## CI verification

Each native runner launches the packaged application and uses its isolated
preload API to configure a disposable fake credential, open a temporary Git
project, start and exercise the native terminal, save settings and a role,
create a session, and complete one chat turn against a local faux OpenAI
compatible server. The smoke then starts a task
whose faux response is held open, closes the app, relaunches it, and checks that
the task is in review, session and settings data are restored, and the pending
model request was not replayed. Windows also installs and uninstalls the NSIS
package; macOS mounts and copies the DMG app; Linux runs an executable copy of
the AppImage. Temporary profiles, the AppImage copy, and the fake server are
deleted at the end. The workflow writes
`SHA256SUMS` beside each package.

This covers the packaged command bridge and local persistence without calling
a paid model API. It does not test real OAuth flows, operating-system keychain
prompts with real credentials, model-provider compatibility, tool execution,
conflict resolution, extension UI, abrupt power loss, or every interactive
screen. The recovery probe simulates an interrupted task by closing the app
while a local model response is in flight, then verifies startup converts the
durable running task to review without repeating its request. These remaining
product flows stay listed in [acceptance.md](./acceptance.md) and must not be
claimed as verified by this workflow.

On 2026-09-26, the previous desktop revision at `060f857` passed a local
Windows x64 NSIS package smoke:
`test/smoke/windows-installed.ps1`: silent installation, packaged-app launch,
disposable credential and settings configuration, native terminal I/O,
local faux-provider chat,
subtask interruption and recovery, clean exit, and silent uninstall. The local
build used `electron-builder --win nsis --config.npmRebuild=false`. Its installer
is unsigned. The subsequent
[three-platform workflow run](https://github.com/diffusion67/Pi-Orbit/actions/runs/36235546240)
packaged Windows, macOS, and Linux artifacts. Windows installed-app smoke
passed; macOS failed while starting its
terminal (`posix_spawnp failed`), and Linux failed to connect to the Xvfb
display. Local fixes for those two failures have not yet passed their native CI
smokes. On 2026-10-01, the desktop based on Pi commit `8ce69e9` passed the local unsigned Windows
x64 NSIS installed-artifact smoke, including installation, authentication,
terminal I/O, faux-provider chat, task recovery, and uninstall. The macOS and
Linux fixes have not passed a native installed-artifact smoke for this sync.
The later sync to `0f8740bb6` passed desktop source and integration tests, but
has not been packaged or verified as an installed artifact.

## Signing and notarization

The three-platform push/PR workflow always builds unsigned artifacts and never
receives signing or notarization secrets. These artifacts check packaging and
installed behavior, but are not public release candidates. Public Windows and
macOS distribution requires signed artifacts; macOS additionally requires
notarization and a stapled ticket.

Before running the signed workflow, create a GitHub Actions environment named
`desktop-signing`. Restrict its deployment branches to `main` and require a
reviewer who did not author the change. Put the signing credentials only in
that environment; remove any same-named repository or organization secrets.
The workflow is manual, accepts only `main`, and must use the same commit as a
successful three-platform unsigned run. Environment protection is configured
on GitHub, so this repository cannot verify that protection locally. Do not
run the signed workflow until those settings are checked. Never store
certificates, passwords, or Apple API key material in the repository or
workflow artifacts.

Configure these secrets before producing a signed candidate:

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CSC_LINK` | Windows signing certificate file or secure URL |
| `WINDOWS_CSC_KEY_PASSWORD` | Windows certificate password |
| `MACOS_CSC_LINK` | Developer ID Application certificate file or secure URL |
| `MACOS_CSC_KEY_PASSWORD` | macOS certificate password |
| `APPLE_API_KEY_BASE64` | Base64 encoded App Store Connect `.p8` key used by notarization |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |

The signed job decodes the Apple key into a temporary file because
`electron-builder` expects `APPLE_API_KEY` to be a file path. It enables
Electron's hardened runtime and supplies the key path to
`electron-builder` 26, which signs, submits the app for notarization, and
staples the returned ticket when the required credentials are present. The
job then checks the installer signature on Windows and the Developer ID
signature, stapled ticket, and Gatekeeper assessment of the app from the DMG
on macOS. It runs the installed-app smokes again and writes SHA-256 manifests.
Any missing secret, invalid signature, or failed notarization stops the job.
The native signed workflow must pass before a public candidate is claimed.

## Release notes and checksums

Before requesting publication, prepare version-specific notes from the desktop
acceptance matrix. Include the exact version, supported architectures, notable
changes, known limitations, installation and uninstall steps, signing and
notarization results, and the SHA-256 values from `SHA256SUMS`. Verify every
checksum after downloading the workflow artifacts. Do not reuse notes or
checksums from another run or commit.

Both workflows stop at downloadable workflow artifacts. Publishing to GitHub
remains a separate action that requires explicit user authorization.
