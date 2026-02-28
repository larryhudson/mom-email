import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { StoredEmail } from "./email-store.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

// Hardcoded model for now
const model = getModel("anthropic", "claude-sonnet-4-5");

export interface AgentRunResult {
	replyText: string;
	attachments: string[];  // file paths collected via attach tool
	stopReason: string;
	errorMessage?: string;
}

export interface AgentContext {
	triggeredEmail: StoredEmail;
	recentEmails: StoredEmail[];
}

async function getAnthropicApiKey(authStorage: AuthStorage): Promise<string> {
	const key = await authStorage.getApiKey("anthropic");
	if (!key) {
		throw new Error(
			"No API key found for anthropic.\n\n" +
				"Set ANTHROPIC_API_KEY environment variable, or use /login with Anthropic and link to auth.json from " +
				join(homedir(), ".pi", "mom", "auth.json"),
		);
	}
	return key;
}

function getMemory(workingDir: string): string {
	const memoryPath = join(workingDir, "MEMORY.md");
	if (existsSync(memoryPath)) {
		try {
			const content = readFileSync(memoryPath, "utf-8").trim();
			if (content) return content;
		} catch (error) {
			log.logWarning("Failed to read memory", `${memoryPath}: ${error}`);
		}
	}
	return "(no working memory yet)";
}

function loadSkills(workingDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(workingDir)) {
			return workspacePath + hostPath.slice(workingDir.length);
		}
		return hostPath;
	};

	const skillsDir = join(workingDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: skillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	skills: Skill[],
	triggerPhrase: string,
): string {
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are an email assistant powered by Claude. Be concise. No emojis.

## How You Work
- You receive emails that contain "${triggerPhrase}" in the body.
- You process the email, use tools as needed, and compose a plain text reply.
- Your final text response becomes the email reply sent back to the sender.
- Each invocation is a fresh session -- you have no memory of previous sessions except through MEMORY.md and the email archive.

## Context
- For current date/time, use: date
- You have access to recent email context provided with each trigger email.
- For older email history, read the index at \`${workspacePath}/emails/index.jsonl\` and individual emails in \`${workspacePath}/emails/inbox/\`.

## Email Formatting
Your reply will be sent as plain text email. Use plain text formatting:
- No HTML tags
- Use simple text formatting (dashes for lists, indentation for structure)
- Keep responses concise and email-appropriate

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Persistent memory across sessions
├── settings.json                # Configuration
├── skills/                      # Custom CLI tools you create
├── events/                      # Scheduled event JSON files
├── scratch/                     # Your working directory
└── emails/
    ├── inbox/                   # Stored emails as JSON
    ├── attachments/             # Email attachments
    └── index.jsonl              # Email index for fast search

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks.

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` with a \`SKILL.md\` containing YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file.
\`\`\`json
{"type": "immediate", "text": "New activity detected"}
\`\`\`

**One-shot** - Triggers once at a specific time.
\`\`\`json
{"type": "one-shot", "text": "Reminder: check inbox", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule.
\`\`\`json
{"type": "periodic", "text": "Daily summary", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30

### Timezones
All \`at\` timestamps must include offset. Periodic events use IANA timezone names. Harness timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
\`\`\`bash
cat > ${workspacePath}/events/reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This suppresses the email reply.

### Debouncing
When writing programs that create immediate events, always debounce. Use a periodic event to check for new items every N minutes instead of per-item immediate events.

### Limits
Maximum 5 events can be queued.

## Memory
Write to MEMORY.md to persist context across sessions.
- \`${workspacePath}/MEMORY.md\`: preferences, project info, ongoing work, contact info
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Attach files to your email reply
Each tool requires a "label" parameter (shown in session log).
`;
}

function formatEmailForPrompt(email: StoredEmail): string {
	const parts: string[] = [
		`From: ${email.from}`,
		`Subject: ${email.subject}`,
		`Date: ${email.date}`,
		`ID: ${email.id}`,
	];
	if (email.attachments.length > 0) {
		parts.push(`Attachments: ${email.attachments.map((a) => a.filename).join(", ")}`);
	}
	parts.push("");
	parts.push(email.strippedText || email.bodyPlain);
	return parts.join("\n");
}

