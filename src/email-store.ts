import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";

// ============================================================================
// Types
// ============================================================================

export interface StoredEmail {
	id: string;              // Sanitized Message-Id hash (used as filename)
	messageId: string;       // Original Message-Id header
	inReplyTo?: string;      // In-Reply-To header
	references?: string;     // References header
	from: string;            // Sender address
	to: string;              // Recipient address
	subject: string;         // Email subject
	date: string;            // ISO 8601 from Date header
	receivedAt: string;      // ISO 8601 when webhook received
	bodyPlain: string;       // Full plain text body (body-plain from Mailgun)
	strippedText: string;    // Body with quoted replies removed (stripped-text from Mailgun)
	bodyHtml?: string;       // HTML body (for reference)
	triggered: boolean;      // Whether this email contained the trigger phrase
	processed?: boolean;     // Whether agent has processed this
	attachments: Array<{
		filename: string;
		contentType: string;
		localPath: string;   // Relative path under attachments/<hash>/
	}>;
}

export interface EmailIndexEntry {
	id: string;
	from: string;
	subject: string;
	date: string;
	triggered: boolean;
	processed: boolean;
}

export interface GetRecentOptions {
	limit?: number;
	since?: string;         // ISO 8601 date
	triggeredOnly?: boolean;
}

// ============================================================================
// EmailStore
// ============================================================================

export class EmailStore {
	private emailsDir: string;
	private inboxDir: string;
	private attachmentsDir: string;
	private indexPath: string;

	constructor(private workingDir: string) {
		this.emailsDir = join(workingDir, "emails");
		this.inboxDir = join(this.emailsDir, "inbox");
		this.attachmentsDir = join(this.emailsDir, "attachments");
		this.indexPath = join(this.emailsDir, "index.jsonl");

		// Ensure directories exist
		mkdirSync(this.inboxDir, { recursive: true });
		mkdirSync(this.attachmentsDir, { recursive: true });
	}

	/**
	 * Generate a stable ID from a Message-Id header.
	 */
	static hashMessageId(messageId: string): string {
		return createHash("sha256").update(messageId).digest("hex").substring(0, 16);
	}

	/**
	 * Save an email to disk and append to the index.
	 */
	async save(email: StoredEmail): Promise<void> {
		const filePath = join(this.inboxDir, `${email.id}.json`);
		await writeFile(filePath, JSON.stringify(email, null, 2), "utf-8");

		// Append to index
		const indexEntry: EmailIndexEntry = {
			id: email.id,
			from: email.from,
			subject: email.subject,
			date: email.date,
			triggered: email.triggered,
			processed: email.processed ?? false,
		};
		await appendFile(this.indexPath, JSON.stringify(indexEntry) + "\n", "utf-8");
	}

	/**
	 * Save an attachment file for an email.
	 */
	async saveAttachment(emailId: string, filename: string, data: Buffer): Promise<string> {
		const dir = join(this.attachmentsDir, emailId);
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, filename);
		await writeFile(filePath, data);
		return `attachments/${emailId}/${filename}`;
	}

	/**
	 * Load a single email by ID.
	 */
	get(emailId: string): StoredEmail | null {
		const filePath = join(this.inboxDir, `${emailId}.json`);
		if (!existsSync(filePath)) return null;
		try {
			return JSON.parse(readFileSync(filePath, "utf-8")) as StoredEmail;
		} catch {
			return null;
		}
	}

	/**
	 * Mark an email as processed.
	 */
	async markProcessed(emailId: string): Promise<void> {
		const email = this.get(emailId);
		if (!email) return;
		email.processed = true;
		const filePath = join(this.inboxDir, `${emailId}.json`);
		await writeFile(filePath, JSON.stringify(email, null, 2), "utf-8");
	}

	/**
	 * Get recent emails from the index.
	 */
	getRecent(opts: GetRecentOptions = {}): EmailIndexEntry[] {
		const { limit = 50, since, triggeredOnly = false } = opts;

		if (!existsSync(this.indexPath)) return [];

		const content = readFileSync(this.indexPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);

		let entries: EmailIndexEntry[] = [];
		for (const line of lines) {
			try {
				entries.push(JSON.parse(line) as EmailIndexEntry);
			} catch {
				// Skip malformed lines
			}
		}

		// Apply filters
		if (since) {
			const sinceTime = new Date(since).getTime();
			entries = entries.filter((e) => new Date(e.date).getTime() >= sinceTime);
		}
		if (triggeredOnly) {
			entries = entries.filter((e) => e.triggered);
		}

		// Return most recent, up to limit
		return entries.slice(-limit);
	}

	/**
	 * Full-text search across from/subject/body of stored emails.
	 * Returns matching email index entries with snippets.
	 */
	search(query: string, limit = 20): Array<EmailIndexEntry & { snippet: string }> {
		if (!existsSync(this.indexPath)) return [];

		const content = readFileSync(this.indexPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const queryLower = query.toLowerCase();
		const results: Array<EmailIndexEntry & { snippet: string }> = [];

		for (const line of lines) {
			if (results.length >= limit) break;

			let entry: EmailIndexEntry;
			try {
				entry = JSON.parse(line) as EmailIndexEntry;
			} catch {
				continue;
			}

			// Quick check on index fields first
			if (
				entry.from.toLowerCase().includes(queryLower) ||
				entry.subject.toLowerCase().includes(queryLower)
			) {
				const snippet = entry.subject.substring(0, 100);
				results.push({ ...entry, snippet });
				continue;
			}

			// Load full email for body search
			const email = this.get(entry.id);
			if (!email) continue;

			if (email.bodyPlain.toLowerCase().includes(queryLower)) {
				// Extract snippet around match
				const idx = email.bodyPlain.toLowerCase().indexOf(queryLower);
				const start = Math.max(0, idx - 40);
				const end = Math.min(email.bodyPlain.length, idx + query.length + 40);
				const snippet = (start > 0 ? "..." : "") +
					email.bodyPlain.substring(start, end).replace(/\n/g, " ") +
					(end < email.bodyPlain.length ? "..." : "");
				results.push({ ...entry, snippet });
			}
		}

		return results;
	}

	/**
	 * Load full emails for a list of IDs.
	 */
	getMany(ids: string[]): StoredEmail[] {
		const emails: StoredEmail[] = [];
		for (const id of ids) {
			const email = this.get(id);
			if (email) emails.push(email);
		}
		return emails;
	}
}
