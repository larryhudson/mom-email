# Manual Testing Plan

## Setup

### 1. Build the project

```bash
cd /Users/larryhudson/github.com/larryhudson/mom-email
npm install
npx tsc -p tsconfig.build.json && chmod +x dist/main.js
```

### 2. Get your Mailgun credentials

You need three things from the Mailgun dashboard:

**API Key** (for sending emails):
1. Go to https://app.mailgun.com/settings/api_security
2. Copy your **Private API key** (starts with `key-...` or a long hex string)

**Sending Domain**:
1. Go to https://app.mailgun.com/sending/domains
2. Note your verified domain (e.g., `mail.yourdomain.com`)

**Webhook Signing Key** (for verifying inbound webhooks -- optional for local testing):
1. Go to https://app.mailgun.com/settings/api_security
2. Scroll to **HTTP Webhook Signing Key** and copy it

**From Address**: Pick a from address on your verified domain, e.g., `Claude <claude@mail.yourdomain.com>`

### 3. Create your `.env` file

The `.env` file is already gitignored. Create it in the project root:

```bash
cat > .env << 'EOF'
MAILGUN_API_KEY=key-your-private-api-key-here
MAILGUN_DOMAIN=mail.yourdomain.com
MAILGUN_FROM_ADDRESS=Claude <claude@mail.yourdomain.com>
MAILGUN_SIGNING_KEY=your-webhook-signing-key-here
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here
WEBHOOK_PORT=3000
TRIGGER_PHRASE=@Claude
EOF
```

### 4. Load the `.env` file before running

The app doesn't read `.env` files automatically. Source it before each session:

```bash
set -a && source .env && set +a
```

Or add a helper to your shell:

```bash
alias mom-env='set -a && source /Users/larryhudson/github.com/larryhudson/mom-email/.env && set +a'
```

### 5. Create a test working directory

```bash
mkdir -p /tmp/mom-test
```

### 6. Verify your setup

Quick check that everything is loaded:

```bash
echo "API Key: ${MAILGUN_API_KEY:0:8}..."
echo "Domain: $MAILGUN_DOMAIN"
echo "From: $MAILGUN_FROM_ADDRESS"
echo "Anthropic: ${ANTHROPIC_API_KEY:0:10}..."
```

You should see the first few characters of each key (not blank lines).

---

## Phase 1: Startup and Config Validation

These tests verify the process starts correctly and rejects bad config.

### 1.1 Missing working directory

```bash
node dist/main.js
```

**Expected**: Prints usage message and exits with code 1.

### 1.2 Missing Mailgun env vars

```bash
unset MAILGUN_API_KEY
node dist/main.js /tmp/mom-test
```

**Expected**: Prints "Missing env: MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_ADDRESS" and exits with code 1.

### 1.3 Successful startup

```bash
# With all env vars set:
node dist/main.js /tmp/mom-test
```

**Expected output** (approximately):
```
Starting mom email assistant...
  Working directory: /tmp/mom-test
  Sandbox: host
[HH:MM:SS] [system] Events watcher starting, dir: /tmp/mom-test/events
[HH:MM:SS] [system] Events watcher started, tracking 0 files
[HH:MM:SS] [system] Webhook server listening on port 3000
Email assistant running and listening for webhooks!
```

**Also verify**: The directory structure was created:
```bash
ls -la /tmp/mom-test/emails/inbox/
ls -la /tmp/mom-test/emails/attachments/
ls -la /tmp/mom-test/events/
```

### 1.4 Custom port

```bash
WEBHOOK_PORT=8080 node dist/main.js /tmp/mom-test
```

**Expected**: Log says "listening on port 8080".

### 1.5 Ctrl+C shutdown

Start the server, then press Ctrl+C.

**Expected**: Prints "[system] Shutting down..." and exits cleanly (code 0).

---

## Phase 2: Webhook Server (email-server.ts)

Test the HTTP server independently with curl. The server must be running for these tests.

