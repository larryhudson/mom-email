import { type IncomingMessage, type ServerResponse } from "http";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "mom-email";
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

// ============================================================================
// Helpers
// ============================================================================

function parseCookies(header: string): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const [key, ...rest] = pair.split("=");
		if (key) cookies[key.trim()] = rest.join("=").trim();
	}
	return cookies;
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================================
// Journal access
// ============================================================================

interface LogEntry {
	timestamp: string;
	message: string;
}

async function fetchJournalEntries(afterCursor?: string, n?: number): Promise<{ entries: LogEntry[]; cursor: string }> {
	const args = ["-u", SERVICE_NAME, "-o", "json", "--no-pager"];
	if (afterCursor) {
		args.push("--after-cursor=" + afterCursor);
	} else {
		args.push("-n", String(n || 500));
	}

	try {
		const { stdout } = await execFileAsync("journalctl", args, { maxBuffer: MAX_BUFFER });
		const lines = stdout.trim().split("\n").filter(Boolean);
		const entries: LogEntry[] = [];
		let cursor = afterCursor || "";

		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				const usec = parseInt(obj.__REALTIME_TIMESTAMP, 10);
				const ts = isNaN(usec) ? new Date().toISOString() : new Date(usec / 1000).toISOString();
				const message = stripAnsi(obj.MESSAGE || "");
				if (message) {
					entries.push({ timestamp: ts, message });
				}
				if (obj.__CURSOR) cursor = obj.__CURSOR;
			} catch {
				// skip malformed lines
			}
		}

		return { entries, cursor };
	} catch (err: any) {
		if (err.code === "ENOENT") {
			throw new Error("journalctl not found on this system");
		}
		// journalctl may exit non-zero with no output (e.g. no matching entries)
		return { entries: [], cursor: afterCursor || "" };
	}
}

// ============================================================================
// Route handler
// ============================================================================

export function handleLogRequest(
	req: IncomingMessage,
	res: ServerResponse,
	workspaceToken?: string,
): boolean {
	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

	// Auth check (same mechanism as workspace browser)
	if (workspaceToken) {
		const queryToken = url.searchParams.get("token");
		const cookies = parseCookies(req.headers.cookie || "");
		const cookieToken = cookies["workspace_token"];

		if (queryToken === workspaceToken) {
			url.searchParams.delete("token");
			const cleanPath = url.pathname + (url.search || "");
			res.writeHead(302, {
				Location: cleanPath,
				"Set-Cookie": `workspace_token=${workspaceToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
			});
			res.end();
			return true;
		}

		if (cookieToken !== workspaceToken) {
			res.writeHead(401, { "Content-Type": "text/plain" });
			res.end("Unauthorized \u2014 append ?token=YOUR_TOKEN to access the logs");
			return true;
		}
	}

	if (url.pathname === "/logs/api/entries" && req.method === "GET") {
		const afterCursor = url.searchParams.get("after") || undefined;
		const n = parseInt(url.searchParams.get("n") || "500", 10);
		serveEntries(res, afterCursor, n);
		return true;
	}

	// Any other /logs path serves the HTML page
	serveHtml(res);
	return true;
}

// ============================================================================
// Handlers
// ============================================================================

async function serveEntries(res: ServerResponse, afterCursor?: string, n?: number): Promise<void> {
	try {
		const result = await fetchJournalEntries(afterCursor, n);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(result));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: msg, entries: [], cursor: "" }));
	}
}

function serveHtml(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(HTML_PAGE);
}

// ============================================================================
// HTML page (self-contained)
// ============================================================================

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application Logs</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1e1e1e;
    color: #d4d4d4;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  #header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: #252526;
    border-bottom: 1px solid #3c3c3c;
    flex-shrink: 0;
  }

  #header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  #header h1 {
    font-size: 13px;
    font-weight: 600;
    color: #ccc;
  }

  #header nav a {
    font-size: 11px;
    color: #569cd6;
    text-decoration: none;
  }

  #header nav a:hover { text-decoration: underline; }

  #status {
    font-size: 11px;
    color: #888;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot.connected { background: #4ec9b0; }
  .dot.error { background: #f44747; }
  .dot.paused { background: #dcdcaa; }

  #log-container {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  #log-content {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.5;
    padding: 0 16px;
  }

  .log-line {
    white-space: pre-wrap;
    word-wrap: break-word;
    padding: 1px 0;
  }

  .log-ts {
    color: #6a9955;
    user-select: none;
  }

  .log-msg {}

  #empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #555;
    font-size: 14px;
  }
</style>
</head>
<body>
<div id="header">
  <div id="header-left">
    <h1>Application Logs</h1>
    <nav><a href="/workspace">Workspace</a></nav>
  </div>
  <div id="status"><span class="dot connected"></span><span id="status-text">Connecting...</span></div>
</div>
<div id="log-container">
  <div id="log-content">
    <div id="empty-state">Loading logs...</div>
  </div>
</div>

<script>
const logContent = document.getElementById("log-content");
const logContainer = document.getElementById("log-container");
const statusText = document.getElementById("status-text");
const statusDot = document.querySelector(".dot");
const emptyState = document.getElementById("empty-state");

let cursor = "";
let autoScroll = true;
let connected = true;
let lineCount = 0;
const MAX_LINES = 5000;

logContainer.addEventListener("scroll", () => {
  const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 50;
  autoScroll = atBottom;
  updateStatus();
});

function updateStatus() {
  if (!connected) {
    statusDot.className = "dot error";
    statusText.textContent = "Disconnected";
  } else if (!autoScroll) {
    statusDot.className = "dot paused";
    statusText.textContent = "Scroll paused";
  } else {
    statusDot.className = "dot connected";
    statusText.textContent = "Streaming";
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return hh + ":" + mm + ":" + ss + "." + ms;
}

function appendEntries(entries) {
  if (entries.length === 0) return;

  // Remove empty state on first entries
  if (emptyState && emptyState.parentNode) {
    emptyState.parentNode.removeChild(emptyState);
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const line = document.createElement("div");
    line.className = "log-line";

    const ts = document.createElement("span");
    ts.className = "log-ts";
    ts.textContent = formatTime(entry.timestamp);

    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = " " + entry.message;

    line.appendChild(ts);
    line.appendChild(msg);
    fragment.appendChild(line);
    lineCount++;
  }

  logContent.appendChild(fragment);

  // Prune oldest lines if over limit
  while (lineCount > MAX_LINES) {
    const first = logContent.querySelector(".log-line");
    if (!first) break;
    logContent.removeChild(first);
    lineCount--;
  }

  if (autoScroll) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

async function fetchEntries() {
  try {
    const params = cursor
      ? "?after=" + encodeURIComponent(cursor)
      : "?n=1000";
    const res = await fetch("/logs/api/entries" + params);
    const data = await res.json();

    if (data.error) {
      console.error("Log error:", data.error);
      connected = false;
      updateStatus();
      return;
    }

    if (data.cursor) cursor = data.cursor;
    appendEntries(data.entries);
    connected = true;
  } catch (err) {
    console.error("Fetch failed:", err);
    connected = false;
  }
  updateStatus();
}

// Initial load then poll every 2s
fetchEntries().then(() => {
  setInterval(fetchEntries, 2000);
});
</script>
</body>
</html>`;
