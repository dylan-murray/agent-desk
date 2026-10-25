# Desktop integration validation

The integration baseline below was verified locally on Apple Silicon macOS on 2026-10-24. Versioning changes are recorded separately at the end of this document. User acceptance remains pending. No annotation was accepted or rejected by this work. The installed app and stored user data were not changed; local build artifacts are under `desktop/out/`.

## Implementation

- Ordinary HTTP uses native `fetch()` through `agent-desk://app`, with main-process Unix-socket destination/authentication control and registered main-frame authorization. The ordinary request IPC bridge and `deskFetch` were removed. Terminal events retain their message-port adapter.
- Startup has a separate near-black loading document with a centered 48px logo, 13px status, blue dot, Reduce Motion support, and one Retry button. Runtime verification/backend readiness and an actual configuration read finish before workspace navigation. The initial blocking configuration script receives that exact backend snapshot. Configuration/account hydration, startup pane placeholders, and feature-specific desktop readiness guards were removed.
- Recovery after initial workspace load keeps the document, drafts and terminal owners. Disconnected mutations fail without queuing or replay. Concurrent retries share an attempt.
- The Python managed-tool adapter forwards POST bytes and authentication headers, with socket checks and no automatic redirects. README completion keeps its document/revision checks.
- Coordinator runtime activity supplies quit status for planning, runnable queued turns/deliveries, and active PR monitors. Idle saved coordinators alone do not count. The native confirmation lists these categories.
- The unused attachment endpoint/module and request-size exception were removed. Stored attachments were left untouched. README-frame fetch changes and unrelated browser-test edits were reverted.
- README, contributor instructions and guide present browser and macOS desktop usage directly. Desktop CI includes transport, startup, preparation quit, coordinator/native quit regressions, and root dependency/packaging manifest triggers.

## Verified

| Check | Result |
| --- | --- |
| Full Python suite | 426 tests, OK; one optional browser check skipped |
| Root Node suite | 31 passed |
| Desktop Node suite | 18 passed |
| Electron transport proof | Native GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, JSON/URL-encoded/multipart/binary bodies, application headers, status/errors, config, restricted redirects, streaming, abort and reader cancellation |
| Authority proof | Tool frames have no preload/application authority; forged headers and opaque no-cors POSTs never reach the app socket; unregistered windows are rejected |
| Startup | Opening/setup labels, injected configuration failure, Retry/concurrent Retry, pending mutation rejected, real config, hidden development controls, Reduce Motion, close/reopen and same-document recovery |
| Preparation quit | No later/orphan backend launch |
| Native quit | Coordinator-only/monitor-only confirmation, Cancel, Keep Running, Stop Work and Quit; idle saved coordinator exits without confirmation |
| Electron smoke | PTY I/O, report windows/reload, backend crash with surviving terminal and draft, no mutation replay, fixture tool feedback, fullscreen, pane selection/geometry persistence |
| Browser header fixture | Desktop/520px/480px and browser fullscreen |
| Native About fixture | Development app name/build identity and native panel screenshot |
| Local macOS package | Bundled runtimes with host Python/Node absent from PATH, first staging, retained-runtime cold launch, single-instance reuse, fixture PTY, verified shutdown, no app-owned TCP listeners |
| Local DMG | Verified read-only mount and relocated signed app, repeating packaged runtime/terminal/listener checks |

The Python remote-runtime and bootstrap fixtures cover worker reporting after a bridge disconnect, reconnection without duplicate work, coordinator reopening, and version guards. They use a local SSH-stream substitute and fictional CLIs. They do not claim a new live-SSH interoperability run.

All UI checks used disposable profiles and fictional sessions. Source fixture stage notifications verify setup wording; the packaged/DMG checks exercise actual first-run runtime staging and integrity checks. Local signatures are ad-hoc, not Developer ID distribution signing/notarization.

## Scope and integration requirements

At the integration baseline there were **26 modified existing tracked files against the 39-file baseline**: 14 baseline modifications were restored to HEAD and one existing coordinator regression file was added to the diff. New desktop/transport/fixture files are excluded from both counts; file count is evidence, not a quota.