### 2.1 Wrong method/path

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/webhook/mailgun
curl -s -o /dev/null -w "%{http_code}" -X GET http://localhost:3000/webhook/mailgun
```

**Expected**: All return `404`.

Note: The second curl (GET to the right path) should also be 404 since the server only accepts POST.

### 2.2 Minimal valid webhook (no trigger)

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=alice@example.com&from=Alice+<alice@example.com>&subject=Hello&body-plain=Just+saying+hi&stripped-text=Just+saying+hi&Message-Id=<test001@example.com>&Date=2026-02-28T10:00:00Z"
```

**Expected**:
- HTTP response: `OK` with status `200`
- Server logs: `[email] Received from Alice <alice@example.com>: Hello`
- Server logs: `Email stored (no trigger): ...`

**Verify storage**:
```bash
cat /tmp/mom-test/emails/inbox/*.json | head -50
cat /tmp/mom-test/emails/index.jsonl
```

Should see one JSON file with `"triggered": false` and one index entry.

### 2.3 Webhook with trigger phrase

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=bob@example.com&from=Bob+<bob@example.com>&subject=Question&body-plain=Hey+@Claude+what+time+is+it?&stripped-text=Hey+@Claude+what+time+is+it?&Message-Id=<test002@example.com>&Date=2026-02-28T10:05:00Z"
```

**Expected**:
- HTTP `200` immediately
- Server logs: `Trigger phrase "@Claude" detected in email from Bob <bob@example.com>`
- Server logs: `Enqueued email ... for processing`
- Agent starts processing (tool execution logs appear)
- Eventually: `Reply sent to bob@example.com: Re: Question` (if Mailgun creds are real) OR a Mailgun API error if creds are fake

### 2.4 Trigger in quoted reply should NOT trigger

This simulates Mailgun's `stripped-text` removing quoted content. The trigger only appears in `body-plain` (the full body with quoted replies), not in `stripped-text`.

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=carol@example.com&from=Carol+<carol@example.com>&subject=Re:+Question&body-plain=Thanks+for+the+info.%0A%0AOn+Feb+28+Bob+wrote:%0A>+Hey+@Claude+what+time+is+it?&stripped-text=Thanks+for+the+info.&Message-Id=<test003@example.com>&In-Reply-To=<test002@example.com>&Date=2026-02-28T10:10:00Z"
```

**Expected**:
- HTTP `200`
- Server logs: `Email stored (no trigger)`
- The email is saved but NOT enqueued for processing

### 2.5 Case-insensitive trigger

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=dave@example.com&from=Dave+<dave@example.com>&subject=Help&body-plain=hey+@claude+help+me&stripped-text=hey+@claude+help+me&Message-Id=<test004@example.com>&Date=2026-02-28T10:15:00Z"
```

**Expected**: Trigger IS detected (case-insensitive match on `@claude`).

### 2.6 Empty/malformed body

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d ""
```

**Expected**: HTTP `200` (the server is lenient -- it creates an email with empty fields and a generated Message-Id). Check that it doesn't crash.

### 2.7 Duplicate Message-Id

Send the same Message-Id twice:
```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=alice@example.com&subject=Dupe&body-plain=test&stripped-text=test&Message-Id=<dupe@example.com>&Date=2026-02-28T11:00:00Z"

curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=alice@example.com&subject=Dupe&body-plain=test&stripped-text=test&Message-Id=<dupe@example.com>&Date=2026-02-28T11:00:00Z"
```

**Expected**: Both return `200`. The second overwrites the first in the inbox JSON (same hash ID). The index will have two entries with the same ID -- this is a known limitation (append-only). Verify neither crashes the server.

---

## Phase 3: Email Storage (email-store.ts)

These are verified indirectly through Phase 2 webhook tests. After running Phase 2, check:

### 3.1 Inbox files

```bash
ls /tmp/mom-test/emails/inbox/
```

**Expected**: Multiple `.json` files, one per unique Message-Id hash.

### 3.2 Index file

