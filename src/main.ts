#!/usr/bin/env node

import "dotenv/config";
import { resolve } from "path";
import { marked } from "marked";
import { runAgent } from "./agent.js";
import { createEmailServer, type ParsedEmail } from "./email-server.js";
import { EmailStore, type StoredEmail } from "./email-store.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { sendEmail, validateMailgunCredentials, type MailgunConfig } from "./mailgun.js";
import { ProcessingQueue } from "./queue.js";
import { parseContainerArg, type SandboxConfig, validateSandbox } from "./sandbox.js";

// ============================================================================
// Config
// ============================================================================

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
const MAILGUN_FROM_ADDRESS = process.env.MAILGUN_FROM_ADDRESS;
const MAILGUN_SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY;
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "3000", 10);
const TRIGGER_PHRASE = process.env.TRIGGER_PHRASE || "@Claude";
const ALLOWED_USER_EMAIL = process.env.ALLOWED_USER_EMAIL;
const WORKSPACE_TOKEN = process.env.WORKSPACE_TOKEN;
const DANGEROUSLY_RUN_COMMANDS_ON_HOST = process.env.DANGEROUSLY_RUN_COMMANDS_ON_HOST === "true";

interface ParsedArgs {
	workingDir?: string;
	containerName?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let containerName: string | undefined;
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--container=")) {
			containerName = arg.slice("--container=".length);
		} else if (arg === "--container") {
			containerName = args[++i] || undefined;
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		containerName,
	};
}

const parsedArgs = parseArgs();

if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--container=<name>] <working-directory>");
	process.exit(1);
}

const workingDir = parsedArgs.workingDir;

// Determine sandbox config
let sandbox: SandboxConfig;
if (DANGEROUSLY_RUN_COMMANDS_ON_HOST) {
	console.warn("WARNING: DANGEROUSLY_RUN_COMMANDS_ON_HOST is enabled. Commands will run directly on the host machine.");
	sandbox = { type: "host" };
} else {
	const docker = parseContainerArg(parsedArgs.containerName);
	await validateSandbox(docker, workingDir);
	sandbox = { type: "docker", container: docker.container };
}

if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_ADDRESS) {
	console.error("Missing env: MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM_ADDRESS");
	process.exit(1);
}

const mailgunApiKey: string = MAILGUN_API_KEY;
const mailgunDomain: string = MAILGUN_DOMAIN;
const mailgunFromAddress: string = MAILGUN_FROM_ADDRESS;

// ============================================================================
// Setup
// ============================================================================

const mailgunConfig: MailgunConfig = {
	apiKey: mailgunApiKey,
	domain: mailgunDomain,
	fromAddress: mailgunFromAddress,
};

const emailStore = new EmailStore(workingDir);

const sandboxLabel = sandbox.type === "host" ? "host (DANGEROUS)" : `docker:${sandbox.container}`;
log.logStartup(workingDir, sandboxLabel);

// Validate Mailgun credentials before starting (skip in dry-run mode)
if (process.env.IS_DRY_RUN !== "true") {
	try {
		await validateMailgunCredentials(mailgunConfig);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`Mailgun validation failed: ${msg}`);
		process.exit(1);
	}
}

// ============================================================================
// Processing Queue
// ============================================================================

const queue = new ProcessingQueue(async (emailId: string) => {
	log.setCurrentEmail(emailId);
	try {
		await processEmail(emailId);
	} finally {
		log.emitComplete(emailId);
		log.clearCurrentEmail();
	}
});

