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

- `HERMES_CONTROL_PASSWORD`
- `HERMES_CONTROL_SECRET`
- `PORT` if you want a different port
- `HERMES_CONTROL_HOME` if your Hermes state lives somewhere else
- `HERMES_PROJECTS_ROOT` if your repos live outside the parent directory of this repo

## Run

```bash
npm start
```

Open `http://127.0.0.1:10272` in your browser.

If you want to expose the app beyond localhost, put it behind a reverse proxy and TLS. Do not publish the raw port without a plan.

## Environment Variables

After copying `.env.example` to `.env`, the **required** variables are:

- `HERMES_CONTROL_PASSWORD` — Login password (generate with `openssl rand -hex 32`)
- `HERMES_CONTROL_SECRET` — HMAC secret for auth tokens (generate with `openssl rand -hex 32`)

**Optional** (have sensible defaults):

- `GATEWAY_API_KEY` — Gateway API auth key. Default: reads from `~/.hermes/config.yaml`. Only set if your key differs.
- `HCI_CORS_ORIGINS` — Comma-separated CORS origins for production. Default: auto-detects from request, falls back to localhost. Set for production: `HCI_CORS_ORIGINS=https://your-domain.com`
- `PORT` — Server listen port. Default: `10272`
- `HERMES_CONTROL_HOME` — Hermes root directory. Default: `~/.hermes`
- `HERMES_PROJECTS_ROOT` — Projects explorer root. Default: parent directory of repo