/**
 * Run the agent for a single triggered email.
 * Creates a fresh session, processes the email, and returns the reply.
 */
export async function runAgent(
	sandboxConfig: SandboxConfig,
	workingDir: string,
	context: AgentContext,
	triggerPhrase: string,
): Promise<AgentRunResult> {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(workingDir);

	// Create tools
	const tools = createMomTools(executor);

	// Collect attachments from the attach tool
	const collectedAttachments: string[] = [];
	setUploadFunction(async (filePath: string, _title?: string) => {
		// Translate container path to host path if needed
		const hostPath = translateToHostPath(filePath, workingDir, workspacePath);
		collectedAttachments.push(hostPath);
	});

	// Load memory and skills
	const memory = getMemory(workingDir);
	const skills = loadSkills(workingDir, workspacePath);
	const systemPrompt = buildSystemPrompt(workspacePath, memory, sandboxConfig, skills, triggerPhrase);

	// Create session infrastructure
	const sessionsDir = join(workingDir, "sessions");
	const sessionId = `${Date.now()}_${context.triggeredEmail.id}`;
	const sessionDir = join(sessionsDir, sessionId);
	await mkdir(sessionDir, { recursive: true });

	const contextFile = join(sessionDir, "session.jsonl");
	const sessionManager = SessionManager.open(contextFile, sessionDir);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
	});

	// Auth and model registry
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent (fresh -- no prior messages)
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getAnthropicApiKey(authStorage),
	});

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Track run state
	const runState = {
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};

	const logCtx = { channelId: "email", userName: context.triggeredEmail.from };

	// Subscribe to events for logging
	session.subscribe(async (event) => {
		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;
			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, 0, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, 0, resultStr);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;
				if (assistantMsg.stopReason) runState.stopReason = assistantMsg.stopReason;
				if (assistantMsg.errorMessage) runState.errorMessage = assistantMsg.errorMessage;
				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
		}
	});

	// Build user message with context
	let userMessage = "";

	// Add recent email context
	if (context.recentEmails.length > 0) {
		userMessage += "<recent_emails>\n";
		for (const email of context.recentEmails) {
			userMessage += `--- Email ---\n${formatEmailForPrompt(email)}\n\n`;
		}
		userMessage += "</recent_emails>\n\n";
	}

	// Add the triggered email
	userMessage += "<triggered_email>\n";
	userMessage += formatEmailForPrompt(context.triggeredEmail);
	userMessage += "\n</triggered_email>\n\n";
	userMessage += "Process this email and compose your reply. Your final text response will be sent as the email reply.";

	// Debug: save prompt
	const debugContext = {
		systemPrompt,
		userMessage,
		triggeredEmailId: context.triggeredEmail.id,
		recentEmailCount: context.recentEmails.length,
	};
	await writeFile(join(sessionDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2));

	log.logInfo(`Running agent for email ${context.triggeredEmail.id} from ${context.triggeredEmail.from}`);

	// Run the agent
	await session.prompt(userMessage);

	// Extract final text response
	const messages = session.messages;
	const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
	const replyText =
		lastAssistant?.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n") || "";

	// Log usage
	if (runState.totalUsage.cost.total > 0) {
		log.logUsageSummary(logCtx, runState.totalUsage);
	}

	log.logInfo(`Agent completed for email ${context.triggeredEmail.id}: ${runState.stopReason}`);

	return {
		replyText,
		attachments: collectedAttachments,
		stopReason: runState.stopReason,
		errorMessage: runState.errorMessage,
	};
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) return textParts.join("\n");
	}

	return JSON.stringify(result);
}

function translateToHostPath(containerPath: string, workingDir: string, workspacePath: string): string {
	if (workspacePath === "/workspace") {
		if (containerPath.startsWith("/workspace/")) {
			return join(workingDir, containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
