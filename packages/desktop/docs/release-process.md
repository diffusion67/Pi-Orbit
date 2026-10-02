# Pi Orbit desktop release process

`.github/workflows/desktop-release-candidate.yml` builds one unsigned native artifact on
each platform: an NSIS installer on Windows, a DMG on macOS, and an AppImage on
Linux. Artifacts are attached to the workflow run for 14 days. The workflow
is triggered by changes to relevant paths on `main`, pull requests, or manual
dispatch. The artifact-building workflow does not create a Git tag or publish a GitHub Release.
The dedicated `.github/workflows/desktop-publish-release.yml` can publish the
explicitly approved unsigned `0.1.0-rc.1` prerelease after the gates below pass. The separate
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

The [2026-10-01 three-platform workflow run](https://github.com/diffusion67/Pi-Orbit/actions/runs/36880990428)
passed the unsigned installed-artifact smokes for source commit
`90699497275bfb440abb9d73046a57c793cfc8af`. Those results are historical evidence,
not approval to publish a newer source. The `7fbbd5f4` upstream sync and desktop
`0.1.0-rc.1` must pass fresh full CI and all three native jobs at the exact same
current `main` SHA before publication.

## Approved unsigned prerelease publication

This is a bounded exception for `diffusion67/Pi-Orbit`, desktop version
`0.1.0-rc.1`, tag `pi-orbit-v0.1.0-rc.1`. The tag intentionally does not match the
upstream `v*` npm/binary publication pipeline. It publishes no npm packages,
R2 objects, website version markers, signing credentials or automatic updates.
Another version or broader publication behavior requires a separate review.

The publisher starts only when either `CI` or `Pi Orbit Desktop Unsigned
Artifacts` completes successfully for a trusted `push` on this repository's
`main`. It has no dispatch or PR trigger and rejects fork/PR provenance again
in code. Workflow-level permissions are empty; only its publication job gets
`contents: write` and `actions: read`. Checkout is SHA-pinned with credentials
not persisted, and no dependency installation or artifact code execution is
performed. Concurrency serializes publication for this one tag without
cancelling an in-flight publisher.

Before writing to GitHub, `scripts/desktop-release-publish.mjs` verifies:

1. The checked-out desktop version and SHA, the trigger, and the live `main`
   SHA match. Both workflows' latest main-push runs, including the current run
   attempts, must be completed and successful. A newer pending or failed run
   blocks an older successful run.
2. Full build/check/test and MCP conformance jobs exist and passed. All three
   desktop jobs and their mandatory typecheck, tests, build, package,
   installed-smoke, checksum and upload steps exist and passed.
3. Each platform artifact uniquely belongs to that desktop run, repository
   and SHA, is unexpired, and was created during its validated job. The
   matching job's single electron-builder packaging line supplies the actual
   OS and architecture. Unknown or ambiguous architecture stops publication.
4. Downloaded archives have exactly one versioned installer and `SHA256SUMS`.
   Only safe flat filenames are accepted. Installer bytes are copied with
   `unzip -p`, never executed or extracted as paths/symlinks. Archive digests,
   when supplied by GitHub, and every installer checksum are verified. PE,
   UDIF DMG or AppImage signatures are checked; AppImage architecture must
   also agree with the build log.

The script creates a new **draft prerelease** targeting that exact source SHA,
uploads three installers, combined `SHA256SUMS`, and generated
`RELEASE_NOTES.md` to that release ID, then downloads every asset to verify
size and SHA-256. Installer release filenames replace spaces with hyphens to
avoid GitHub's filename sanitization; source archive checksums still use the
original names, while release notes and combined checksums use release names.
It rechecks the latest runs and live main before publishing;
main is checked again immediately before the publication request. The draft
may not have a Git tag yet, but any tag that exists must point to the validated
SHA. After publishing, all assets are downloaded and checked again, and the
tag must exist at that SHA. No release is marked as Latest.

No existing tag, release or asset is overwritten. An existing draft or tag
without a matching published release stops the job for manual inspection.
A second completion event can only read and verify an already-published
release with identical source, notes and assets, then exit without writes.
Failures never delete drafts or assets automatically. If a failure occurs,
inspect the retained draft, job logs and source before deciding on a new
version or a separately authorized recovery; do not blindly rerun publication
or delete evidence.

## Signing and notarization

The three-platform push/PR workflow always builds unsigned artifacts and never
receives signing or notarization secrets. The approved `0.1.0-rc.1` prerelease
explicitly distributes these unsigned artifacts and must disclose that
Windows SmartScreen or macOS Gatekeeper can warn or block installation. It
does not claim a verified publisher identity or Apple notarization. For a
future signed distribution, use the separate signing workflow below; macOS
also needs notarization and a stapled ticket. Signing is not silently enabled
by the unsigned publisher.

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
The native signed workflow must pass before any candidate is described as
signed and notarized.

## Release notes and checksums

Before requesting publication, prepare version-specific notes from the desktop
acceptance matrix. Include the exact version, supported architectures, notable
changes, known limitations, installation and uninstall steps, signing and
notarization results, and the SHA-256 values from `SHA256SUMS`. Verify every
checksum after downloading the workflow artifacts. Do not reuse notes or
checksums from another run or commit.

Both candidate-build workflows stop at downloadable workflow artifacts.
The dedicated publisher is the separately authorized path for this one
unsigned prerelease. Its Chinese notes template is
[`releases/0.1.0-rc.1.md`](./releases/0.1.0-rc.1.md); source SHA, workflow links,
verified architecture, asset sizes and hashes are injected from the validated
run. Template placeholders must never be copied directly into a release.

Run the publication safety regressions locally with:

```sh
node --test scripts/desktop-release.test.mjs
```
