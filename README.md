# SudokuApp-Web

An iPhone-first Sudoku web app based on the original [Swift app](https://github.com/Tot-Taylor/SudokuApp). The app synchronizes one shared puzzle and completion statistics through SQLite, with a durable browser journal for offline play.

## Development

Use Node.js 24 and npm in this checkout.

```sh
npm ci
npm run check
npm start
```

Open [the connected app](http://127.0.0.1:4173/). The Node server serves the built app and API together and creates `sudoku.sqlite` by default. `npm run dev` and `npm run preview` serve the frontend for standalone UI development. GitHub Actions runs lint, type checking, unit and database tests, a production build, and browser tests.

To run the desktop Chromium and narrow iPhone-sized WebKit tests:

```sh
npx playwright install --only-shell chromium webkit
npm run test:browser
```

The production build supports offline startup after the app files have been prepared online. [iPhone installation and verification](docs/iphone-pwa.md)

## Local backup and restore

Run the admin commands on the host with Node.js 24. Both commands create a new file at the supplied destination.

```sh
npm run admin -- backup sudoku.sqlite sudoku-backup.sqlite
npm run admin -- restore sudoku-backup.sqlite sudoku-restored.sqlite
```

The restore file receives a new sync history. To use it, stop the service, point `SUDOKU_DB` at the restored file, and start again. On reconnect, review any changes held from the previous history in the app. [Configuration and sync contract](docs/contracts.md)

## Project references

- [Completed steps and current decisions](AI%20Context/Completed%20steps.md)
- [Native parity inventory](docs/native-parity.md)
- [Game, API, and synchronization contracts](docs/contracts.md)
- [iPhone installation, offline play, and safe updates](docs/iphone-pwa.md)
- [Proxmox deployment, backup retention, and rollback](docs/proxmox-deployment.md)
- [Native parity fixtures](tests/fixtures/native-parity.json)

The implementation order is foundation, local Sudoku engine, mobile web interface, persistence and synchronization, iPhone PWA, and private deployment.