Removed desktop-specific paths include the HTTP feature wrappers, per-screen refresh guards and desktop-ready subscriptions, account hydration callback, loading-session ternary, pane-placeholder branch, desktop-only pane-pruning readiness operand, and shared fullscreen branch. A generic successful-agent-fetch flag lets both browser and desktop discard stale saved pane IDs only after data arrives.

Remaining integration requirements are the protocol/frame gate and native lifecycle controls in main, preload state/fullscreen/terminal ports, native chrome/reconnect notice in desktop assets, desktop pane storage, managed-tool origin handling, and the terminal connection adapter. Backend architecture, lifecycle ownership, packaging, profiles, sockets and supervisor protocol remain in place.

## Evidence and acceptance

Screenshots are local under `AGENT_DESK_EVIDENCE_DIR`, or the system temporary directory by default:

- `agent-desk-centered-loading-{1280,520,480}-before.png`
- `agent-desk-loading-{1280,520,480}.png`
- `agent-desk-loading-failed.png`, `agent-desk-loading-setup.png`
- `agent-desk-desktop-wide.png`, `agent-desk-desktop-narrow.png`, `agent-desk-desktop-480.png`, `agent-desk-desktop-fullscreen.png`
- `agent-desk-native-about.png`

The loading and workspace screenshots were visually inspected. Screenshots capture web content; manual acceptance remains for native traffic-light clicks, physical dragging, display removal, Dock appearance and spacing on a physical small Mac. The installed third-party annotator entry points still need individual compatibility checks before being advertised as supported. Developer ID signing/notarization and live SSH credentials/network behavior remain separate integration checks. No implementation or passing test implies user acceptance.


## Shared release versioning

Implemented: `pyproject.toml` supplies the Python and desktop version. Desktop bundle/package versions and embedded About metadata use that version. Source/local/manual builds show Development build; tagged release packages show Release build. Full metadata retains the dirty flag and UTC timestamp in local diagnostics. Only a matching `desktop-MAJOR.MINOR.PATCH` tag push on its clean tagged commit produces release metadata. Version bumps are needed for new published releases, not individual commits. Remote source bundles carry generated version metadata; their content-hash compatibility guards remain independent of release numbering.

Apple signing is controlled by `AGENT_DESK_APPLE_SIGNING`; release tagging does not enable it. Current CI releases retain ad-hoc signing. Added `desktop/AGENTS.md` and updated the desktop README, root contributor guide, and user guide. The root `AGENTS.md` is unchanged.

Verified for this change:

| Check | Result |
| --- | --- |
| Full Python suite | 429 tests, OK; one optional browser check skipped (run with loopback/PTY permissions) |
| Desktop Node suite | 28 passed, including clean/dirty/development/release identity, annotated tags, mismatched tags and immutable publication retries |
| Root Node suite | 31 passed |
| Version import fixtures | Source project, installed distribution metadata, isolated desktop source and remote bundle imports |
| Remote bootstrap and bundle fixtures | Installation/reconnection/version guard and deterministic code-only bundling passed |
| Native About | Original combined metadata display verified; superseded by the compact About follow-up below |
| Local package and DMG | Rebuilt with the shared version; signed bundle, embedded package version, macOS version and bundled Python version agree; fixture terminal/relaunch checks and read-only mounted-DMG checks passed |

Native About evidence is local: `/private/tmp/agent-desk-about-before-versioning.png` and `agent-desk-native-about.png` in the system temporary directory. The native panel sizes itself independently of the workspace width; this change does not alter the workspace layout.

GitHub publication with a real version tag and Developer ID signing/notarization remain unverified by this local work. No release tag was created or pushed. User acceptance remains pending.


## Compact About follow-up

Implemented the agreed two-line presentation: **Version 0.1.0** with **Development build · <commit>** or **Release build · <commit>** below it. The UTC timestamp and dirty flag remain in embedded metadata and are copied on launch into `logs/build-info.json`, accessible through Open Local Diagnostics.

