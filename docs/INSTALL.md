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

## Run

```bash
npm start
```

Open `http://127.0.0.1:10272` in your browser.

On a clean install, the web UI prompts you to create the first admin account.

If you want to expose the app beyond localhost, put it behind a reverse proxy and TLS. Do not publish the raw port without a plan.
