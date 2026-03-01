#!/usr/bin/env tsx
/**
 * Simple CLI to send test email payloads to the local webhook server.
 *
 * Requires the server to be running with SKIP_SIGNATURE_VERIFICATION=true.
 *
 * Usage:
 *   npx tsx scripts/send-email.ts                     # interactive prompts
 *   npx tsx scripts/send-email.ts --from "Alice <alice@example.com>" --subject "Hello" --body "Hi there"
 *   npx tsx scripts/send-email.ts --reply-to "<msg-id>"  # send as a reply
 */

import * as readline from "readline";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:3000/webhook/mailgun";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--") && i + 1 < argv.length) {
			args[arg.slice(2)] = argv[++i];
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Interactive prompt helper
// ---------------------------------------------------------------------------

function createPrompt(): {
	ask: (q: string, fallback?: string) => Promise<string>;
	askMultiline: (q: string) => Promise<string>;
	close: () => void;
} {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	function ask(question: string, fallback?: string): Promise<string> {
		const suffix = fallback ? ` [${fallback}]` : "";
		return new Promise((resolve) => {
			rl.question(`${question}${suffix}: `, (answer) => {
				resolve(answer.trim() || fallback || "");
			});
		});
	}

	function askMultiline(question: string): Promise<string> {
		console.log(`${question} (enter a blank line to finish):`);
		return new Promise((resolve) => {
			const lines: string[] = [];
			const handler = (line: string) => {
				if (line === "") {
					rl.removeListener("line", handler);
					resolve(lines.join("\n"));
				} else {
					lines.push(line);
				}
			};
			rl.on("line", handler);
		});
	}

	return { ask, askMultiline, close: () => rl.close() };
}

// ---------------------------------------------------------------------------
// Send email
// ---------------------------------------------------------------------------

async function sendEmail(opts: { from: string; subject: string; body: string; replyTo?: string }) {
	const sender = opts.from.match(/<(.+)>/)?.[1] || opts.from;
	const messageId = `<test-${Date.now()}@example.com>`;

	const fields: Record<string, string> = {
		sender,
		from: opts.from,
		subject: opts.subject,
		"body-plain": opts.body,
		"stripped-text": opts.body,
		"Message-Id": messageId,
		Date: new Date().toISOString(),
		"attachment-count": "0",
	};

	if (opts.replyTo) {
		fields["In-Reply-To"] = opts.replyTo;
		fields["References"] = opts.replyTo;
	}

	const encoded = Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");

	const res = await fetch(WEBHOOK_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: encoded,
	});

	const text = await res.text();
	console.log();
	console.log(`  Status:     ${res.status} ${res.statusText}`);
	console.log(`  Response:   ${text}`);
	console.log(`  Message-Id: ${messageId}`);
	console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));

	// If all required fields are provided via flags, send directly
	if (args.from && args.subject && args.body) {
		await sendEmail({
			from: args.from,
			subject: args.subject,
			body: args.body,
			replyTo: args["reply-to"],
		});
		return;
	}

	// Interactive mode
	const prompt = createPrompt();

	console.log();
	console.log("Send a test email to the webhook server");
	console.log("========================================");
	console.log();

	const from = await prompt.ask("From", args.from || "Alice <alice@example.com>");
	const subject = await prompt.ask("Subject", args.subject || "Test email");
	const body = args.body || (await prompt.askMultiline("Body"));
	const replyTo = args["reply-to"] || (await prompt.ask("In-Reply-To (message ID, or leave blank)"));

	prompt.close();

	await sendEmail({ from, subject, body, replyTo: replyTo || undefined });
}

main().catch((err) => {
	console.error("Error:", err.message || err);
	process.exit(1);
});