Verified: 28 desktop unit tests passed, including both build labels and preservation of complete diagnostics. The native panel was checked and visually inspected; the compact version and development label fit on separate lines. Rebuilt the macOS app and passed packaged-app checks, including the diagnostics snapshot, bundled version consistency, relaunch/runtime reuse, fixture terminal, and shutdown. This display-only follow-up did not rerun the earlier Python suite or DMG checks.

Before screenshot: `/private/tmp/agent-desk-about-before-short-labels.png`. After screenshot: `agent-desk-native-about.png` in the system temporary directory. This supersedes the earlier combined About display. The wording/layout was agreed in conversation; acceptance of the rendered result remains pending.


## Automatic desktop reconnection

Implemented automatic retries for temporary backend/stream connection failures at 1, 2, 5, 10, then 30-second intervals (capped at 30 seconds). Returning to the app or waking the computer starts an immediate attempt while disconnected. Manual Retry and all existing menu items remain available. Recovery reuses the workspace document and never queues or replays failed actions.

Retries are cancelled during quit/shutdown, stay stopped after an incomplete shutdown, and stop for setup, authentication, identity, or incompatible connection-record failures. Concurrent recovery requests share one attempt. Live owners and children still waiting to write a connection record are never duplicated. Browser mode is unchanged by this desktop-only follow-up.

Verified: 33 desktop unit tests passed, covering backoff/reset, queued cancellation, immediate retries, failure classification, and backend ownership. The real Electron startup fixture recovered from an injected transient failure without a click at narrow width; loading/layout checks covered 1280, 520, and 480 pixels. The real Electron smoke fixture recovered after SIGKILL without a Retry click, preserved the supervised terminal, pane and unsent draft, and verified that a failed launch was not replayed; responsive/fullscreen checks passed. Quit-during-preparation and native Cancel/Keep Running/Stop Work and Quit checks passed. Physical system sleep/wake was not exercised; the immediate retry scheduler was unit checked.

Before evidence: `/private/tmp/agent-desk-before-auto-retry.png`. After evidence: `agent-desk-loading-failed.png` and the desktop wide/narrow screenshots in the system temporary directory. The automatic-retry message was visually inspected at narrow width. Implementation and verification are complete; user acceptance remains pending.

## Manual stop/update/restart and desktop webhook fixes (2026-10-25)

Implemented: installed runtime code now uses `<profile>/runtime/`. Changed source or packaged code requires full shutdown of the previous managed owners before startup; packaged identity includes the Electron shell as well as its backend payload. Replacement copies and verifies the runtime before switching directories, preserves `data/`, and leaves legacy hashed `runtimes/` directories untouched. Source/debug runs use Agent Desk Dev by default; installed packages use Agent Desk. The existing explicit profile override remains available. No user-facing settings were added.

Stop Work and Quit pauses new launches and scheduling, waits on the shared tool launch lock, then stops managed local work and command descendants. Short graceful deadlines are followed by forced cleanup of verified owned processes, including an authenticated supervisor or backend that resists exit. Exit is confirmed before success; unverifiable ownership leaves shutdown incomplete and paused. Same-build crash recovery retains its previous behavior.

Desktop webhook ingestion authenticates its source bearer token before the terminal-token gate, retains request/body validation, and rejects ingestion during a shutdown pause. Backend responses supply the real workspace address, Unix socket and webhook URL. The connection dialog shows these details and a copyable curl command; browser mode keeps its HTTP URL. Desktop Copy uses a registered main-frame native clipboard write, with no clipboard read capability exposed to renderers. Source tokens and curl examples are cleared when the dialog closes.

Verified locally with disposable profiles and fictional sessions:

