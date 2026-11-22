# Deploy SudokuApp-Web on Proxmox

Sudoku targets a dedicated unprivileged **CT 103** on **pve2**. The proposed starting size is Debian 13 amd64, 1 vCPU, 1 GiB RAM, 8 GiB disk, and DHCP on `vmbr0`. These values follow the Fry-By deployment pattern. Verify current capacity, guest IDs, storage, and networking before provisioning. The host connection, CT changes, and deployment require separate owner authorization.

## Read-only preflight

Run this on the authorized `pve2` host, using the Proxmox shell or a verified SSH connection. Record the relevant results in the handoff.

```sh
hostname -s
pveversion
uname -m
pvesh get /cluster/resources --type vm
pct list
pct status 102
pvesm status
pvesm list local --content vztmpl
free -h
ls -l /dev/net/tun
ip -brief address
ip -4 route show
```

- Confirm `pve2` is the intended node and check CT and VM IDs across the cluster. If ID 103 is occupied, stop and report the occupant.
- Confirm the Debian 13 template matches the host architecture, the selected storage accepts container volumes, and the bridge and IP plan match the owner's network. Record the baseline state of Fry-By CT 102.
- Confirm the new machine name and the owner devices that may reach it. Check the tailnet's existing HTTPS and access policy before proposing policy changes. Choose an approved off-guest backup destination and verify space and access to it. [Proxmox administration guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf) · [Tailscale grants](https://tailscale.com/docs/features/access-control/grants)

## Provision the approved guest

After provisioning authorization, recheck that ID 103 is free. Set `CT_TEMPLATE`, `CT_STORAGE`, and `CT_BRIDGE` to the values verified in preflight. Run these commands on `pve2`.

```sh
test "$(hostname -s)" = pve2 || exit 1
: "${CT_TEMPLATE:?Select the verified template}" "${CT_STORAGE:?Select container storage}" "${CT_BRIDGE:?Select the bridge}"
pct create 103 "$CT_TEMPLATE" --hostname sudokuapp-web --unprivileged 1 \
  --cores 1 --memory 1024 --rootfs "$CT_STORAGE:8" \
  --net0 "name=eth0,bridge=$CT_BRIDGE,ip=dhcp,type=veth" --onboot 1
pct set 103 --dev0 /dev/net/tun
pct set 103 --features keyctl=1,nesting=1
pct start 103
pct exec 103 -- dpkg --print-architecture
pct exec 103 -- test -c /dev/net/tun
```

