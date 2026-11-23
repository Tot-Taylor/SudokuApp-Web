# Install Sudoku on iPhone

Sudoku targets iOS 18 and later. Use Safari and the stable private HTTPS address configured for Sudoku on Tailscale. The same address identifies the installed app and its local data.

1. Connect the iPhone to Tailscale and open the Sudoku address in Safari.
2. Tap **Share → Add to Home Screen**. Enable **Open as Web App** if Safari shows that switch, then tap **Add**. [Apple’s Safari guide](https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios)
3. Open **Sudoku** from its new icon while connected. In **Settings**, wait for **Offline play is ready on this device**. Then go to Home and wait for **Synced** to download the current shared puzzle and stats. The installed app has separate website storage, so this first launch needs its own connection. [WebKit on Home Screen storage](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)

## Offline play and recovery

After an online launch has prepared the app files, the Home Screen app can reopen, continue a saved game, and generate new puzzles offline. Pending moves remain in IndexedDB and sync while Sudoku is open when the server becomes reachable. The status at Home and on the board shows pending saves and offers **Retry sync** when the connection fails.

If the device has no shared puzzle saved yet, it can start a puzzle offline. Connect to Tailscale to check the current shared game. If app files are missing, the offline page offers **Try again** after reconnection. The app requests persistent storage in standalone mode when the browser supports it. An origin can still be cleared or evicted, which can remove unsynced moves. Keep the app open on a reachable connection until it shows **Synced** before clearing website data or removing the app. [WebKit storage and eviction policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

## Updates and rollback

Publish the complete production build as one release. The worker installs a content-versioned copy of the HTML and its assets, including the puzzle-generation worker, before accepting control. It waits for open copies of the previous release to close. The app displays an update notice while a new release is waiting. Let any **Saving…** operation finish, close each open Sudoku window and Safari tab at this origin, and reopen it from the same Home Screen icon. Pending IndexedDB operations remain available even if the API is down. [Service-worker lifecycle](https://web.dev/articles/service-worker-lifecycle)

The worker caches only the release shell, compiled assets, and versioned PNG icons. API requests and sync responses go directly to the server. Activation removes older Sudoku shell caches only. The journal schema stays at version 1. When changing artwork, use a new versioned PNG name in the manifest, HTML, and build allowlist.

For a frontend rollback, serve the previous complete build at the same HTTPS origin, including its worker and hashed assets. Reopen on a reachable connection so the browser can install the previous worker, then close and reopen after it is ready. Keep the SQLite database and browser journal in place for compatible releases.

## Physical iPhone acceptance

Record the exact iPhone model, iOS version, and results when the private HTTPS address is ready.

- [ ] Add Sudoku through Safari. Confirm the Sudoku label and orange grid icon on the Home Screen. Launch it and verify the standalone view.
- [ ] Wait for offline readiness and sync. Start a puzzle, enter a digit, and confirm it appears on another device through the same private origin.
- [ ] Turn on Airplane Mode and verify Wi-Fi is off. Close the standalone app from the App Switcher and reopen it. Resume the puzzle, enter a digit, then close and reopen again. Confirm the digit and pending status remain. Start another puzzle offline and verify the generator works.
- [ ] Restore the network and Tailscale and bring Sudoku to the foreground. Wait for **Synced** and verify the latest puzzle on the second device.
- [ ] In portrait and landscape, check the full 9×9 grid, number pad, Eraser, dialogs, and safe areas. With VoiceOver, check cell names, selection, givens, and sync announcements. Verify external keyboard movement and erasing if a keyboard is available.
- [ ] With a second build available, create a pending move while the API is unavailable. Allow the new worker to download, then confirm its notice while the original game is still open. After saving the move locally, close all Sudoku windows and reopen from the same icon. Confirm the move survives activation and syncs after the API recovers.

The automated Chromium and iPhone-sized WebKit tests use localhost. Home Screen installation, standalone layout in iOS, and private Tailscale reachability require the physical-device check.
