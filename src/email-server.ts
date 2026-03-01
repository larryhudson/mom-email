import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { verifyWebhookSignature } from "./mailgun.js";
import { handleWorkspaceRequest } from "./workspace-browser.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export interface ParsedEmail {
	sender: string;
	from: string;
	subject: string;
	bodyPlain: string;
	strippedText: string;
	bodyHtml?: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	date: string;
	attachmentCount: number;
	// Raw fields for attachment handling
	rawFields: Map<string, string>;
}

export interface EmailServerConfig {
	port: number;
	signingKey?: string;  // If set, verify Mailgun webhook signatures
	onEmail: (email: ParsedEmail) => Promise<void>;
	workingDir: string;   // Workspace root for the file browser
}

// ============================================================================
// Server
// ============================================================================

/**
 * Create and start an HTTP server for receiving Mailgun webhook POSTs.
 */
export function createEmailServer(config: EmailServerConfig): { start: () => void; stop: () => void } {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		// Workspace file browser
		if (req.url?.startsWith("/workspace") && req.method === "GET") {
			if (handleWorkspaceRequest(config.workingDir, req, res)) return;
		}

		// Only accept POST to /webhook/mailgun
		if (req.method !== "POST" || req.url !== "/webhook/mailgun") {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}

		try {
			const body = await readBody(req);
			const fields = parseFormUrlEncoded(body);

			// Optional signature verification
			if (config.signingKey) {
				const timestamp = fields.get("timestamp") || "";
				const token = fields.get("token") || "";
				const signature = fields.get("signature") || "";

				if (!timestamp || !token || !signature) {
					log.logWarning("Webhook missing signature fields");
					res.writeHead(401, { "Content-Type": "text/plain" });
					res.end("Missing signature");
					return;
				}

				const valid = await verifyWebhookSignature(config.signingKey, timestamp, token, signature);
				if (!valid) {
					log.logWarning("Webhook signature verification failed");
					res.writeHead(401, { "Content-Type": "text/plain" });
					res.end("Invalid signature");
					return;
				}
			}

			const email = fieldsToEmail(fields);

			log.logEmailReceived(email.from, email.subject);

			// Respond 200 immediately (Mailgun expects quick response)
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("OK");

			// Process asynchronously
			config.onEmail(email).catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				log.logWarning("Error in email handler", msg);
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning("Webhook error", msg);
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Bad Request");
		}
	});

	return {
		start() {
			server.listen(config.port, () => {
				log.logInfo(`Webhook server listening on port ${config.port}`);
			});
		},
		stop() {
			server.close();
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalSize = 0;
		const maxSize = 10 * 1024 * 1024; // 10MB limit

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > maxSize) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf-8"));
		});

		req.on("error", reject);
	});
}

function parseFormUrlEncoded(body: string): Map<string, string> {
	const fields = new Map<string, string>();
	const pairs = body.split("&");
	for (const pair of pairs) {
		const eqIdx = pair.indexOf("=");
		if (eqIdx === -1) continue;
		const key = decodeURIComponent(pair.substring(0, eqIdx).replace(/\+/g, " "));
		const value = decodeURIComponent(pair.substring(eqIdx + 1).replace(/\+/g, " "));
		fields.set(key, value);
	}
	return fields;
}

function fieldsToEmail(fields: Map<string, string>): ParsedEmail {
	return {
		sender: fields.get("sender") || "",
		from: fields.get("from") || fields.get("sender") || "",
		subject: fields.get("subject") || "(no subject)",
		bodyPlain: fields.get("body-plain") || "",
		strippedText: fields.get("stripped-text") || fields.get("body-plain") || "",
		bodyHtml: fields.get("body-html") || undefined,
		messageId: fields.get("Message-Id") || `<${Date.now()}@unknown>`,
		inReplyTo: fields.get("In-Reply-To") || undefined,
		references: fields.get("References") || undefined,
		date: fields.get("Date") || new Date().toISOString(),
		attachmentCount: parseInt(fields.get("attachment-count") || "0", 10),
		rawFields: fields,
	};
}