```bash
cat /tmp/mom-test/emails/index.jsonl
```

**Expected**: One JSON line per email received, with fields: `id`, `from`, `subject`, `date`, `triggered`, `processed`.

### 3.3 Email JSON structure

```bash
cat /tmp/mom-test/emails/inbox/<any-hash>.json | python3 -m json.tool
```

**Expected**: Valid JSON with all `StoredEmail` fields present. Check:
- `id` matches filename (minus `.json`)
- `messageId` is the original `Message-Id`
- `triggered` matches whether the stripped-text contained `@Claude`
- `receivedAt` is a valid ISO timestamp
- `attachments` is an empty array (no attachment handling in these tests)

### 3.4 Processed flag

After a triggered email completes processing:

```bash
cat /tmp/mom-test/emails/inbox/<triggered-email-hash>.json | grep processed
```

**Expected**: `"processed": true`

---

## Phase 4: Agent Processing (agent.ts)

Requires valid `ANTHROPIC_API_KEY`. Send a trigger email and observe.

### 4.1 Basic agent run

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=test@example.com&from=Test+User+<test@example.com>&subject=Simple+question&body-plain=@Claude+What+is+2+%2B+2?&stripped-text=@Claude+What+is+2+%2B+2?&Message-Id=<agent-test-001@example.com>&Date=2026-02-28T12:00:00Z"
```

**Expected**:
- Server logs show trigger detection and enqueue
- Agent processing logs appear (tool calls, etc.)
- Session directory created: `ls /tmp/mom-test/sessions/`
- Session contains `session.jsonl` and `last_prompt.json`
- Usage summary logged
- If Mailgun creds are valid: reply email sent

### 4.2 Verify session artifacts

```bash
ls /tmp/mom-test/sessions/
# Should show a directory like: 1740744000000_<hash>/

ls /tmp/mom-test/sessions/*/
# Should contain: session.jsonl  last_prompt.json
```

Inspect the prompt:
```bash
cat /tmp/mom-test/sessions/*/last_prompt.json | python3 -m json.tool | head -20
```

**Expected**: Contains `systemPrompt`, `userMessage`, `triggeredEmailId`, `recentEmailCount`.

### 4.3 Context injection

Send several non-trigger emails first, then a trigger email:

```bash
# Non-trigger emails (context)
for i in 1 2 3; do
  curl -s -X POST http://localhost:3000/webhook/mailgun \
    -d "sender=context@example.com&subject=Update+$i&body-plain=Here+is+update+number+$i+about+the+project.&stripped-text=Here+is+update+number+$i+about+the+project.&Message-Id=<ctx-$i@example.com>&Date=2026-02-28T13:0${i}:00Z"
done

# Trigger email that should see the context
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=context@example.com&subject=Summary+request&body-plain=@Claude+Summarize+the+recent+updates.&stripped-text=@Claude+Summarize+the+recent+updates.&Message-Id=<ctx-trigger@example.com>&Date=2026-02-28T13:05:00Z"
```

**Verify**: In the session's `last_prompt.json`, the `userMessage` field should contain `<recent_emails>` with the 3 context emails, followed by `<triggered_email>` with the summary request.

### 4.4 Fresh session (no conversation leakage)

Send two trigger emails sequentially. Each should start a fresh agent session with no memory of the other.

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=fresh@example.com&subject=First&body-plain=@Claude+Remember+the+code+word+is+banana.&stripped-text=@Claude+Remember+the+code+word+is+banana.&Message-Id=<fresh-1@example.com>&Date=2026-02-28T14:00:00Z"

# Wait for processing to complete (watch logs)

curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=fresh@example.com&subject=Second&body-plain=@Claude+What+is+the+code+word?&stripped-text=@Claude+What+is+the+code+word?&Message-Id=<fresh-2@example.com>&Date=2026-02-28T14:05:00Z"
```

**Expected**: Two separate session directories. The second session has no conversational memory of the first (though it may see it in `<recent_emails>` context). Verify in `last_prompt.json` that there are no messages from the first session's agent conversation.

