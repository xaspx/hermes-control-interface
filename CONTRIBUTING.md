# Contributing to Hermes Control Interface

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/xaspx/hermes-control-interface.git
   cd hermes-control-interface
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the example config:
   ```bash
   cp .env.example .env
   # Edit .env with your HERMES_CONTROL_SECRET
   ```
5. Start the app for development:
   ```bash
   # Terminal 1
   npm start

   # Terminal 2
   npm run dev
   ```

## Requirements

- Node.js 20+
- npm
- A running Hermes Agent installation (optional — some panels show placeholder data without it)

## Code Style

- JavaScript (ES2022+), no TypeScript
- Single quotes, no semicolons (Prettier config coming soon)
- 2-space indentation
- Descriptive function names, short variable names are OK for locals
- Comments for "why", not "what"

## Project Structure

```
hermes-control-interface/
├── server.js          # Express server, PTY, WebSocket, APIs
├── auth.js            # Password + multi-user auth helpers
├── src/               # Vite frontend source
│   ├── index.html     # Dashboard HTML
│   ├── js/main.js     # Main client-side logic
│   ├── css/           # Theme, layout, components
│   └── assets/        # SVG/icons
├── dist/              # Built frontend served by Express
├── docs/              # Documentation
├── .env.example       # Config template
├── install.sh         # Interactive setup script
└── package.json
```

## Making Changes

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Test locally — login, terminal, file explorer, avatar upload, save file
4. Commit with a clear message:
   ```bash
   git commit -m "feat: add your feature description"
   ```
5. Push and open a Pull Request

## Commit Convention

Use prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `chore:` — tooling, config, dependencies

## Security

If you find a security vulnerability, **do not** open a public issue. Instead, email the maintainer directly.

## Testing

Run tests before submitting:
```bash
npm test
```

## Questions?

Open an issue with the `question` label. We're happy to help.
