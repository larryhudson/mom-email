import chalk from "chalk";
import { EventEmitter } from "events";

export interface LogContext {
	channelId: string;
	userName?: string;
	emailId?: string;
}

export interface LogEntry {
	timestamp: string;
	level: "info" | "warning" | "email" | "tool" | "usage";
	message: string;
	emailId?: string;
}

// ---------------------------------------------------------------------------
// Event emitter for log streaming
// ---------------------------------------------------------------------------

const emitter = new EventEmitter();
const emailBuffers = new Map<string, LogEntry[]>();
let currentEmailId: string | undefined;

function emit(level: LogEntry["level"], message: string, emailId?: string): void {
	const id = emailId || currentEmailId;
	if (!id) return;

	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		emailId: id,
	};

	let buffer = emailBuffers.get(id);
	if (!buffer) {
		buffer = [];
		emailBuffers.set(id, buffer);
	}
	buffer.push(entry);

	emitter.emit("log", entry);
}

/** Set the email ID that contextless log calls will be tagged with. */
export function setCurrentEmail(emailId: string): void {
	currentEmailId = emailId;
}

/** Clear the current email context. */
export function clearCurrentEmail(): void {
	currentEmailId = undefined;
}

/** Signal that processing for an email is complete. */
export function emitComplete(emailId: string): void {
	emitter.emit("complete", emailId);
}

/** Get all buffered log entries for an email. */
export function getBufferedLogs(emailId: string): LogEntry[] {
	return emailBuffers.get(emailId) || [];
}

/** Subscribe to log events. Returns an unsubscribe function. */
export function subscribe(
	onLog: (entry: LogEntry) => void,
	onComplete: (emailId: string) => void,
): () => void {
	emitter.on("log", onLog);
	emitter.on("complete", onComplete);
	return () => {
		emitter.off("log", onLog);
		emitter.off("complete", onComplete);
	};
}

/** Clean up buffered logs for an email. */
export function cleanup(emailId: string): void {
	emailBuffers.delete(emailId);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
	const user = ctx.userName || "unknown";
	return `[${user}]`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	const formattedArgs = formatToolArgs(args);
	const msg = `-> ${toolName}: ${label}`;
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ${msg}`));
	if (formattedArgs) {
		const indented = formattedArgs
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
	emit("tool", formattedArgs ? `${msg}\n${formattedArgs}` : msg, ctx.emailId);
}

export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	const msg = `ok ${toolName} (${duration}s)`;
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ${msg}`));

	const truncated = truncate(result, 1000);
	if (truncated) {
		const indented = truncated
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
	emit("tool", truncated ? `${msg}\n${truncated}` : msg, ctx.emailId);
}

export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	const msg = `ERR ${toolName} (${duration}s)`;
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ${msg}`));

	const truncated = truncate(error, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
	emit("tool", `${msg}\n${truncated}`, ctx.emailId);
}

// ---------------------------------------------------------------------------
// Email events
// ---------------------------------------------------------------------------

export function logEmailReceived(from: string, subject: string): void {
	const msg = `Received from ${from}: ${subject}`;
	console.log(chalk.green(`${timestamp()} [email] ${msg}`));
	emit("email", msg);
}

export function logEmailProcessing(from: string, subject: string): void {
	const msg = `Processing from ${from}: ${subject}`;
	console.log(chalk.blue(`${timestamp()} [email] ${msg}`));
	emit("email", msg);
}

export function logEmailReply(to: string, subject: string): void {
	const msg = `Reply sent to ${to}: ${subject}`;
	console.log(chalk.green(`${timestamp()} [email] ${msg}`));
	emit("email", msg);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function logInfo(message: string): void {
	console.log(chalk.blue(`${timestamp()} [system] ${message}`));
	emit("info", message);
}

export function logWarning(message: string, details?: string): void {
	console.log(chalk.yellow(`${timestamp()} [system] WARNING ${message}`));
	if (details) {
		const indented = details
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
	emit("warning", details ? `${message}\n${details}` : message);
}

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------

export function logUsageSummary(
	ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
	contextTokens?: number,
	contextWindow?: number,
): string {
	const lines: string[] = [];
	lines.push("Usage Summary");
	lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`);
	}
	lines.push(`Total cost: $${usage.cost.total.toFixed(4)}`);

	const summary = lines.join("\n");

	const shortSummary = `${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out = $${usage.cost.total.toFixed(4)}`;
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} Usage`));
	console.log(chalk.dim(`           ${shortSummary}`));

	emit("usage", shortSummary, ctx.emailId);

	return summary;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function logStartup(workingDir: string, sandbox: string): void {
	console.log("Starting mom email assistant...");
	console.log(`  Working directory: ${workingDir}`);
	console.log(`  Sandbox: ${sandbox}`);
}

export function logConnected(): void {
	console.log("Email assistant running and listening for webhooks!");
	console.log("");
}