---

## Phase 5: Mailgun Sending (mailgun.ts)

### 5.1 Verify reply email is sent

Requires valid Mailgun credentials and a real recipient address you can check.

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=YOUR_REAL_EMAIL@gmail.com&from=YOUR_REAL_EMAIL@gmail.com&subject=Mailgun+test&body-plain=@Claude+Please+reply+with+just+the+word+hello.&stripped-text=@Claude+Please+reply+with+just+the+word+hello.&Message-Id=<mailgun-test@example.com>&Date=2026-02-28T15:00:00Z"
```

**Expected**: You receive a reply email at `YOUR_REAL_EMAIL@gmail.com` with:
- From: your configured `MAILGUN_FROM_ADDRESS`
- Subject: `Re: Mailgun test`
- Body: Something containing "hello"
- Threading headers present (check email source/headers in your email client)

### 5.2 Reply threading headers

Check the raw email headers of the reply:
- `In-Reply-To: <mailgun-test@example.com>`
- `References: <mailgun-test@example.com>`

### 5.3 Invalid Mailgun credentials

Set a bad API key and send a trigger email:

```bash
MAILGUN_API_KEY=invalid node dist/main.js /tmp/mom-test-bad
# Then send a trigger email
```

**Expected**: Agent runs successfully but the Mailgun send fails. Server logs show a warning like "Mailgun API error (401): ..." but the server does NOT crash.

---

## Phase 6: Webhook Signature Verification

### 6.1 With signing key set, missing signature fields

Start the server with `MAILGUN_SIGNING_KEY` set.

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=alice@example.com&subject=Test&body-plain=hi&stripped-text=hi&Message-Id=<sig-test@example.com>"
```

**Expected**: HTTP `401` with body "Missing signature".

### 6.2 With signing key set, invalid signature

```bash
curl -s -w "\n%{http_code}" -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=alice@example.com&subject=Test&body-plain=hi&stripped-text=hi&Message-Id=<sig-test@example.com>&timestamp=12345&token=abc&signature=invalid"
```

**Expected**: HTTP `401` with body "Invalid signature".

### 6.3 Without signing key (no verification)

Unset `MAILGUN_SIGNING_KEY` and restart. All webhooks should be accepted without signature fields.

---

## Phase 7: Processing Queue (queue.ts)

### 7.1 Sequential processing

Send multiple trigger emails rapidly:

```bash
for i in $(seq 1 5); do
  curl -s -X POST http://localhost:3000/webhook/mailgun \
    -d "sender=queue@example.com&subject=Queue+test+$i&body-plain=@Claude+Say+the+number+$i.&stripped-text=@Claude+Say+the+number+$i.&Message-Id=<queue-$i@example.com>&Date=2026-02-28T16:0${i}:00Z" &
done
wait
```

**Expected**:
- All 5 return HTTP `200` immediately
- Server logs show all 5 enqueued
- Processing happens one at a time (watch the logs -- each agent run completes before the next starts)
- Queue depth increments then decrements

### 7.2 Queue overflow

With max depth of 10, sending 15 trigger emails should show warnings for the last 5.

```bash
for i in $(seq 1 15); do
  curl -s -X POST http://localhost:3000/webhook/mailgun \
    -d "sender=overflow@example.com&subject=Overflow+$i&body-plain=@Claude+Number+$i&stripped-text=@Claude+Number+$i&Message-Id=<overflow-$i@example.com>&Date=2026-02-28T17:00:00Z" &
done
wait
```

**Expected**: First 10 enqueued, remaining show "Processing queue full" warnings. Note: some may complete before all 15 arrive, so you might not see exactly 5 rejections.

---

## Phase 8: Events System (events.ts)

### 8.1 Immediate event

While the server is running:

```bash
cat > /tmp/mom-test/events/test-immediate.json << 'EOF'
{"type": "immediate", "text": "Test immediate event fired"}
EOF
```

