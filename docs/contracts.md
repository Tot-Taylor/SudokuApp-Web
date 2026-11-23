# Game, API, and synchronization contracts

These are the Ticket 01 contracts for the later engine, UI and backend. The owner approved one shared profile, ordering by successful server update, no points in v1, and iOS 18. These decisions supersede the planning ZIP's app accounts, manual conflicts and point awards.

The app uses Node.js 24, TypeScript, React, Vite and Zod. A same-origin Node HTTP server serves the build and API with SQLite from Node's standard library. The browser uses IndexedDB for its local state and a versioned service-worker cache for the app files. [iPhone installation and release lifecycle](iphone-pwa.md)

## Game and statistics

- The singleton profile contains one unfinished active-game slot, settings, and stats. Each new game gets a UUID. Each snapshot includes schema version 1, game ID, difficulty, original givens, solution, current board, selected editable cell, foreground elapsed milliseconds, and active or solved status.
- Boards are row-major arrays of 81 entries. Digits are 1–9 and `null` represents a blank. Givens always match the solution and current board. Givens, difficulty and solution are immutable for a known UUID. Cell origin is derived from givens and current values. The TypeScript [snapshot schema](../src/contracts/game.ts) checks shape and internal consistency. The engine validates actual Sudoku legality, uniqueness and difficulty.
- Start, enter, erase, undo, resume, and solve work locally. The full board counts as solved only when it matches the validated solution. Hints, lives, Give Up, and points are disabled in v1. `settings` is an empty, strict object while there are zero enabled preferences.
- Candidate notes are optional snapshot data. Each editable cell has a mask with one bit per digit, starting with digit 1 at the lowest bit. Only blank editable cells expose candidate editing. A real entry hides its cell's notes. Erasing the entry reveals them, and erasing an already blank cell clears its notes. Duplicate checks and completion use the real values. The Normal/Candidate input preference is saved in the current browser, while notes sync with puzzle progress.
- Active games save up to the latest 100 board edits with the current snapshot. Each entry stores the changed cells' previous and resulting values and candidate masks. Clear All is one entry regardless of how many cells it clears. Undo restores board contents and leaves selection and the clock as they are.
- Older v1 saves open with empty history. On restore, the puzzle UUID and a key for the current board bind history to its snapshot. Malformed, mismatched, or inconsistent history is discarded while valid progress is retained. Active snapshots with history sync through the same journal and server storage as board values. The client and server must both understand the optional snapshot fields to sync these saves.
- Measure elapsed play with a monotonic clock while the game screen is open and visible. Pause it when leaving the screen or when the page becomes hidden, and restart timing on resume. Checkpoint accrued time periodically and on visibility changes so an interrupted device resumes from saved foreground time. The winning snapshot carries its own elapsed time. Durations from different devices are never added together.
- The server stores a completion record keyed by game UUID. Per-difficulty stats contain `completedCount`, `totalTimeMs` and nullable `bestTimeMs`. Average is total divided by count and is absent when the count is zero. The first validated completion fixes the game's stats contribution. Off-device stats become canonical when that completion is accepted. The UI may show a pending completion locally.

### Engine integration

- Use [`generateInWorker`](../src/engine/generate-in-worker.ts) when starting a puzzle from the browser UI. Keep the current saved game through generation and replace it after success. Report `attempt-limit` or `search-limit` as a retryable failure and use an abort signal when leaving the flow.
- Use [`startGame`, `restoreGame`, and `updateGame`](../src/engine/game.ts) to create, restore, and play. Save `session.snapshot`. The running clock timestamp belongs to the current page only. Supply `performance.now()` for actions and send foreground transitions on entering or leaving the visible board and when the page hides or resumes. Take periodic checkpoints during play.
- Use the returned solved snapshot and completion from the same update when journaling `complete-game`. Restoring or updating a solved session produces zero additional completion events. The server handles retry and cross-device deduplication by game UUID.
- The production build precaches the compiled puzzle worker alongside the app shell so a prepared device can generate puzzles offline.

