# Password Management

## How It Works

HCI stores the dashboard password in `.env` as `HERMES_CONTROL_PASSWORD`.

The password can be stored in two formats:

### Bcrypt Hashed (Recommended)
```
HERMES_CONTROL_PASSWORD=$2b$10...y...
```
- Starts with `$2b$` or `$2a$`
- Compared using `bcrypt.compareSync()` — timing-safe, irreversible
- If `.env` leaks, attacker cannot recover the password

### Plaintext
```
HERMES_CONTROL_PASSWORD=mysecr...d123
```
- Compared using `crypto.timingSafeEqual()` — timing-safe but reversible
- If `.env` leaks, attacker can read the password directly

The server auto-detects which format is used on login.

---

## Generate a Secure Password

Generate a bcrypt-hashed password with Node.js:
```bash
node -e "const bcrypt=require('bcrypt'); bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10).then(h=>console.log('HERMES_CONTROL_PASSWORD='+h))"
```

---

## Reset Password

1. Edit `.env` and set a new value for `HERMES_CONTROL_PASSWORD`
2. If using bcrypt format, regenerate the hash using the command above
3. Restart the server:
```bash
# Direct
npm start

# Systemd
sudo systemctl restart hermes-control
```

---

## Check Current Password Format

```bash
grep HERMES_CONTROL_PASSWORD .env
```

- Starts with `$2b$` or `$2a$` → bcrypt hashed (secure)
- Anything else → plaintext (edit `.env` to set a new bcrypt-hashed value)

---

## Security Notes

- The bcrypt hash is **one-way** — you cannot recover the plaintext from it
- If you forget your password, you MUST reset it (there's no recovery)
- Keep your `.env` file permissions at `600` (`chmod 600 .env`)
- Never commit `.env` to git (it's in `.gitignore` by default)
- `HERMES_CONTROL_SECRET` is separate — it's used for auth token signing, not password comparison
