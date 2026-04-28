# Password Management

## How It Works

HCI uses a local user store at `~/.hermes/hci-users.json`.

- On first run, the UI prompts you to create the first admin account.
- Passwords are stored as bcrypt hashes in the user store.
- `HERMES_CONTROL_SECRET` in `.env` is still required for signing auth tokens and internal request verification.
- `HERMES_CONTROL_PASSWORD` is a legacy env var from the older single-password auth model and is no longer required for the current flow.

---

## First Run

1. Copy `.env.example` to `.env`
2. Set `HERMES_CONTROL_SECRET`
3. Start the server
4. Open the UI and create the first admin account

---

## Reset a User Password

Use the dashboard's user-management flow, or edit the user store with a trusted local maintenance path if you have to recover access.

If no users exist, the app returns to first-run setup and lets you create a new admin account.

---

## Security Notes

- Password hashes are one-way bcrypt hashes
- Keep `.env` permissions tight (`chmod 600 .env`)
- Never commit `.env` to git
- Rotating `HERMES_CONTROL_SECRET` invalidates existing sessions