| Check | Result |
| --- | --- |
| Full Python suite | 433 tests, OK; one optional browser check skipped |
| Root Node suite | 31 passed |
| Desktop Node suite | 36 passed, including stable runtime replacement, data/legacy-directory preservation, refusal with live owners, source-change refusal and same-build recovery |
| Shutdown launch overlap | A separate helper held the launch lock while starting a slow tool; shutdown waited, blocked new terminals, stopped the resistant tool, and left no fixture tool alive |
| Forced cleanup | Suspended workflow worker and resistant command child exited; unrelated process survived. Authenticated idle supervisor and post-cleanup backend resistance were force-stopped and exit was confirmed |
| Incomplete shutdown | An unrelated PID could not pass worker ownership checks; it was not signalled, shutdown returned incomplete, and the pause persisted across backend restart |
| Webhook transport | Source-only Unix-socket curl, invalid and rotated tokens, duplicates, foreign Origin rejection, shutdown pause/resume, and correct workspace/socket details |
| Browser webhook behavior | Real source/rule CRUD, token rotation, duplicate handling, sequential command delivery, desktop/390px dialogs and existing modal annotation checks |
| Electron lifecycle | Transport/frame authority, startup/reconnect, quit during preparation, native Cancel/Keep Running/Stop Work and Quit, fixture PTY/tool smoke and same-build backend crash recovery |
| Development branding | Actual source bundle and native Dock name use Agent Desk Dev; compact native About still shows the shared version/build |
| Local macOS package | Signed ad-hoc app built; bundled runtimes without host Python/Node on PATH, stable runtime path, cold relaunch, independent simultaneous debug profile, fixture PTY, no app-owned TCP listeners, and confirmed shutdown |

Desktop connection screenshots `agent-desk-webhook-1280.png` and `agent-desk-webhook-480.png`, and browser `2026-09-16-event-triggers-connection-{desktop,narrow}.png`, were written under the system temporary evidence directory and visually inspected. They contain fixture-only connection details. Native Copy was verified through its exact native write call; this execution environment did not expose successful macOS pasteboard round trips even for a direct native fixture write, so actual system pasteboard contents remain unverified.

User acceptance remains pending. No notes were accepted or rejected. The installed user app/profile was not replaced. GitHub publication, Developer ID notarization, physical Dock interaction and live SSH behavior were not acceptance checks for this change. The DMG workflow was unchanged and was not rerun for this change.

## Release checkout and web-pane restoration fixes (2026-10-25)

Implemented: the publish job now validates its clean tagged checkout before downloading release artifacts. Desktop web-page records persist alongside their pane IDs and geometry, with migration from an existing window's session records. Browser pages keep their per-tab session storage. Closing a restored page removes its persistent record, including when stale session records still exist.

Verified: the new storage regressions and the extended real Electron smoke check reproduced the missing pages before the fix. After the fix, all 34 root Node tests and 36 desktop unit tests passed. The Electron check restarted the full app process with empty session storage and restored the same web-page ID, name, URL and pane geometry; closing the restored pane stayed closed after reload. Existing fixture PTY streaming, backend crash recovery, report windows and tool feedback also passed.

The actual publishing step order was replayed with a clean tagged fixture repository, a fictional DMG/checksum download and mocked GitHub calls. It reached publication after validation and checksum verification; dirty source and modified DMG bytes remained rejected. No tag or GitHub release was created. Packaging and DMG generation were not changed or rerun.

Fixture screenshots `agent-desk-web-pane-before-restart.png`, `agent-desk-web-pane-restored-1280.png` and `agent-desk-web-pane-restored-480.png` were written to the system temporary evidence directory. The restored desktop and narrow screenshots were visually inspected. User acceptance remains pending; no annotations were accepted or rejected.

## Extra menu bar icon removal (2026-10-25)

Implemented: removed the extra menu bar icon, its artwork and artwork generation. The Dock reopens the hidden window; the standard Agent Desk menu retains recovery, diagnostics and Quit. Updated the desktop README and user guide.

Verified with disposable profiles and fictional sessions: all 36 desktop unit checks passed; the real Electron startup check covered 1280, 520 and 480 pixels and verified that emitting the Dock activation event reopens the hidden window with the same document. Native quit checks passed for Cancel, Keep Running, Stop Work and Quit, and idle saved coordinators. The initial sandboxed unit run was blocked by socket/process permissions; the permitted rerun passed.

Physical Dock interaction and user acceptance remain pending. No installed app or user profile was changed; packaging was not rerun.

## Sessions after quitting and reopening (2026-10-25)

