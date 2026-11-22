# Completed steps

## SDK-WEB-01 — Foundation and contracts

**Status:** Implemented and validated locally. The changes are in the existing `Tot-Taylor/SudokuApp-Web` working tree and are uncommitted.

- Initialized a React, TypeScript and Vite app shell with Node.js 24, pinned npm dependencies, strict type checking, ESLint, and the GitHub Actions check workflow.
- Defined versioned, runtime-validated schemas for game snapshots, shared state, stats, mutations, receipts and API errors. Documented the active game, timer, completion deduplication, server order, offline journal and database restore rules. [Contracts](../docs/contracts.md)
- Reviewed the read-only Swift app and XCTest sources at commit `b76c97f025ea7de5bde8fa7a997c5856ce43169b`. Recorded native screens and rules, mismatches, visual cues, and verification owners. Added JSON fixtures for difficulty, solver, generator and the native-only reward reference. [Native parity](../docs/native-parity.md) · [Fixtures](../tests/fixtures/native-parity.json)

## SDK-WEB-02 — Sudoku engine

**Status:** Implemented and validated locally. Ticket 01 and 02 changes are uncommitted.

- Added a local solver, solution counting, naked and hidden singles checks, and deterministic seeded generation for all four difficulty tiers. A cancellable browser worker handles generation. Requests have attempt and search limits so the UI can offer a retry. [Generator](../src/engine/generator.ts) · [Worker client](../src/engine/generate-in-worker.ts)
- Added start and restore, editable-cell selection, placement, erase, foreground timing and a single completion result. Restore validates the snapshot, puzzle difficulty and unique solution. A completed board is read-only. [Game session](../src/engine/game.ts)
- Ran `npm run check` under Node.js 24.22.3. Lint, type checking, all 17 tests, and the production shell build passed. Tests include the native row-duplicate, uniqueness and repeat-seed fixtures and 32 generation seeds per difficulty.
- Sampled 128 seeds per difficulty on desktop Node. All 512 generated valid puzzles. The slowest generation in that run was approximately 24 ms. This sample excludes worker startup and is a desktop measurement.
- Loaded compiled engine modules and the worker in headless Edge. Verified all four tiers, retry after an attempt-limit result and cancellation. With the browser offline, played through a puzzle, observed one completion, and restored the solved snapshot.
- Native seed-to-board comparison, device timing on a physical iPhone, installed PWA startup and end-to-end sync remain pending.

## SDK-WEB-03 — Mobile web interface

**Status:** Implemented and validated locally. The changes for Tickets 01 through 03 are uncommitted.