Inside CT 103, verify outbound DNS, package repository access, and correct time. Install `ca-certificates`, `curl`, and `rsync`, plus the verified Node.js 24 distribution and npm. The units use `/usr/local/bin/node`. Confirm that path runs the installed Node 24 patch. Install Tailscale from its official Debian repository. [Tailscale LXC instructions](https://tailscale.com/docs/features/containers/lxc/lxc-unprivileged) · [Node.js downloads and verification](https://nodejs.org/en/download) · [Tailscale on Linux](https://tailscale.com/docs/install/linux)

## Build and stage a reviewed release

From a clean checkout of the reviewed commit, use Node.js 24 and the lockfile. Install the Playwright browser binaries for your platform before running browser tests.

```sh
npm ci
npm run check
npx playwright test
release_id="$(git rev-parse --short=12 HEAD)"
npm run release -- "$release_id"
```

The builder writes a tarball and a SHA-256 sidecar under `releases/<release-id>/`. Record the full commit and displayed digest. The archive contains the production PWA, server, dependency manifests, and units. The `--local-check` option creates a rehearsal archive with `deployable: false`. A deployable archive records the reviewed commit and requires a clean checkout.

Transfer the archive and sidecar by the authorized route. For SSH, stage on the Proxmox host and use `pct push 103`, or transfer directly if CT 103 already has an authorized SSH service. The authenticated Proxmox ISO upload is an alternative when approved. Verify the SHA-256 against the builder output after transfer, including inside CT 103.

In CT 103 as root, create the account and directories on first install.

```sh
useradd --system --user-group --home-dir /var/lib/sudokuapp-web --shell /usr/sbin/nologin sudokuapp-web
install -d -o root -g root -m 0755 /opt/sudokuapp-web/releases
install -d -o root -g root -m 0700 /etc/sudokuapp-web
install -d -o sudokuapp-web -g sudokuapp-web -m 0700 /var/lib/sudokuapp-web /var/backups/sudokuapp-web
```

Set `release_id` and `source_commit` to the reviewed values before staging. Run this in the directory containing the transferred tarball and sidecar.

```sh
: "${release_id:?Set the reviewed release ID}" "${source_commit:?Set the reviewed commit}"
archive="sudokuapp-web-$release_id.tar.gz"
sha256sum -c "$archive.sha256" || exit 1
# Compare the sidecar digest with the independently recorded digest before extraction.
stage="$(mktemp -d /var/tmp/sudoku-release.XXXXXX)"
target="/opt/sudokuapp-web/releases/$release_id"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$stage" || exit 1

node -e '
const fs = require("node:fs");
const [file, id, commit] = process.argv.slice(1);
const release = JSON.parse(fs.readFileSync(file, "utf8"));
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
    !/^[a-f0-9]{40}$/.test(commit) || release.releaseId !== id ||
    release.sourceCommit !== commit || release.deployable !== true) process.exit(1);
' "$stage/release.json" "$release_id" "$source_commit" || exit 1

chown -R sudokuapp-web:sudokuapp-web "$stage"
(cd "$stage" && runuser -u sudokuapp-web -- npm ci --omit=dev --ignore-scripts) || exit 1
mkdir -- "$target" || exit 1
rsync -a --chown=root:root --chmod=D755,F644 "$stage/" "$target/" || exit 1
```

Keep the release directory immutable after staging. If staging fails before activation, diagnose the candidate and retry under a fresh release ID.

## Configure private access and start the app

Enroll CT 103 with its own Tailscale identity. Apply only the approved access policy for Sudoku. The access boundary is the effective tailnet policy, since Sudoku shares one profile and uses no in-app login. Confirm that broad grants do not include unrelated users or devices. Tailscale HTTPS makes the certificate hostname visible through certificate transparency, so use a machine name suitable for that record. [Enabling Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates) · [Tailscale Serve and access rules](https://tailscale.com/docs/features/tailscale-serve)

Install the environment and units on first install. Set `SUDOKU_ORIGIN` to the approved exact HTTPS origin, `SUDOKU_PORT` to the loopback port, and `SUDOKU_DB` to the persistent file. Keep the root-owned environment file outside releases.

```sh
install -m 0600 "$target/deploy/server.env.example" /etc/sudokuapp-web/server.env
editor /etc/sudokuapp-web/server.env
install -m 0644 "$target"/deploy/sudokuapp-web*.service "$target"/deploy/sudokuapp-web-backup.timer /etc/systemd/system/
ln -sT "$target" /opt/sudokuapp-web/current
systemd-analyze verify /etc/systemd/system/sudokuapp-web.service \
  /etc/systemd/system/sudokuapp-web-backup.service /etc/systemd/system/sudokuapp-web-backup.timer
systemctl daemon-reload
systemctl enable --now sudokuapp-web.service
curl --fail --silent --show-error --retry 6 --retry-connrefused --max-time 3 http://127.0.0.1:4174/healthz
ss -ltn
```

When loopback is healthy, configure HTTPS Serve in CT 103. If its chosen port differs, use that port in all commands.

```sh
tailscale serve --bg http://127.0.0.1:4174
tailscale serve status
tailscale funnel status
```

Confirm the printed HTTPS origin matches `SUDOKU_ORIGIN`, the Node listener is loopback-only, and Serve reports tailnet-only access. Verify reachability from an allowed device and denial from a device outside the tailnet and any excluded tailnet device available for testing. Check `/healthz`, the app, manifest, worker, and Firefox/Chromium or Safari as appropriate. Run the [iPhone acceptance checks](iphone-pwa.md#physical-iphone-acceptance) once the HTTPS origin is available. Reboot only CT 103 and repeat health, access, and persistence checks. Compare Fry-By service health to the preflight baseline.

## Daily backups and restore drill

Start one manual run and verify its result before enabling the timer.

```sh
systemctl start sudokuapp-web-backup.service
journalctl -u sudokuapp-web-backup.service -n 20 --no-pager
systemctl enable --now sudokuapp-web-backup.timer
systemctl list-timers sudokuapp-web-backup.timer
```

The timer runs at 08:30 UTC and catches up after downtime. The backup uses SQLite's online snapshot API, verifies the published file, and keeps the newest 30 successful daily snapshots. It leaves manual and pre-update snapshots available for operator-managed recovery. Work with the owner to copy completed snapshots to the approved private off-guest destination and apply its retention. Verify at least one off-guest copy by restoring it. [systemd timer behavior](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

For a restore drill, create a separate writable directory owned by `sudokuapp-web`. Using an approved backup path, restore to a new file there and verify it. Launch the staged release on another loopback port such as 4175 with `SUDOKU_ORIGIN=http://127.0.0.1:4175` and `SUDOKU_DB` pointing to the new file. Keep this instance private. Check the active puzzle and completion stats before and after restore and confirm the new history. Use a client with queued edits from the old history to verify it holds them for review. Record the restore duration.

```sh
runuser -u sudokuapp-web -- /usr/local/bin/node /opt/sudokuapp-web/current/server/admin.ts restore "$backup" "$restored"
runuser -u sudokuapp-web -- /usr/local/bin/node /opt/sudokuapp-web/current/server/admin.ts verify "$restored"
```

## Update and rollback

1. Stage the reviewed archive separately and record the current link with `readlink -f /opt/sudokuapp-web/current`. Take a manual SQLite backup with the old release, then test the candidate on a restored copy on port 4175. Confirm the build serves all assets and reads the expected active puzzle and completion totals.
2. In the authorized maintenance window, stop the backup timer and let any backup in progress finish. Stop `sudokuapp-web.service`. Take and verify a final pre-update snapshot with the old release's `server/admin.ts`. If backup fails, bring the recorded release back online before retrying the cutover.
3. Switch the link using an atomic rename, then start the service and check loopback, private HTTPS and sync. After verification, restart the daily timer.

   ```sh
   ln -sT "$target" /opt/sudokuapp-web/current.next &&
     mv -Tf /opt/sudokuapp-web/current.next /opt/sudokuapp-web/current &&
     systemctl start sudokuapp-web.service
   curl --fail --silent --show-error --retry 6 --retry-connrefused --max-time 3 http://127.0.0.1:4174/healthz
   ```

4. For a failed cutover with a compatible database, stop the service, repeat the link switch with the recorded previous release, and start it against the same database. Use `systemctl reset-failed sudokuapp-web.service` if the start limit was reached. Repeat loopback and HTTPS checks.
5. If a migration makes the database incompatible with the previous release, preserve the failed database and journal files. Confirm the recovery point with the owner. Restore the final pre-update snapshot to a new file, update `SUDOKU_DB` in the private environment file, and restart the previous release. Changes accepted after the snapshot may need recovery. The restored history holds old offline writes for review.

Keep the same HTTPS origin across releases so the installed app retains its IndexedDB data. After local saves finish, close all Sudoku windows and reopen the same Home Screen icon for the waiting release. The [iPhone update and rollback guide](iphone-pwa.md#updates-and-rollback) covers the worker lifecycle.

## Diagnose an incident

Check the guest console, `systemctl status sudokuapp-web.service`, `journalctl -u sudokuapp-web.service`, `ss -ltn`, loopback `/healthz`, and `tailscale serve status`. Investigate database readiness separately from Tailscale reachability. If a Tailscale node key expires or is revoked, use the Proxmox console as the alternate access path to reauthenticate CT 103. Keep enrollment keys and tailscaled state out of the app config and build artifacts. Record the issue, restore point, actions, and verification results. [Tailscale key expiry](https://tailscale.com/docs/features/access-control/key-expiry)