### Ticket 03 preview storage

Ticket 03 saved one active snapshot and completion summaries in the `sudoku.preview.v1` localStorage record. On first access at the same origin, the [migration reader](../src/ui/preview-store.ts) validates it and commits the active game, completion imports, and journal in IndexedDB. The legacy key is cleared after a successful migration. Completion summaries use the original UUIDs and include their original time and difficulty.

## Private access and storage

The production app serves one profile at a stable, same-origin HTTPS address through Tailscale Serve. Tailnet access is the user access boundary. The service binds to `127.0.0.1`. Restrict Tailscale access to the owner's authorized identities or devices. Set `SUDOKU_ORIGIN` to the stable HTTPS origin and `SUDOKU_DB` to the persistent database file outside the build directory. The configured origin and loopback backend host are accepted. The HTTP origin in [.env.example](../.env.example) supports local testing. The application has no sign-in, accounts, app sessions, or shared database with Fry-By.

For mutations, require an exact configured HTTPS `Origin` and JSON content type. Keep the API same-origin and deny cross-origin writes. Use non-cacheable API responses. The iPhone service worker caches versioned static app assets only. IndexedDB holds the local game, pending operations, last fetched state, and storage schema version. Once provisioned, anyone who can open the app on that device can access its local game offline. The device lock provides the local access boundary. The app needs an initial online visit to provision app assets. Complete loss of browser storage can lose unacknowledged changes.

The solution is delivered to the admitted device because offline validation requires it. Treat it as inspectable by that device. Live data and release files use independent paths. SQLite uses WAL and transactional schema migrations. The admin commands copy consistent SQLite snapshots and publish a new file. Provisioning, the 30-snapshot daily retention schedule, and off-guest backup storage belong to Ticket 06.

## API v1

The [shared schemas](../src/contracts/sync.ts) define the payloads for the later same-origin backend.

| Route | Contract |
| --- | --- |
| `GET /api/v1/state` | Returns one atomic snapshot with `schemaVersion`, `historyId`, global `revision`, nullable `activeGame`, `settings`, `stats`, and `completedGameIds`. The client uses the completed IDs to count queued solves only until they appear in server stats. Revision 0 is valid for a fresh database. |
| `POST /api/v1/mutations` | Takes `schemaVersion`, `historyId`, `operationId`, and `kind`. `save-game` carries an active snapshot in `game`. `complete-game` carries a solved snapshot in `game`. `import-completion` carries a legacy summary in `completion` because Ticket 03 saved only the UUID, time, and difficulty of completed games. An import clears the active slot only if it has the same game UUID. HTTP 200 returns the same history and operation IDs, the result's revision, and outcome `applied` or `already-completed`. |
| `GET /healthz` | Checks that SQLite can read the current shared profile and schema. Replies with a generic readiness result. |

Use stable safe error bodies with `code` and `message`. Invalid schema or unsupported wire version is 400 `INVALID_REQUEST`. Wrong origin is 403 `ORIGIN_DENIED`. Changed history, reused operation ID with a different payload, changed immutable game definition, or an attempted save of an already completed game is 409 with `HISTORY_CHANGED`, `OPERATION_ID_REUSED`, `GAME_ID_REUSED`, or `GAME_ALREADY_COMPLETED` respectively. Invalid Sudoku content is 422 `INVALID_GAME`. Temporary unavailability is 503 `UNAVAILABLE`.

### Server ordering and completion

