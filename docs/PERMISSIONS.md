# HCI Permission System v2 (28 permissions)

## Permission Matrix

| # | Group | Permission | Action | Description | Admin | Viewer |
|---|-------|-----------|--------|-------------|-------|--------|
| **SESSIONS** | | | | | | |
| 1 | | `sessions.view` | View | Lihat daftar sessions | ✅ | ✅ |
| 2 | | `sessions.messages` | View | Baca isi pesan session | ✅ | ✅ |
| 3 | | `sessions.delete` | Delete | Hapus session | ✅ | — |
| **CHAT** | | | | | | |
| 4 | | `chat.use` | Execute | Kirim pesan ke agent | ✅ | ✅ |
| 5 | | `chat.manage` | Execute | New chat, resume, delete session dari chat | ✅ | — |
| **LOGS** | | | | | | |
| 6 | | `logs.view` | View | Lihat logs | ✅ | ✅ |
| **USAGE** | | | | | | |
| 7 | | `usage.view` | View | Lihat token usage & costs | ✅ | ✅ |
| 8 | | `usage.export` | Execute | Export usage data (CSV/JSON) | ✅ | — |
| **GATEWAY** | | | | | | |
| 9 | | `gateway.view` | View | Lihat status gateway | ✅ | ✅ |
| 10 | | `gateway.control` | Execute | Start/stop/restart gateway | ✅ | — |
| **CONFIG** | | | | | | |
| 11 | | `config.view` | View | Lihat config.yaml | ✅ | — |
| 12 | | `config.edit` | Edit | Edit config.yaml | ✅ | — |
| **SECRETS** | | | | | | |
| 13 | | `secrets.view` | View | Lihat daftar keys (masked) | ✅ | — |
| 14 | | `secrets.reveal` | View | Reveal value key (unmask) | ✅ | — |
| 15 | | `secrets.edit` | Edit | Tambah/edit/hapus keys | ✅ | — |
| **SKILLS** | | | | | | |
| 16 | | `skills.browse` | View | Browse & search skills | ✅ | ✅ |
| 17 | | `skills.install` | Execute | Install/uninstall skills | ✅ | — |
| **CRON** | | | | | | |
| 18 | | `cron.view` | View | Lihat daftar cron jobs | ✅ | ✅ |
| 19 | | `cron.manage` | Edit | Create/edit/delete/pause/resume cron | ✅ | — |
| **FILES** | | | | | | |
| 20 | | `files.read` | View | Browse & baca files | ✅ | ✅ |
| 21 | | `files.write` | Edit | Upload/edit/delete files | ✅ | — |
| **TERMINAL** | | | | | | |
| 22 | | `terminal` | Execute | Akses web terminal | ✅ | — |
| **USERS** | | | | | | |
| 23 | | `users.view` | View | Lihat daftar users | ✅ | — |
| 24 | | `users.manage` | Edit | Create/edit/delete users | ✅ | — |
| **SYSTEM** | | | | | | |
| 25 | | `system.update` | Execute | Update HCI & Hermes | ✅ | — |
| 26 | | `system.backup` | Execute | Create/import backup | ✅ | — |
| 27 | | `system.doctor` | Execute | Run diagnostics & auto-fix | ✅ | — |
| 28 | | `system.restart` | Execute | Restart HCI server | ✅ | — |

## Permission Groups (for UI)

```
📋 Sessions (3): view, messages, delete
💬 Chat (2): use, manage
📊 Logs & Usage (3): logs.view, usage.view, usage.export
🔌 Gateway (2): view, control
⚙️ Config (2): view, edit
🔑 Secrets (3): view, reveal, edit
🧩 Skills (2): browse, install
⏰ Cron (2): view, manage
📁 Files (2): read, write
💻 Terminal (1): access
👥 Users (2): view, manage
🛠️ System (4): update, backup, doctor, restart
```

## Presets

- **Admin**: 28/28 (all)
- **Viewer**: 7/28 (sessions.view, sessions.messages, chat.use, logs.view, usage.view, skills.browse, files.read)
- **Custom**: Pick dari 28

## Migration from v1 (20 → 28)

### New permissions:
- `sessions.delete` (split from sessions)
- `chat.use` (new)
- `chat.manage` (new)
- `gateway.view` (split from gateway.control)
- `config.view` (split from config.edit)
- `usage.export` (new)
- `users.view` (split from users.manage)
- `system.restart` (new)

### Renamed:
- `hci.update` → `system.update`
- `backup` → `system.backup`
- `doctor` → `system.doctor`

### Removed (replaced):
- `hci.update` → `system.update`
- `backup` → `system.backup`
- `doctor` → `system.doctor`