**Expected**:
- Server logs: `Executing immediate event: test-immediate.json`
- A synthetic email is created and enqueued for processing
- The event file is deleted after execution

### 8.2 One-shot event (future)

```bash
# Set to 30 seconds from now
AT=$(date -u -v+30S '+%Y-%m-%dT%H:%M:%S+00:00' 2>/dev/null || date -u -d '+30 seconds' '+%Y-%m-%dT%H:%M:%S+00:00')
cat > /tmp/mom-test/events/test-oneshot.json << EOF
{"type": "one-shot", "text": "One-shot event test", "at": "$AT"}
EOF
```

**Expected**:
- Logs: `Scheduling one-shot event: test-oneshot.json in ~30s`
- After 30 seconds: `Executing one-shot event: test-oneshot.json`
- Event file is deleted after execution

### 8.3 One-shot event (past)

```bash
cat > /tmp/mom-test/events/test-past.json << 'EOF'
{"type": "one-shot", "text": "This is in the past", "at": "2020-01-01T00:00:00+00:00"}
EOF
```

**Expected**: Logs: `One-shot event in the past, deleting`. File is deleted without executing.

### 8.4 Periodic event

```bash
cat > /tmp/mom-test/events/test-periodic.json << 'EOF'
{"type": "periodic", "text": "Periodic test", "schedule": "* * * * *", "timezone": "UTC"}
EOF
```

**Expected**:
- Logs: `Scheduled periodic event: test-periodic.json, next run: ...`
- Every minute: `Executing periodic event: test-periodic.json`
- File is NOT deleted after execution

Clean up:
```bash
rm /tmp/mom-test/events/test-periodic.json
```

### 8.5 Invalid event file

```bash
echo "not json" > /tmp/mom-test/events/bad-event.json
```

**Expected**: Logs warning about failed parsing. File is deleted.

---

## Phase 9: Email Tools (email-search.ts)

These are tested indirectly through agent runs. After storing several emails (Phase 2), send a trigger email that asks the agent to search:

### 9.1 email_search tool

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=tools@example.com&subject=Search+test&body-plain=@Claude+Search+my+emails+for+messages+from+alice.+Use+the+email_search+tool.&stripped-text=@Claude+Search+my+emails+for+messages+from+alice.+Use+the+email_search+tool.&Message-Id=<tools-search@example.com>&Date=2026-02-28T18:00:00Z"
```

**Expected**: In the session logs, you should see the agent call `email_search` with a query like "alice", and the tool returns matching results from the stored emails.

### 9.2 email_read tool

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=tools@example.com&subject=Read+test&body-plain=@Claude+Search+for+emails+about+Hello+and+read+the+first+result.+Use+email_search+then+email_read.&stripped-text=@Claude+Search+for+emails+about+Hello+and+read+the+first+result.+Use+email_search+then+email_read.&Message-Id=<tools-read@example.com>&Date=2026-02-28T18:05:00Z"
```

**Expected**: Agent uses `email_search`, then `email_read` with a specific ID, and the tool returns full email content.

---

## Phase 10: Docker Sandbox

Requires a running Docker container named e.g. `mom-sandbox` with the working directory mounted at `/workspace`.

### 10.1 Start with Docker sandbox

```bash
node dist/main.js --sandbox=docker:mom-sandbox /path/to/docker/mounted/dir
```

**Expected**: Starts normally. When processing a trigger email, bash commands execute inside the container.

### 10.2 Verify bash runs in container

Send a trigger email asking the agent to run `uname -a` or `cat /etc/os-release`.

**Expected**: Output shows the container's OS (e.g., Alpine Linux), not the host OS.

---

## Phase 11: Edge Cases

### 11.1 Very long email body

```bash
LONG_BODY=$(python3 -c "print('@Claude ' + 'x' * 100000)")
curl -s -X POST http://localhost:3000/webhook/mailgun \
  --data-urlencode "sender=long@example.com" \
  --data-urlencode "subject=Long email" \
  --data-urlencode "body-plain=$LONG_BODY" \
  --data-urlencode "stripped-text=$LONG_BODY" \
  --data-urlencode "Message-Id=<long@example.com>" \
  --data-urlencode "Date=2026-02-28T19:00:00Z"
```

