import { type IncomingMessage, type ServerResponse } from "http";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";

// ============================================================================
// Types
// ============================================================================

interface TreeEntry {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: TreeEntry[];
}

// ============================================================================
// File tree
// ============================================================================

function parseCookies(header: string): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const [key, ...rest] = pair.split("=");
		if (key) cookies[key.trim()] = rest.join("=").trim();
	}
	return cookies;
}

const IGNORED = new Set(["node_modules", ".git", "__pycache__", ".DS_Store"]);

async function buildTree(root: string, dir: string): Promise<TreeEntry[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const result: TreeEntry[] = [];

	// Sort: directories first, then alphabetical
	const sorted = entries
		.filter((e) => !IGNORED.has(e.name))
		.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

	for (const entry of sorted) {
		const fullPath = join(dir, entry.name);
		const relPath = relative(root, fullPath);

		if (entry.isDirectory()) {
			const children = await buildTree(root, fullPath);
			result.push({ name: entry.name, path: relPath, type: "directory", children });
		} else {
			result.push({ name: entry.name, path: relPath, type: "file" });
		}
	}

	return result;
}

// ============================================================================
// Route handler
// ============================================================================

export function handleWorkspaceRequest(
	workingDir: string,
	req: IncomingMessage,
	res: ServerResponse,
	workspaceToken?: string,
): boolean {
	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

	// Auth check: if a token is configured, require it
	if (workspaceToken) {
		const queryToken = url.searchParams.get("token");
		const cookies = parseCookies(req.headers.cookie || "");
		const cookieToken = cookies["workspace_token"];

		if (queryToken === workspaceToken) {
			// Valid token in URL — set cookie and redirect to clean URL
			url.searchParams.delete("token");
			const cleanPath = url.pathname + (url.search || "");
			res.writeHead(302, {
				Location: cleanPath,
				"Set-Cookie": `workspace_token=${workspaceToken}; HttpOnly; SameSite=Strict; Path=/workspace; Max-Age=31536000`,
			});
			res.end();
			return true;
		}

		if (cookieToken !== workspaceToken) {
			res.writeHead(401, { "Content-Type": "text/plain" });
			res.end("Unauthorized — append ?token=YOUR_TOKEN to access the workspace");
			return true;
		}
	}

	if (url.pathname === "/workspace/api/tree" && req.method === "GET") {
		serveTree(workingDir, res);
		return true;
	}

	if (url.pathname === "/workspace/api/file" && req.method === "GET") {
		const filePath = url.searchParams.get("path");
		if (!filePath) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Missing ?path= parameter");
		} else {
			serveFile(workingDir, filePath, res);
		}
		return true;
	}

	// Any other /workspace path serves the HTML page (file path is in the URL)
	serveHtml(res);
	return true;
}

// ============================================================================
// Handlers
// ============================================================================

async function serveTree(workingDir: string, res: ServerResponse): Promise<void> {
	try {
		const tree = await buildTree(workingDir, workingDir);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(tree));
	} catch (err) {
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Failed to read directory");
	}
}

async function serveFile(workingDir: string, filePath: string, res: ServerResponse): Promise<void> {
	// Prevent path traversal
	const resolved = join(workingDir, filePath);
	if (!resolved.startsWith(workingDir)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	try {
		const info = await stat(resolved);
		if (!info.isFile()) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Not a file");
			return;
		}

		// Cap at 1MB for the browser viewer
		if (info.size > 1024 * 1024) {
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			const partial = await readFile(resolved, { encoding: "utf-8", flag: "r" });
			res.end(partial.slice(0, 1024 * 1024) + "\n\n--- truncated (file > 1MB) ---");
			return;
		}

		const content = await readFile(resolved, "utf-8");
		res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(content);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("File not found");
		} else {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Failed to read file");
		}
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
<title>Workspace Browser</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    height: 100vh;
    background: #1e1e1e;
    color: #d4d4d4;
  }

  #sidebar {
    width: 280px;
    min-width: 200px;
    background: #252526;
    border-right: 1px solid #3c3c3c;
    overflow-y: auto;
    padding: 8px 0;
    flex-shrink: 0;
  }

  #sidebar h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    padding: 8px 16px;
    user-select: none;
  }

  .tree-item {
    display: flex;
    align-items: center;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
    user-select: none;
  }

  .tree-item:hover { background: #2a2d2e; }
  .tree-item.active { background: #37373d; color: #fff; }

  .tree-item .icon {
    width: 16px;
    text-align: center;
    margin-right: 4px;
    font-size: 12px;
    flex-shrink: 0;
  }

  .tree-item .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dir-children { display: none; }
  .dir-children.open { display: block; }

  #content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #file-path {
    padding: 8px 16px;
    font-size: 12px;
    color: #888;
    background: #1e1e1e;
    border-bottom: 1px solid #3c3c3c;
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  }

  #file-content {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }

  #file-content pre {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    tab-size: 4;
  }

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
<div id="sidebar">
  <h2>Workspace</h2>
  <div id="tree"></div>
