# mom-email

An email assistant powered by Claude. Receives email via Mailgun webhooks, processes messages that contain a trigger phrase, and replies using an LLM agent with full tool access.

Fork of [badlogic/pi-mono mom](https://github.com/badlogic/pi-mono) — converted from Slack to email.

## Features

- **Email-Based**: Receives and replies via Mailgun webhooks. No Slack required
- **Trigger Phrase**: Only processes emails containing a configurable phrase (default: `@Claude`)
- **Full Tool Access**: Agent can run bash commands, read/write/edit files, and attach files to replies
- **Docker Sandbox**: Isolate the agent in an Alpine container (recommended)
- **Persistent Workspace**: Memory, email archive, skills, and events stored in one directory
- **Self-Managing**: Agent installs its own tools, writes scripts, configures credentials
- **Events System**: Schedule reminders and periodic tasks via JSON files
- **Skills**: Agent creates reusable CLI tools for recurring workflows

## Quick Start

```bash
# Install dependencies
npm install

# Build
npx tsc -p tsconfig.build.json

# Configure environment
cp .env.example .env  # then edit with your values

# Create workspace directory
mkdir -p ./data

# Option A: Run on host (simple, less secure)
node dist/main.js ./data

# Option B: Run in Docker sandbox (recommended)
./docker.sh create ./data
node dist/main.js --sandbox=docker:mom-sandbox ./data
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `MAILGUN_API_KEY` | Yes | Mailgun API key |
| `MAILGUN_DOMAIN` | Yes | Mailgun sending domain (e.g., `mg.example.com`) |
| `MAILGUN_FROM_ADDRESS` | Yes | From address for replies (e.g., `assistant@mg.example.com`) |
| `MAILGUN_SIGNING_KEY` | No | Mailgun webhook signing key for signature verification |
| `WEBHOOK_PORT` | No | Port for webhook server (default: `3000`) |
| `TRIGGER_PHRASE` | No | Phrase that activates the agent (default: `@Claude`) |

## CLI Options

```bash
node dist/main.js [options] <working-directory>

Options:
  --sandbox=host              Run tools on host (default)
  --sandbox=docker:<name>     Run tools in Docker container (recommended)
```

## How It Works

1. Mailgun delivers incoming email to the webhook endpoint (`POST /webhook/mailgun`)
2. The email is stored in the workspace's email archive
3. If the email body contains the trigger phrase, it's queued for processing
4. The agent runs with the email as context, plus the last 50 emails for history
5. The agent's final text response is sent back as an email reply via Mailgun
6. Reply is threaded using `In-Reply-To` and `References` headers

### Processing Queue

Emails are processed sequentially, one at a time. Up to 10 emails can be queued. Additional emails are stored but not processed until queue space opens.

### Trigger Detection

The trigger phrase is matched against the **stripped text** only (not quoted replies), so forwarding a conversation that happens to mention `@Claude` won't accidentally trigger the agent.

## Docker Sandbox

The Docker sandbox runs agent bash commands inside an Alpine Linux container, isolating them from your host.

```bash
# Manage the container
./docker.sh create ./data   # Create and start
./docker.sh status           # Check if running
./docker.sh shell            # Open a shell inside
./docker.sh stop             # Stop
./docker.sh start            # Restart
./docker.sh remove           # Delete
```

Inside the container, the workspace is mounted at `/workspace`. The agent knows it's in Alpine and will use `apk add` to install packages.

## Workspace Layout

```
./data/
├── MEMORY.md                # Persistent memory across sessions
├── settings.json            # Configuration
├── skills/                  # Custom CLI tools the agent creates
├── events/                  # Scheduled event JSON files
├── scratch/                 # Agent working directory
├── sessions/                # Per-email session logs and debug artifacts
└── emails/
    ├── inbox/               # Stored emails as JSON
    ├── attachments/         # Email attachments
    └── index.jsonl          # Email index for search
```

## Memory

The agent reads `MEMORY.md` from the workspace before each run. It persists preferences, project info, contact details, and anything you ask it to remember.

Each run is a fresh session — the agent has no memory of previous runs except through `MEMORY.md` and the email archive.

## Skills

The agent can create reusable CLI tools stored in `skills/`. Each skill has a `SKILL.md` file with frontmatter describing what it does, plus any scripts or programs.

```markdown
---
name: skill-name
description: Short description
---

# Skill Name

Usage instructions...
```

## Events

Schedule wake-ups via JSON files in `events/`.

| Type | Triggers | Example |
|------|----------|---------|
| **Immediate** | As soon as file is created | `{"type": "immediate", "text": "New activity"}` |
| **One-shot** | At a specific time, once | `{"type": "one-shot", "text": "Reminder", "at": "2025-12-15T09:00:00+01:00"}` |
| **Periodic** | On a cron schedule | `{"type": "periodic", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "America/New_York"}` |

For periodic events with nothing to report, the agent responds with `[SILENT]` to suppress the reply email.

## Security

The agent has full bash access within its execution environment. Use Docker sandbox mode to limit blast radius.

**Docker mode**: Agent can only access the mounted workspace directory from the host. Everything else is isolated in the container.

**Host mode**: Agent has full access to your machine with your user permissions. Only use this in disposable environments.

Treat the agent like a junior developer with full terminal access. Don't give it production credentials.

## Code Structure

- `src/main.ts` — Entry point, CLI parsing, webhook handler, queue setup
- `src/agent.ts` — Agent runner, system prompt, session management
- `src/email-server.ts` — HTTP webhook server, Mailgun signature verification
- `src/email-store.ts` — Email persistence (inbox JSON files, index)
- `src/mailgun.ts` — Mailgun API client (send email, validate credentials)
- `src/queue.ts` — Sequential processing queue with overflow protection
- `src/events.ts` — Events watcher (immediate, one-shot, periodic)
- `src/sandbox.ts` — Docker/host executor abstraction
- `src/context.ts` — Settings manager (unused, kept for future self-tuning)
- `src/tools/` — Tool implementations (bash, read, write, edit, attach)

## Development

```bash
# Build
npx tsc -p tsconfig.build.json

# Run with auto-rebuild (dev mode)
npx tsc -p tsconfig.build.json --watch &
node dist/main.js ./data
```

## License

MIT