1. The server validates the request and current history, then checks for an existing operation receipt. For a matching operation ID and semantic payload, return the original receipt before evaluating current-game state. Reuse with a changed payload is rejected. Allocate a fresh ID for each new intent.
2. Each new applied mutation increments the server revision in the same transaction as the state change and receipt. Concurrent accepted writes are serialized by the database. An otherwise valid save replaces the entire active slot, even if it is based on a stale local copy or belongs to an unfinished game previously replaced on another device. Device timestamps and revisions from which a device edited have no bearing on acceptance order. Changing an immutable puzzle definition for an already registered ID is rejected.
3. Each first accepted completion writes its immutable record, updates canonical stats, clears the active slot, and writes the receipt in the same transaction. If another unfinished game occupied the slot, the later applied completion takes precedence. The next accepted save for an unfinished game can make it active. A completed game cannot be reopened as an active snapshot.
4. A separate completion operation for an already completed game is acknowledged as `already-completed` with that game's original completion revision. Persist its receipt, keeping the current state, revision counters and recorded stats intact.
5. When editable settings are introduced, a successful write to a preference supersedes earlier accepted writes to that preference. It applies to future games. Changes to the active slot and settings carry independent payloads. This prevents a game save from overwriting settings.

### Offline journal and restore

- Commit a local gameplay edit and its queued operation in one IndexedDB transaction. Selection and clock-only changes checkpoint locally and ride along with the next game mutation. New Game confirms replacement whenever the device sees an unfinished puzzle. An offline device can play before learning about changes from another device.
- Bind each queued operation to the last verified history when enqueuing it. A prepared device playing offline before its first successful API pull can keep operations unbound until it learns the history. Freeze the payload and ID before the first send. Replay outstanding operations in order with a single sender per local store. A lost response reuses the exact request. Clear a queued item only when its receipt is durably applied. Persist any terminal validation failure for review and expose an actionable error.
- On launch, foreground return, connectivity change and after a write, attempt sync while active. Poll at four-second intervals while visible, with retry backoff capped at 30 seconds. Show offline, pending, and failure status. Pull canonical state after writes and compare revisions only within the same history. Preserve local edits while their operations are pending and keep local selection and time checkpoints across repeated pulls of the same revision. Apply a newer active snapshot once pending game operations are acknowledged or put aside for recovery.
- Tabs share one transactional IndexedDB journal and notify each other through BroadcastChannel. Web Locks coordinates the foreground sender where available. Idempotent receipts and journal transactions handle repeated submissions. A storage exception leaves the session playable in memory and reports that progress stays in that tab.
- On restore, preserve the restored game's data, completed-game IDs and stats, and issue a new history UUID before accepting requests. The client pauses operations bound to the previous history, keeps local recovery data, and pulls a fresh snapshot. Delayed responses from a retired history are ignored. The user can review the restored state and deliberately reapply an eligible snapshot with a fresh operation under the new history. Completion deduplication covers all completion IDs present in the restored database.
- Version local data and wire schemas. Use transactional, fixture-tested migrations. Clients that cannot read a newer version retain their pending data and report that an update is required. Test a release update and rollback with a pending journal before using it on a device.

## Implementation acceptance examples

| Scenario | Expected result |
| --- | --- |
| Device A moves at 2:00 offline. Device B saves at 2:05. A reconnects and successfully saves at 2:10. | A's snapshot gets the higher server revision and occupies the active slot. |
| A saves and the acknowledgement is lost. B then saves. A retries the original request. | A gets its original receipt. B stays active because the retry applies zero new writes. |
| B starts a new puzzle while A is offline. A later saves its earlier unfinished game. | A's game becomes active if its save is the latest accepted write. Each accepted save still contains a single game only. |
| A finishes a game, B starts a different game, then another device submits a second completion for A's game. | The duplicate receives `already-completed`. B stays active. The first solve's time contributes once. |
| A finishes offline and submits the first valid completion after B's replacement game has synced. | A's completion is recorded once and the active slot clears at that revision. |
| A saves an unfinished copy of a game after its completion has been accepted. | The server returns `GAME_ALREADY_COMPLETED`. The completion and active slot stay authoritative. |
| A write reaches the restored database using a pre-restore history. | The server returns `HISTORY_CHANGED` before looking up the old receipt. The client preserves its pending data for review. |

Ticket 01 exercises the payload schemas and native-label metadata locally. Ticket 04 verifies these scenarios end to end with two simulated devices, request and acknowledgement loss, process restart, and restore. Tickets 05 and 06 cover installed iPhone behavior and private HTTPS validation.