- Added Home, four difficulty choices, replacement confirmation, a playable game screen, completion dialog with solve time, Statistics, Settings and the Shop placeholder. The web layout uses the SwiftUI palette, heart placeholders, selected row and column, and 3×3 borders. [UI entry](../src/ui/App.tsx) · [Parity inventory](../docs/native-parity.md)
- Wired touch and keyboard controls to a labeled grid with roving focus. Digits enter values, arrows move across the grid, and Delete or Backspace erases. The game clock checkpoints only while the board is open and focused.
- Used the browser-preview store to keep the one active game and completion records across reload. Failed or canceled generation preserves the active puzzle. The UI reports invalid saves and session-only storage. [Preview storage](../docs/contracts.md#ticket-03-preview-storage)
- `npm run check` passed lint, TypeScript, all 20 tests and the production build. Playwright passed all 12 browser cases across desktop Chromium and 320-pixel iPhone-sized WebKit, including storage failure, foreground timing, continuation, retry, completion deduplication and offline play after load.
- Opened the desktop preview in Codex. Reviewed 320-pixel WebKit Home and game screenshots, verified tap input, and checked that the board and keypad fit without horizontal scrolling. Physical iPhone, VoiceOver, native screenshot comparison and installed PWA startup remain pending.

## SDK-WEB-04 — Shared persistence and offline synchronization

**Status:** Implemented and validated on loopback. Tickets 01 through 04 are local and uncommitted.

- Added a same-origin Node HTTP server and SQLite database for one shared active puzzle and completion history. Transactions assign server revisions, validate immutable puzzle definitions, and store operation receipts. The latest accepted write wins and each solved UUID contributes to stats once. [Server](../server/app.ts) · [Database](../server/database.ts)
- Replaced preview writes with a transactional IndexedDB journal. The connected app retries queued moves with their original IDs, syncs on foreground reconnect, coordinates tabs, and shows saving, offline, pending, and acknowledged states. It imports Ticket 03 data once on the same origin. [Sync client](../src/sync/client.ts) · [Storage and wire contract](../docs/contracts.md)
- Added backup and restore commands that create new files. Restore rotates the history UUID before the new database is available. The app keeps older queued work under Saved changes for explicit recovery and ignores later responses from retired histories. [Local administration](../README.md#local-backup-and-restore)
- `npm run check` passed lint, type checking, 30 Node tests, and the production build. Playwright passed 24 tests in desktop Chromium and iPhone-sized WebKit. Connected cases covered offline reload with the API blocked, two-device server ordering, lost acknowledgements, shared tabs, restore recovery, preview import, and origin and cache controls.
- Exercised the normal server entry point, live SQLite backup, and restore into a new history. Installed offline startup and physical iPhone checks remain pending. Live Tailscale access, guest provisioning and scheduled backup retention belong to Ticket 06.

## SDK-WEB-05 — Installable iPhone PWA

**Status:** Implemented and verified on loopback. Physical iPhone acceptance is pending on the private HTTPS origin. Tickets 01 through 05 are local and uncommitted.

- Added the stable standalone Sudoku manifest and a rose grid icon based on the app wordmark. The build serves 192 px and 512 px manifest icons and a dedicated 180 px Apple touch icon. [Manifest](../public/manifest.webmanifest)
- Added a content-versioned service worker that installs the app shell, compiled assets and puzzle worker as a complete set. API traffic stays live and queued moves stay in IndexedDB. A waiting update leaves the current game open until its windows close. [Build plugin](../src/pwa/build.ts) · [Worker](../src/pwa/service-worker.js)
- Added offline readiness in Settings, an update notice, and a recovery screen for missing app files. The worker repairs its release files when the same version is reachable. The installed app requests persistent storage when available.
- `npm run check` passed lint, type checking, 30 Node tests and the production build. Playwright passed 34 tests in desktop Chromium and iPhone-sized WebKit. PWA cases covered manifest and icons, offline close and reopen, generation before first sync, reconnect, portrait and landscape widths, a real second build with pending edits, and cache repair.
- Verified localhost delivery of the HTML, manifest and worker. The Codex in-app preview timed out. Home Screen installation, standalone iOS behavior, VoiceOver, and Tailscale access remain physical-device checks. [iPhone checklist and release procedure](../docs/iphone-pwa.md)

## SDK-WEB-06 — Deployment preparation

**Status:** Local preparation, rehearsal, and the authorized read-only `pve2` preflight are complete. The implementation is local and uncommitted. Host provisioning and release activation remain pending.

- Added a clean-checkout release builder that records the reviewed Git commit, packages the connected PWA and server, and emits a SHA-256 sidecar. The rehearsal option is marked `deployable: false`. Verified that a dirty checkout cannot produce a deployable archive and an existing release ID cannot be overwritten. [Release builder](../deploy/stage-release.ts)
- Added the dedicated systemd service, environment example, backup service, and daily timer. The proposed loopback port is 4174, with the database under `/var/lib/sudokuapp-web` and versioned releases under `/opt/sudokuapp-web`. The backup runs at 08:30 UTC and keeps the newest 30 verified daily snapshots. Manual backup files are kept for rollback and managed separately. [Proxmox runbook](../docs/proxmox-deployment.md)
- Updated `/healthz` to check the shared Sudoku state. Added SQLite integrity verification to the admin tools and automated tests for the 31st daily snapshot, a repeated run on the same UTC date, and a bad same-day file.
- `npm run check` passed lint, type checking, 32 Node tests and the production build. All 36 Chromium and WebKit browser tests passed. Parsed the shell blocks in the runbook without executing them.
- Verified the SHA-256 sidecars and runtime contents for the `local-check-ticket06-first` and `local-check-ticket06-candidate` archives under `releases/`. Installed production dependencies, served both packages on Windows loopback, backed up a live synthetic database, and restored it into an isolated new history. Switching to the candidate and back preserved a newly accepted move, completion totals, and idempotent receipts.
- On November 22, 2026, the Proxmox console confirmed ID 103 was free on `pve2`. The x86-64 host had 4 CPUs and about 9.9 GiB of available RAM. `local-lvm` supported container volumes with about 1,355 GiB free. `local` had about 82 GiB free and contained `debian-13-standard_13.6-1_amd64.tar.zst`.
- The `vmbr0` bridge was up and carried the host's default route. Fry-By CT 102 used DHCP on that bridge. `/dev/net/tun` was present and the host resolved `pkgs.tailscale.com`. Fry-By was running, `fry-by.service` was active, `/healthz` returned `{"status":"ok"}`, and Tailscale Serve reported tailnet-only HTTPS to `127.0.0.1:4173`.
- Proxmox showed zero scheduled backup jobs and only the `local` and `local-lvm` storage definitions. An approved off-guest backup destination still needs to be selected. Guest validation still includes systemd, private HTTPS and its access policy, reboot persistence, scheduled backups and restore, and physical iPhone installation. Recheck Fry-By against the baseline after release activation.

## Owner decisions carried forward

- Keep the original Swift repository read-only. Use the existing web repository for development.
- Use one shared profile and one unfinished active game. Devices share the same server database. Tailscale controls online access, and the installed app saves local play in IndexedDB.
- The last successfully applied server update wins. A later offline replay can take precedence. A receipt replay never reapplies its mutation. The winning write supplies the whole active snapshot.
- Count each game UUID once. The first valid completion records its time and clears the active slot. A second completion for that UUID leaves the current slot and stats intact. Show completion counts, best times, and average times by difficulty.
- Enable selection, entry, erasing, resume, and successful completion. Hints, lives, Undo, Give Up, and points are disabled in v1. Shop is a placeholder. Use the SwiftUI source as the visual reference.
- Count time only while the puzzle is open and visible in the foreground. Support iOS 18 and later.
- Deployment target is `pve2` CT 103 with private Tailscale HTTPS, following the Fry-By pattern. Provisioning and deployment require separate approval. Retain 30 daily backup snapshots. The off-guest destination remains open.

The approved decisions and [current contracts](../docs/contracts.md) supersede the original planning package where they differ. In particular, the original package calls for app accounts, manual conflict selection, and point awards. For ticket scope and order, use `SudokuApp-Web-Codex-Plan.zip` in Downloads. Fry-By-Web's `AI Context/Completed work.md` and `AI Context/fry-by-deployment-and-updates.md` remain references for deployment and offline persistence patterns.

## Ticket 01 validation

- Clean `npm ci` passed under Node.js 24.22.1. The npm audit reported zero vulnerabilities at install time.
- `npm run check` passed lint, strict type checking, seven contract tests, and the production build.
- The development server and production preview both served the Sudoku HTML shell and JavaScript entry over local loopback.
- The GitHub Actions workflow runs those checks on pushes and pull requests. A hosted run, native XCTest execution, screenshot comparison, installed iPhone behavior, and Proxmox operations remain pending.

## Resume here

Ticket 06 resumes with authorization to provision CT 103 and deploy a release built from a reviewed commit. Recheck that ID 103 is free at provisioning time. The proposed guest hostname is `sudokuapp-web`. Confirm tailnet access and the off-guest backup destination before verifying the deployment. Follow the [Proxmox runbook](../docs/proxmox-deployment.md) and the [physical iPhone checklist](../docs/iphone-pwa.md#physical-iphone-acceptance).