</div>
<div id="content">
  <div id="file-path"></div>
  <div id="file-content">
    <div id="empty-state">Select a file to view</div>
  </div>
</div>

<script>
const treeEl = document.getElementById("tree");
const filePathEl = document.getElementById("file-path");
const fileContentEl = document.getElementById("file-content");
let activeItem = null;

function loadTree() {
  return fetch("/workspace/api/tree")
    .then(res => res.json())
    .then(tree => {
      treeEl.innerHTML = "";
      renderTree(tree, treeEl, 0);
    });
}

function renderTree(entries, parent, depth) {
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "tree-item";
    item.style.paddingLeft = (8 + depth * 16) + "px";

    const icon = document.createElement("span");
    icon.className = "icon";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;

    if (entry.type === "directory") {
      icon.textContent = "\\u25b6";
      item.appendChild(icon);
      item.appendChild(name);
      parent.appendChild(item);

      const children = document.createElement("div");
      children.className = "dir-children";
      parent.appendChild(children);

      if (entry.children && entry.children.length > 0) {
        renderTree(entry.children, children, depth + 1);
      }

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = children.classList.toggle("open");
        icon.textContent = isOpen ? "\\u25bc" : "\\u25b6";
      });
    } else {
      icon.textContent = "\\u2022";
      item.appendChild(icon);
      item.appendChild(name);
      parent.appendChild(item);

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        loadFile(entry.path, item);
      });
    }
  }
}

async function loadFile(path, element, pushState) {
  if (activeItem) activeItem.classList.remove("active");
  activeItem = element;
  if (element) element.classList.add("active");

  if (pushState !== false) {
    history.pushState(null, "", "/workspace/" + path);
  }

  filePathEl.textContent = path;
  fileContentEl.innerHTML = "<pre>Loading...</pre>";

  try {
    const res = await fetch("/workspace/api/file?path=" + encodeURIComponent(path));
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.textContent = text;
    fileContentEl.innerHTML = "";
    fileContentEl.appendChild(pre);
  } catch (err) {
    fileContentEl.innerHTML = "<pre>Error loading file</pre>";
  }
}

// Get initial file path from URL (everything after /workspace/)
function getInitialPath() {
  const prefix = "/workspace/";
  const path = decodeURIComponent(window.location.pathname);
  if (path.length > prefix.length) {
    return path.slice(prefix.length);
  }
  return null;
}

// After tree loads, expand parents and select the file matching the URL
function selectFileInTree(targetPath) {
  if (!targetPath) return;
  const parts = targetPath.split("/");

  // Walk the tree DOM, expanding directories along the path
  let container = treeEl;
  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];
    const isLast = i === parts.length - 1;
    const items = container.querySelectorAll(":scope > .tree-item");

    for (const item of items) {
      const nameEl = item.querySelector(".name");
      if (nameEl && nameEl.textContent === segment) {
        if (isLast) {
          // This is the file — click it
          loadFile(targetPath, item, false);
        } else {
          // This is a directory — expand it
          const iconEl = item.querySelector(".icon");
          const childrenDiv = item.nextElementSibling;
          if (childrenDiv && childrenDiv.classList.contains("dir-children")) {
            childrenDiv.classList.add("open");
            if (iconEl) iconEl.textContent = "\\u25bc";
            container = childrenDiv;
          }
        }
        break;
      }
    }
  }
}

// Handle browser back/forward
window.addEventListener("popstate", () => {
  const path = getInitialPath();
  if (path) {
    selectFileInTree(path);
  }
});

loadTree().then(() => {
  const initialPath = getInitialPath();
  if (initialPath) selectFileInTree(initialPath);
});
</script>
</body>
</html>`;