async function processEmail(emailId: string): Promise<void> {
	const email = emailStore.get(emailId);
	if (!email) {
		log.logWarning(`Email not found for processing: ${emailId}`);
		return;
	}

	log.logEmailProcessing(email.from, email.subject);

	// Gather recent context emails (last 50 emails for context)
	const recentEntries = emailStore.getRecent({ limit: 50 });
	const recentIds = recentEntries
		.filter((e) => e.id !== emailId)
		.map((e) => e.id);
	const recentEmails = emailStore.getMany(recentIds);

	try {
		const result = await runAgent(sandbox, workingDir, {
			triggeredEmail: email,
			recentEmails,
			fromAddress: mailgunFromAddress,
		}, TRIGGER_PHRASE);

		if (!email.triggered) {
			// Background mode: agent processed the email but no reply is sent
			log.logInfo(`Background processing complete for email ${emailId} -- no reply sent (not triggered)`);
		} else if (result.stopReason === "error") {
			// If the agent errored (e.g. API rejected the request), send the error as a reply
			const errorText = result.errorMessage || "An unknown error occurred while processing your email.";
			log.logWarning(`Agent error for email ${emailId}: ${errorText}`);

			const replySubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
			const references = email.references
				? `${email.references} ${email.messageId}`
				: email.messageId;
			const errorReplyText = `Sorry, I ran into an error while processing your email:\n\n${errorText}`;

			if (isDryRun) {
				log.logInfo(`[DRY RUN] Would send error reply to ${email.from}: ${replySubject}`);
				log.logInfo(`[DRY RUN] Error body:\n${errorReplyText}`);
			} else {
				const replyHtml = await marked(errorReplyText);
				await sendEmail(mailgunConfig, {
					to: email.from,
					subject: replySubject,
					text: errorReplyText,
					html: replyHtml,
					inReplyTo: email.messageId,
					references,
				});
			}
		} else if (result.replyText.trim() === "[SILENT]" || result.replyText.trim().startsWith("[SILENT]")) {
			// Explicit silent marker (e.g. periodic events with nothing to report)
			log.logInfo(`Silent response for email ${emailId} -- no reply sent`);
		} else if (result.replyText.trim()) {
			// Build threading headers
			const replySubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
			const references = email.references
				? `${email.references} ${email.messageId}`
				: email.messageId;

			let sentMessageId: string;

			if (isDryRun) {
				// Dev/test mode: log the reply instead of sending via Mailgun
				log.logInfo(`[DRY RUN] Would send reply to ${email.from}: ${replySubject}`);
				log.logInfo(`[DRY RUN] Reply body:\n${result.replyText}`);
				sentMessageId = `<dryrun_${Date.now()}@local>`;
			} else {
				const replyHtml = await marked(result.replyText);
				const sendResult = await sendEmail(mailgunConfig, {
					to: email.from,
					subject: replySubject,
					text: result.replyText,
					html: replyHtml,
					inReplyTo: email.messageId,
					references,
					attachments: result.attachments.length > 0 ? result.attachments : undefined,
				});
				sentMessageId = sendResult.id;
			}

			// Save sent email to store
			const sentId = EmailStore.hashMessageId(sentMessageId);
			const sentEmail: StoredEmail = {
				id: sentId,
				messageId: sentMessageId,
				inReplyTo: email.messageId,
				references,
				from: mailgunFromAddress,
				to: email.from,
				subject: replySubject,
				date: new Date().toISOString(),
				receivedAt: new Date().toISOString(),
				bodyPlain: result.replyText,
				strippedText: result.replyText,
				triggered: false,
				processed: true,
				attachments: [],
			};
			await emailStore.saveSent(sentEmail);

			log.logEmailReply(email.from, email.subject);
		} else {
			log.logWarning(`Empty response for email ${emailId} -- no reply sent`);
		}

		// Mark as processed
		await emailStore.markProcessed(emailId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning(`Failed to process email ${emailId}`, msg);
	}
}

// ============================================================================
// Webhook Handler
// ============================================================================

async function handleIncomingEmail(parsed: ParsedEmail): Promise<void> {
	// Check sender against allowlist
	const senderAddress = (parsed.sender || parsed.from).replace(/.*<([^>]+)>.*/, "$1").toLowerCase();
	if (ALLOWED_USER_EMAIL && senderAddress !== ALLOWED_USER_EMAIL.toLowerCase()) {
		log.logWarning(`Rejected email from unauthorized sender: ${senderAddress}`);
		return;
	}

	// Generate stable ID from Message-Id
	const id = EmailStore.hashMessageId(parsed.messageId);

	// Check for trigger phrase in stripped text (avoids false triggers from quoted replies)
	const triggerRegex = new RegExp(TRIGGER_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const triggered = triggerRegex.test(parsed.strippedText);

	// Save attachments to disk
	const savedAttachments: StoredEmail["attachments"] = [];
	for (const attachment of parsed.attachments) {
		const localPath = await emailStore.saveAttachment(id, attachment.filename, attachment.data);
		savedAttachments.push({
			filename: attachment.filename,
			contentType: attachment.contentType,
			localPath,
		});
	}

	// Build stored email
	const storedEmail: StoredEmail = {
		id,
		messageId: parsed.messageId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
		from: parsed.sender || parsed.from,
		to: mailgunFromAddress,
		subject: parsed.subject,
		date: parsed.date,
		receivedAt: new Date().toISOString(),
		bodyPlain: parsed.bodyPlain,
		strippedText: parsed.strippedText,
		bodyHtml: parsed.bodyHtml,
		triggered,
		processed: false,
		attachments: savedAttachments,
	};

	// Save to store
	await emailStore.save(storedEmail);

	if (triggered) {
		log.logInfo(`Trigger phrase "${TRIGGER_PHRASE}" detected in email from ${parsed.from}`);
	} else {
		log.logInfo(`Email received (no trigger, background processing): ${parsed.from} - ${parsed.subject}`);
	}
	queue.enqueue(id);
}

// ============================================================================
// Events Watcher
// ============================================================================

const eventsWatcher = createEventsWatcher(workingDir, (text: string, _filename: string): boolean => {
	// Create a synthetic triggered email for the event
	const eventId = `event_${Date.now()}`;
	const syntheticEmail: StoredEmail = {
		id: eventId,
		messageId: `<${eventId}@events>`,
		from: ALLOWED_USER_EMAIL || "system@events",
		to: mailgunFromAddress,
		subject: "Scheduled Event",
		date: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		bodyPlain: text,
		strippedText: text,
		triggered: true,
		processed: false,
		attachments: [],
	};

	// Save and enqueue
	emailStore.save(syntheticEmail).then(() => {
		queue.enqueue(eventId);
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Failed to enqueue event", msg);
	});

	return true;
});

eventsWatcher.start();

// ============================================================================
// Start Server
// ============================================================================

const isDryRun = process.env.IS_DRY_RUN === "true";
if (isDryRun) {
	log.logWarning("Dry run mode enabled -- signature verification skipped, emails will not be sent");
}

const emailServer = createEmailServer({
	port: WEBHOOK_PORT,
	signingKey: isDryRun ? undefined : MAILGUN_SIGNING_KEY,
	onEmail: handleIncomingEmail,
	workingDir,
	workspaceToken: WORKSPACE_TOKEN,
});

emailServer.start();

log.logConnected();

// ============================================================================
// Shutdown
// ============================================================================

process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	emailServer.stop();
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	emailServer.stop();
	eventsWatcher.stop();
	process.exit(0);
});
