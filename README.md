# Codex Report Server

Local Codex usage dashboard for a Mac running Codex. It reads local Codex usage history from SQLite and fetches official quota percentages through the local Codex `app-server` RPC.

The UI is optimized for e-ink displays: black-and-white styling, stable layout, no decorative gradients, and low-frequency polling.

## Features

- Official 5-hour and weekly remaining quota percentages from Codex RPC.
- Local total, today, weekly, monthly, project, model, and recent-session usage summaries.
- 30-day token trend chart.
- E-ink friendly responsive UI.
- LAN access for tablets or e-ink browsers.
- Frontend polling every 60 seconds without full page reloads.
- Display output avoids exposing local database names or absolute home-directory paths.

## Requirements

- macOS or Linux with Node.js 20+
- Codex CLI available on `PATH`
- Authenticated Codex account
- `sqlite3` CLI available on `PATH`

## Run

```sh
npm start
```

Default URLs:

- Local: `http://127.0.0.1:4321`
- LAN: the server prints available `http://<lan-ip>:4321` addresses on startup

To keep the dashboard local-only:

```sh
HOST=127.0.0.1 npm start
```

## Configuration

Environment variables:

- `PORT`: HTTP port, defaults to `4321`
- `HOST`: bind host, defaults to `0.0.0.0`
- `CODEX_HOME`: Codex home directory, defaults to `~/.codex`
- `CODEX_STATE_DB`: explicit Codex SQLite state path, defaults to `$CODEX_HOME/state_5.sqlite`
- `CODEX_RPC_TIMEOUT_MS`: Codex quota RPC timeout, defaults to `10000`

See [.env.example](./.env.example).

## How Quota Is Read

The server starts the local Codex app server:

```txt
codex -s read-only -a untrusted app-server
```

It then calls JSON-RPC methods:

- `initialize`
- `account/rateLimits/read`
- `account/read`

The frontend displays `100 - usedPercent` for the 5-hour and weekly windows.

## Privacy Notes

This app is meant for local or trusted LAN use. It does not send usage data to third-party services, but anyone who can reach the server can view the dashboard. Keep `HOST=127.0.0.1` if you do not want LAN access.

The API response is sanitized for display-oriented fields, but it still reflects your local Codex usage. Do not expose it publicly.

## License

MIT
