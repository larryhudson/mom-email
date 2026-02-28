import { createReadStream, existsSync } from "fs";
import { basename } from "path";
import { Blob } from "buffer";
import { readFile } from "fs/promises";

export interface MailgunConfig {
	apiKey: string;
	domain: string;
	fromAddress: string;
}

export interface SendEmailOptions {
	to: string;
	subject: string;
	text: string;
	html?: string;
	inReplyTo?: string;
	references?: string;
	attachments?: string[]; // file paths
}

export interface SendEmailResult {
	id: string;
	message: string;
}

/**
 * Send an email via the Mailgun REST API.
 */
export async function sendEmail(config: MailgunConfig, options: SendEmailOptions): Promise<SendEmailResult> {
	const url = `https://api.mailgun.net/v3/${config.domain}/messages`;
	const auth = Buffer.from(`api:${config.apiKey}`).toString("base64");

	const form = new FormData();
	form.append("from", config.fromAddress);
	form.append("to", options.to);
	form.append("subject", options.subject);
	form.append("text", options.text);

	if (options.html) {
		form.append("html", options.html);
	}

	if (options.inReplyTo) {
		form.append("h:In-Reply-To", options.inReplyTo);
	}

	if (options.references) {
		form.append("h:References", options.references);
	}

	// Attach files
	if (options.attachments) {
		for (const filePath of options.attachments) {
			if (!existsSync(filePath)) continue;
			const data = await readFile(filePath);
			const blob = new Blob([data]);
			form.append("attachment", blob, basename(filePath));
		}
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Basic ${auth}`,
		},
		body: form,
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Mailgun API error (${response.status}): ${body}`);
	}

	return (await response.json()) as SendEmailResult;
}

/**
 * Validate Mailgun credentials by checking the domain.
 * Throws if the API key or domain is invalid.
 */
export async function validateMailgunCredentials(config: MailgunConfig): Promise<void> {
	const url = `https://api.mailgun.net/v3/domains/${config.domain}`;
	const auth = Buffer.from(`api:${config.apiKey}`).toString("base64");

	const response = await fetch(url, {
		headers: { Authorization: `Basic ${auth}` },
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Mailgun credential check failed (${response.status}): ${body}`);
	}
}

/**
 * Verify a Mailgun webhook signature.
 * Returns true if the signature is valid.
 */
export async function verifyWebhookSignature(
	signingKey: string,
	timestamp: string,
	token: string,
	signature: string,
): Promise<boolean> {
	const crypto = await import("crypto");
	const data = timestamp + token;
	const hmac = crypto.createHmac("sha256", signingKey).update(data).digest("hex");
	return hmac === signature;
}
