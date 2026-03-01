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
import { createExecutor, type DockerConfig } from "./sandbox.js";
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
	fromAddress: string;
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
	skills: Skill[],
	triggerPhrase: string,
	fromAddress: string,
): string {
	const envDescription = `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`;

	return `You are an email assistant powered by Claude. Be concise. No emojis.
Your email address is ${fromAddress}. Sign off replies as "Claude", not as the person you're replying to.

## How You Work
- You receive emails that contain "${triggerPhrase}" in the body.
- You process the email, use tools as needed, and compose a plain text reply.
- Your final text response becomes the email reply sent back to the sender -- you can ONLY reply to the person who emailed you.
- Each invocation is a fresh session -- you have no memory of previous sessions except through MEMORY.md, documents/, and the email archive.
- At the start of each session, check \`ls ${workspacePath}/documents/\` for relevant project documents that may provide context.

## Your Capabilities and Limits
You can:
- Run shell commands (bash), read/write/edit files in your workspace
- Search and analyse your email archive (inbox and sent)
- Attach files to your reply (drafts, reports, generated documents)
- Schedule events to wake yourself up later (one-shot or periodic cron)
- Install and use CLI tools (apk add)
- Create scripts and programs that run in your workspace

You CANNOT:
- Send emails to anyone other than the person who emailed you (your reply always goes back to the sender)
- Access external services unless you can reach them via CLI tools (curl, APIs with keys you have, etc.)
- Access the user's calendar, CRM, Google Docs, or other SaaS tools unless there's a CLI/API for it
- Do anything that requires a browser or GUI

Be honest about these limits. If someone asks you to do something you can't, say so and suggest a realistic alternative (e.g. "I can't email James directly, but I can draft the report and attach it to my reply so you can forward it").

## Context
- For current date/time, use: date
- You have access to recent email context provided with each trigger email. Sent emails (your previous replies) are labeled with "(you)" in the From field.
- For older email history, read the index at \`${workspacePath}/emails/index.jsonl\` and individual emails in \`${workspacePath}/emails/inbox/\` (received) or \`${workspacePath}/emails/sent/\` (your replies).

## Email Formatting
Your reply will be sent as plain text email. Use plain text formatting:
- No HTML tags
- Use simple text formatting (dashes for lists, indentation for structure)
- Keep responses concise and email-appropriate
- NEVER reference workspace file paths (like /workspace/...) in your reply -- the recipient cannot access your filesystem and has no idea what your workspace is. If you create a file the user should see (draft, report, template, etc.), use the \`attach\` tool to attach it to the email. Refer to attached files by name, not by path.

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Persistent memory across sessions (quick-reference)
├── documents/                   # Timestamped project documents (YYYY-MM-DD-name.md)
├── settings.json                # Configuration
├── skills/                      # Custom CLI tools you create
├── events/                      # Scheduled event JSON files
├── scratch/                     # Temporary working files
└── emails/
    ├── inbox/                   # Received emails as JSON
    ├── sent/                    # Your sent replies as JSON
    ├── attachments/             # Email attachments
    └── index.jsonl              # Email index for fast search

## Skills (Reusable Processes)
Skills are documented processes you save for reuse. Each skill lives in \`${workspacePath}/skills/<name>/\` with a \`SKILL.md\` file.

### When to Create a Skill
Distinguish between one-off tasks and repeatable processes:
- **One-off task**: "Send James the billing report" -- just do it, no skill needed.
- **Process**: "When I get a new client, I need to send them a welcome email, add them to the CRM, and schedule a follow-up" -- this describes a repeatable process. Create a skill.

Signs someone is describing a process:
- They use words like "when", "whenever", "every time", "the process for", "how to", "steps for"
- They describe multiple steps that happen together
- They're explaining how something should be done in general, not asking for a specific thing right now

### Creating a Skill
When you recognize a process, reality-check each step BEFORE saving:

1. **For each step the user described, ask yourself: can I actually do this with my tools?**
   - If yes: include it as-is
   - If no: adapt it to something you CAN do and note the difference (e.g. "send email to James" becomes "draft the email and attach it to my reply for you to forward")
   - If a step requires a service you can't access (calendar, CRM, etc.), turn it into a reminder or a draft the user can act on

2. **Create the skill** at \`${workspacePath}/skills/<name>/SKILL.md\`:
\`\`\`markdown
---
name: skill-name
description: Concise description of when this skill applies
---

# Skill Name

## Steps
1. First step (what you will actually do)
2. Second step
3. ...

## Notes
- Any context, tools needed, or resolved assumptions
\`\`\`

3. **Execute the process** for the current request if applicable (don't just document it -- do the work too). If the process should run on a schedule, create an event in \`${workspacePath}/events/\` to trigger it automatically (see Events section below).

4. **In your reply**, include:
   - A summary of the process you saved and the steps
   - Be upfront about any steps you adapted and why (e.g. "I can't send directly to James, so I'll draft the report and attach it for you to forward")
   - Any assumptions you made, phrased as open questions
   - Let them know they can reply to correct or refine the process

### Updating a Skill
When someone replies with corrections or additions to a process you saved:
- Update the existing SKILL.md with the changes
- Confirm what you changed in your reply

### Using Existing Skills
When a request matches an existing skill, follow that skill's documented process. The skill description tells you when it applies.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills saved yet)"}

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
- \`${workspacePath}/MEMORY.md\`: Quick-reference notes -- preferences, project info, ongoing work, contact info. Update when you learn something important or when asked to remember something.
- \`${workspacePath}/documents/\`: Longer-form project documents, analysis, and summaries. Use timestamped filenames: \`YYYY-MM-DD-name.md\`. Check \`ls ${workspacePath}/documents/\` when you need context about past work.

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

function formatEmailForPrompt(email: StoredEmail, direction: "received" | "sent"): string {
	const parts: string[] = [];
	if (direction === "sent") {
		parts.push(`From: ${email.from} (you)`);
		parts.push(`To: ${email.to}`);
	} else {
		parts.push(`From: ${email.from}`);
	}
	parts.push(`Subject: ${email.subject}`);
	parts.push(`Date: ${email.date}`);
	parts.push(`ID: ${email.id}`);
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
	dockerConfig: DockerConfig,
	workingDir: string,
	context: AgentContext,
	triggerPhrase: string,
): Promise<AgentRunResult> {
	const executor = createExecutor(dockerConfig);
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
	const systemPrompt = buildSystemPrompt(workspacePath, memory, skills, triggerPhrase, context.fromAddress);

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
			const direction = email.from === context.fromAddress ? "sent" : "received";
			userMessage += `--- Email ---\n${formatEmailForPrompt(email, direction)}\n\n`;
		}
		userMessage += "</recent_emails>\n\n";
	}

	// Add the triggered email
	userMessage += "<triggered_email>\n";
	userMessage += formatEmailForPrompt(context.triggeredEmail, "received");
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
