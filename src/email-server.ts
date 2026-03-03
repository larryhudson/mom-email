import { createHash } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Busboy, type BusboyFileStream, type BusboyHeaders } from "@fastify/busboy";
import { verifyWebhookSignature } from "./mailgun.js";
import { handleLogRequest } from "./log-viewer.js";
import { handleWorkspaceRequest } from "./workspace-browser.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export interface ParsedAttachment {
	filename: string;
	contentType: string;
	data: Buffer;
}

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
	attachments: ParsedAttachment[];
	rawFields: Map<string, string>;
}

export interface EmailServerConfig {
	port: number;
	signingKey?: string;  // If set, verify Mailgun webhook signatures
	onEmail: (email: ParsedEmail) => Promise<void>;
	workingDir: string;   // Workspace root for the file browser
	workspaceToken?: string; // If set, require token to access /workspace
}

// ============================================================================
// Helpers
// ============================================================================

function hashMessageId(messageId: string): string {
	return createHash("sha256").update(messageId).digest("hex").substring(0, 16);
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
			if (handleWorkspaceRequest(config.workingDir, req, res, config.workspaceToken)) return;
		}

		// Log viewer
		if (req.url?.startsWith("/logs") && req.method === "GET") {
			if (handleLogRequest(req, res, config.workspaceToken)) return;
		}

		// SSE log stream for a specific email
		const sseMatch = req.url?.match(/^\/api\/email\/([a-f0-9]+)\/logs$/);
		if (sseMatch && req.method === "GET") {
			handleEmailLogStream(sseMatch[1], res);
			return;
		}

		// Only accept POST to /webhook/mailgun
		if (req.method !== "POST" || req.url !== "/webhook/mailgun") {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}

		const contentType = req.headers["content-type"] || "unknown";
		log.logInfo(`Webhook received: content-type=${contentType.split(";")[0]}, content-length=${req.headers["content-length"] || "unknown"}`);

		try {
			let fields: Map<string, string>;
			let attachments: ParsedAttachment[];

			if (contentType.startsWith("multipart/form-data")) {
				const result = await parseMultipartFormData(req);
				fields = result.fields;
				attachments = result.attachments;
				if (attachments.length > 0) {
					log.logInfo(`Parsed ${attachments.length} attachment(s): ${attachments.map((a) => `${a.filename} (${a.contentType}, ${(a.data.length / 1024).toFixed(0)}KB)`).join(", ")}`);
				}
			} else {
				const body = await readBody(req);
				fields = parseFormUrlEncoded(body);
				attachments = [];
			}

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

			const email = fieldsToEmail(fields, attachments);
			const emailId = hashMessageId(email.messageId);

			log.logEmailReceived(email.from, email.subject);

			// Respond 200 with the emailId so clients can subscribe to logs
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, emailId }));

			// Process asynchronously
			config.onEmail(email).catch((err) => {
				const msg = err instanceof Error ? err.message : String(err);
				log.logWarning("Error in email handler", msg);
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning("Webhook error", `${msg}\nContent-Type: ${contentType}`);
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
// SSE log streaming
// ============================================================================

function handleEmailLogStream(emailId: string, res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
	});

	// Send any buffered log entries immediately
	const buffered = log.getBufferedLogs(emailId);
	for (const entry of buffered) {
		res.write(`data: ${JSON.stringify(entry)}\n\n`);
	}

	// Subscribe to new logs and completion
	const unsubscribe = log.subscribe(
		(entry) => {
			if (entry.emailId === emailId) {
				res.write(`data: ${JSON.stringify(entry)}\n\n`);
			}
		},
		(completedId) => {
			if (completedId === emailId) {
				res.write(`event: done\ndata: {}\n\n`);
				res.end();
				unsubscribe();
				setTimeout(() => log.cleanup(emailId), 5000);
			}
		},
	);

	// Clean up if client disconnects early
	res.on("close", () => {
		unsubscribe();
	});
}

// ============================================================================
// Parsing helpers
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

function parseMultipartFormData(req: IncomingMessage): Promise<{ fields: Map<string, string>; attachments: ParsedAttachment[] }> {
	return new Promise((resolve, reject) => {
		const fields = new Map<string, string>();
		const attachments: ParsedAttachment[] = [];

		const busboy = Busboy({
			headers: req.headers as BusboyHeaders,
			limits: {
				fileSize: 10 * 1024 * 1024, // 10MB per file
				files: 10,
			},
		});

		busboy.on("field", (fieldname: string, value: string) => {
			fields.set(fieldname, value);
		});

		busboy.on("file", (fieldname: string, stream: BusboyFileStream, filename: string, _encoding: string, mimeType: string) => {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => {
				chunks.push(chunk);
			});
			stream.on("end", () => {
				if (filename) {
					attachments.push({
						filename,
						contentType: mimeType,
						data: Buffer.concat(chunks),
					});
				}
			});
		});

		busboy.on("finish", () => {
			resolve({ fields, attachments });
		});

		busboy.on("error", (err: unknown) => {
			reject(err instanceof Error ? err : new Error(String(err)));
		});

		req.pipe(busboy);
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

function fieldsToEmail(fields: Map<string, string>, attachments: ParsedAttachment[]): ParsedEmail {
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
		attachmentCount: parseInt(fields.get("attachment-count") || "0", 10) || attachments.length,
		attachments,
		rawFields: fields,
	};
}
