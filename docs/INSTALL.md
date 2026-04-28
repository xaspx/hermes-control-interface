# Installation

## Requirements

- Node.js 20 or newer
- npm
- A working Hermes installation on the same machine
- `hermes` available on PATH

## Install

```bash
git clone https://github.com/xaspx/hermes-control-interface.git hermes-control-interface
cd hermes-control-interface
cp .env.example .env
npm install
```

## Configure

Edit `.env` and set:

- `HERMES_CONTROL_SECRET`
- `PORT` if you want a different port
- `HERMES_CONTROL_HOME` if your Hermes state lives somewhere else
- `HERMES_PROJECTS_ROOT` if your repos live outside the parent directory of this repo

`HERMES_CONTROL_PASSWORD` is legacy and not required for the current first-run multi-user auth flow.

## Run

```bash
npm start
```

Open `http://127.0.0.1:10272` in your browser.

On a clean install, the UI will prompt you to create the first admin account.

If you want to expose the app beyond localhost, put it behind a reverse proxy and TLS. Do not publish the raw port without a plan.

## Environment Variables

After copying `.env.example` to `.env`, the **required** variable is:

- `HERMES_CONTROL_SECRET` — HMAC secret for auth tokens (generate with `openssl rand -hex 32`)

**Optional** (have sensible defaults):

- `HERMES_CONTROL_PASSWORD` — legacy single-password auth variable; not required for the current flow
- `GATEWAY_API_KEY` — Gateway API auth key. Default: reads from `~/.hermes/config.yaml`. Only set if your key differs.
- `HCI_CORS_ORIGINS` — Comma-separated CORS origins for production. Default: auto-detects from request, falls back to localhost. Set for production: `HCI_CORS_ORIGINS=https://your-domain.com`
- `PORT` — Server listen port. Default: `10272`
- `HERMES_CONTROL_HOME` — Hermes root directory. Default: `~/.hermes`
- `HERMES_PROJECTS_ROOT` — Projects explorer root. Default: parent directory of repo
