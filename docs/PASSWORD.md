# Password Management

## Current Auth Model

The current HCI auth flow stores dashboard users in `~/.hermes/hci-users.json`.

On first run, the UI prompts you to create the first admin account. Passwords are stored as bcrypt hashes in that user store.

`HERMES_CONTROL_SECRET` in `.env` is still required for signing auth tokens and internal request verification.

`HERMES_CONTROL_PASSWORD` is a legacy env var from the pre-user-store auth model and is no longer used by the current multi-user flow.

---

## Reset Password

### Option 1 — Interactive (asks for username and password)
```bash
cd hermes-control-interface
bash reset-password.sh
```

### Option 2 — Direct
```bash
bash reset-password.sh username "my-new-password"
```

### Option 3 — Via npm
```bash
npm run reset-password -- username "my-new-password"
```

### What happens:
1. You choose a target username
2. The new password is hashed with bcrypt (10 rounds)
3. The matching user's `password_hash` is updated in `~/.hermes/hci-users.json`
4. Existing sessions continue until logout or secret rotation

### After reset:
```bash
# If running directly
npm start

# If using systemd
sudo systemctl restart hermes-control
```

---

## Check Current Users

```bash
cat ~/.hermes/hci-users.json
```

---

## Security Notes

- The bcrypt hash is **one-way** — you cannot recover the plaintext from it
- If you forget your password, you MUST reset it (there's no recovery)
- Keep your `.env` file permissions at `600` (`chmod 600 .env`)
- Never commit `.env` to git (it's in `.gitignore` by default)
- `HERMES_CONTROL_SECRET` is separate — it's used for auth token signing, not password comparison