**Expected**: Email is stored and processed without crash. The agent may truncate or summarize.

### 11.2 Special characters in email fields

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  --data-urlencode "sender=special@example.com" \
  --data-urlencode "subject=Héllo & Wörld <test>" \
  --data-urlencode "body-plain=@Claude café résumé naïve" \
  --data-urlencode "stripped-text=@Claude café résumé naïve" \
  --data-urlencode "Message-Id=<special-chars@example.com>" \
  --data-urlencode "Date=2026-02-28T19:05:00Z"
```

**Expected**: UTF-8 characters preserved in stored email JSON. No crash.

### 11.3 Missing Message-Id header

```bash
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=noid@example.com&subject=No+ID&body-plain=test&stripped-text=test"
```

**Expected**: Server generates a fallback Message-Id. Email is stored. No crash.

### 11.4 MEMORY.md persistence

```bash
# Create a memory file
echo "The user's name is Larry." > /tmp/mom-test/MEMORY.md

# Send a trigger email asking about memory
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=memory@example.com&subject=Memory+test&body-plain=@Claude+What+do+you+know+about+the+user?&stripped-text=@Claude+What+do+you+know+about+the+user?&Message-Id=<memory-test@example.com>&Date=2026-02-28T20:00:00Z"
```

**Expected**: In the session's `last_prompt.json`, the system prompt's "Current Memory" section should contain "The user's name is Larry." The agent's reply should reference this.

### 11.5 Custom trigger phrase

```bash
TRIGGER_PHRASE="Hey Bot" node dist/main.js /tmp/mom-test-custom
```

Then test with both phrases:

```bash
# Should NOT trigger (default phrase)
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=custom@example.com&subject=Test1&body-plain=@Claude+hello&stripped-text=@Claude+hello&Message-Id=<custom-1@example.com>&Date=2026-02-28T21:00:00Z"

# Should trigger (custom phrase)
curl -s -X POST http://localhost:3000/webhook/mailgun \
  -d "sender=custom@example.com&subject=Test2&body-plain=Hey+Bot+hello&stripped-text=Hey+Bot+hello&Message-Id=<custom-2@example.com>&Date=2026-02-28T21:05:00Z"
```

**Expected**: First email stored but NOT triggered. Second email triggers processing.

---

## Quick Smoke Test Sequence

If you want a fast end-to-end validation, run these in order:

1. Start the server: `node dist/main.js /tmp/mom-smoke`
2. Send a non-trigger email:
   ```bash
   curl -s -X POST http://localhost:3000/webhook/mailgun \
     -d "sender=smoke@example.com&subject=Context+email&body-plain=The+project+deadline+is+Friday.&stripped-text=The+project+deadline+is+Friday.&Message-Id=<smoke-1@example.com>&Date=2026-02-28T10:00:00Z"
   ```
3. Send a trigger email:
   ```bash
   curl -s -X POST http://localhost:3000/webhook/mailgun \
     -d "sender=smoke@example.com&subject=Question&body-plain=@Claude+When+is+the+project+deadline?&stripped-text=@Claude+When+is+the+project+deadline?&Message-Id=<smoke-2@example.com>&Date=2026-02-28T10:05:00Z"
   ```
4. Watch the server logs for the full flow: receive -> store -> trigger -> enqueue -> agent run -> reply
5. Check artifacts:
   ```bash
   ls /tmp/mom-smoke/emails/inbox/          # 2 JSON files
   cat /tmp/mom-smoke/emails/index.jsonl    # 2 lines
   ls /tmp/mom-smoke/sessions/              # 1 session directory
   cat /tmp/mom-smoke/sessions/*/last_prompt.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('Recent emails:', d['recentEmailCount']); print('User msg preview:', d['userMessage'][:200])"
   ```
