#!/usr/bin/env tsx
/**
 * Simple CLI to send test email payloads to the local webhook server.
 *
 * By default, waits for the server to finish processing the email and streams
 * the server logs in real-time. Use --async to fire-and-forget.
 *
 * Usage:
 *   npx tsx scripts/send-email.ts                     # interactive prompts
 *   npx tsx scripts/send-email.ts --from "Alice <alice@example.com>" --subject "Hello" --body "Hi there"
 *   npx tsx scripts/send-email.ts --reply-to "<msg-id>"  # send as a reply
 *   npx tsx scripts/send-email.ts --async                # don't wait for processing
 */

import * as readline from "readline";

const BASE_URL = process.env.WEBHOOK_URL?.replace(/\/webhook\/mailgun$/, "") || "http://localhost:3000";
const WEBHOOK_URL = `${BASE_URL}/webhook/mailgun`;
const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
	const flags = new Set<string>();
	const opts: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--async") {
			flags.add("async");
		} else if (arg.startsWith("--") && i + 1 < argv.length) {
			opts[arg.slice(2)] = argv[++i];
		}
	}
	return { flags, opts };
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

async function sendEmail(opts: {
	from: string;
	subject: string;
	body: string;
	replyTo?: string;
}): Promise<string | undefined> {
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

	// Try to parse JSON response with emailId
	let emailId: string | undefined;
	try {
		const json = JSON.parse(text);
		emailId = json.emailId;
	} catch {
		// Old-style plain-text response
	}

	console.log();
	console.log(`  Status:     ${res.status} ${res.statusText}`);
	console.log(`  Message-Id: ${messageId}`);
	if (emailId) {
		console.log(`  Email ID:   ${emailId}`);
	}
	console.log();

	return emailId;
}

// ---------------------------------------------------------------------------
// SSE log streaming
// ---------------------------------------------------------------------------

function formatLogEntry(entry: { level: string; message: string }): string {
	const prefix: Record<string, string> = {
		info: "[system]",
		warning: "[system] WARNING",
		email: "[email]",
		tool: "[agent]",
		usage: "[usage]",
	};
	return `  ${prefix[entry.level] || `[${entry.level}]`} ${entry.message}`;
}

async function streamLogs(emailId: string): Promise<void> {
	const url = `${BASE_URL}/api/email/${emailId}/logs`;

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		console.log(`\n  Timed out after ${TIMEOUT_MS / 1000}s waiting for processing to complete.`);
		controller.abort();
	}, TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});

		if (!res.ok || !res.body) {
			console.error(`  Failed to connect to log stream: ${res.status} ${res.statusText}`);
			return;
		}

		console.log("  Waiting for processing...");
		console.log("  ─────────────────────────");

		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of res.body) {
			buffer += decoder.decode(chunk as BufferSource, { stream: true });

			// Parse SSE events (separated by double newlines)
			const parts = buffer.split("\n\n");
			buffer = parts.pop()!; // Keep incomplete event in buffer

			for (const part of parts) {
				if (!part.trim()) continue;

				// Check for "done" event
				if (part.includes("event: done")) {
					console.log("  ─────────────────────────");
					console.log("  Processing complete.");
					console.log();
					return;
				}

				// Parse data lines
				const dataLines = part.split("\n")
					.filter((line) => line.startsWith("data: "))
					.map((line) => line.substring(6));

				for (const data of dataLines) {
					try {
						const entry = JSON.parse(data);
						console.log(formatLogEntry(entry));
					} catch {
						// Skip unparseable entries
					}
				}
			}
		}
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { flags, opts: args } = parseArgs(process.argv.slice(2));
	const isAsync = flags.has("async");

	// If all required fields are provided via flags, send directly
	if (args.from && args.subject && args.body) {
		const emailId = await sendEmail({
			from: args.from,
			subject: args.subject,
			body: args.body,
			replyTo: args["reply-to"],
		});
		if (!isAsync && emailId) {
			await streamLogs(emailId);
		}
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

	const emailId = await sendEmail({ from, subject, body, replyTo: replyTo || undefined });
	if (!isAsync && emailId) {
		await streamLogs(emailId);
	}
}

main().catch((err) => {
	console.error("Error:", err.message || err);
	process.exit(1);
});