Implemented: desktop shutdown uses the shared supervisor teardown instead of invoking per-terminal Stop. Native conversation IDs are captured before CLI exit, and the existing teardown preserves terminal restore records. Reopening uses the shared restore behavior and original IDs, names, folders and saved panes. The web app's persistence format and session rules are unchanged. Runtime-pruning changes and their fixtures/documentation were removed; only menu icon removal and this stop/start fix remain.

Verified: the new desktop shutdown regression failed before the fix because the saved terminal list became empty. After the fix, focused Python checks passed across terminal restoration, desktop transport/shutdown, supervisor recovery, terminals and coordinator runtime. All 36 remaining desktop unit checks passed after removing pruning. The real Electron native-quit fixture confirmed process exit, restored the saved pane and renamed terminal at 1280px and 480px, accepted keyboard input after reopening, and kept explicitly stopped terminals closed on the next launch. Fictional Claude/Codex fixtures verified exact conversation IDs captured during supervisor shutdown and resumed after replacement.

Evidence: `agent-desk-session-before-quit.png` and `agent-desk-session-restored-{1280,480}.png` in `AGENT_DESK_EVIDENCE_DIR` or the system temporary directory. The restored wide and narrow screenshots were visually inspected. All checks used disposable profiles and fictional sessions. The installed app was not rebuilt or replaced, and live user data was not inspected or changed. Implementation and verification are complete; user acceptance remains pending.

## Desktop quit checkpoint review fixes (2026-10-25)

Implemented: desktop quit opts into native conversation discovery for live coordinator workers after planner shutdown, using the existing mailbox and SQLite records without cancelling unfinished assignments. Lookup and database errors leave shutdown incomplete. Supervisor capture, save and timeout failures no longer enter the desktop force-stop fallback. A failed checkpoint reply restores the supervisor's availability and persistence so the same live sessions can be retried. Forced cleanup after an acknowledged checkpoint remains supported. Default web checkpointing and backend restart behavior are unchanged.

Verified: the new regressions failed before the fixes. Relevant Python checks passed across coordinator runtime (62 existing checks plus the new SQLite-failure check), desktop transport/shutdown (14), terminal restoration (12), and supervisor/web backend restart (11). Fixtures covered discoverable worker IDs not yet reported to the mailbox, preserved unfinished assignments, lookup failures/timeouts, SQLite and JSON save failures, failed replies, unchanged live process identities, successful retry, and forced cleanup after acknowledgment. All 36 desktop unit checks passed. The extended native quit check confirmed that a real save failure keeps the app visible and its terminal alive, then retry exits and reopening restores the same session at 1280px and 480px. Explicitly stopped sessions stayed closed.

All checks used disposable profiles and fictional sessions. The installed app/profile was not replaced and packaging was not rerun. User acceptance remains pending.

## Expanded-pane native window controls (2026-10-25)

Implemented: an expanded pane in a regular macOS window hides the native traffic lights. Escape, collapsing/closing the pane, leaving Sessions and document navigation restore the controls. Native whole-window fullscreen keeps its existing behavior; leaving native fullscreen while a pane remains expanded hides the controls again. This is confined to the desktop bridge and shell.

Verified: the real Electron smoke fixture first reproduced all three AppKit buttons remaining visible over an expanded pane at 1280px and 480px. After the fix, a fixture-only Node-API/AppKit inspector verified their actual hidden state and restoration across Escape, page switches, reload, pane close and native fullscreen transitions. The complete native smoke check passed, including backend crash recovery, tool feedback and cold-start web-pane restoration. A browser-only header check passed at desktop/narrow widths and retained browser fullscreen. An intermediate native run hit a startup disconnect, and another caught a load/reload timing race; the final isolated run passed after the fixture waited for full document loading before navigation.

Before/after pane-content screenshots `agent-desk-pane-fullscreen-{1280,480}[-before].png` were saved under `AGENT_DESK_EVIDENCE_DIR` or the system temporary directory. Content screenshots exclude native window controls; the AppKit inspector verified those separately. The wide and narrow content screenshots were visually inspected. No live sessions or installed user profile were used. Implementation and verification are complete; user acceptance remains pending.
