/**
 * Figma bridge — local pipeline from the Figma desktop plugin to agents.
 *
 *   Figma dev plugin ──POST /api/design-tree──▶ every frame stored to
 *   frames/<id>.json (never overwritten by later sends, so agents can
 *   fetch any frame at any time without re-sending) plus
 *   /api/page-index for the top-level frame map of the current page.
 *
 * Agents read frames either via HTTP (GET endpoints below) or directly
 * from frames/*.json on disk. The MCP tools are optional — the bridge
 * also works standalone with plain curl.
 *
 * Port: 3001 by default. For development/testing without disturbing a
 * running shared instance, start with BRIDGE_PORT=3002 (or any free
 * port) — the plugin must then be pointed at the same port.
 */

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 3001;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.join(ROOT, "frames");

fs.mkdirSync(FRAMES_DIR, { recursive: true });

/** Figma node ids contain colons ("247:448") — safe filenames only. */
function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function frameFile(id: string): string {
  return path.join(FRAMES_DIR, `${safeId(id)}.json`);
}

interface FrameSummary {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  file: string;
  receivedAt: string;
}

function summarize(file: string): FrameSummary {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    width: raw.width,
    height: raw.height,
    file: path.basename(file),
    receivedAt: fs.statSync(file).mtime.toISOString(),
  };
}

function listFrames(): FrameSummary[] {
  return fs
    .readdirSync(FRAMES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("page-index"))
    .map((f) => summarize(path.join(FRAMES_DIR, f)));
}

function readFrame(id: string): unknown | null {
  const file = frameFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// Pull mode: agent-initiated commands, executed by the open Figma plugin.
//
//   agent:  POST /api/agent/commands {type: "page-index"|"frame"|"selection"}
//   plugin: polls GET /api/agent/commands/pending every ~1.5s (heartbeat),
//           executes the command in Figma, POSTs the result
//   agent:  GET /api/agent/commands/:id until status is success/error/timeout
//
// Frame/selection results are also persisted to frames/ like manual sends,
// so every fetched design stays on disk afterwards.
// ---------------------------------------------------------------------------

interface AgentCommand {
  id: string;
  type: "page-index" | "frame" | "selection";
  params: any;
  status: "pending" | "delivered" | "success" | "error" | "timeout";
  result?: any;
  error?: string;
  createdAt: number;
}

const commands = new Map<string, AgentCommand>();
let cmdCounter = 0;
let lastPluginSeen = 0;
const COMMAND_TIMEOUT_MS = 20_000;

function sweepStale(): void {
  const now = Date.now();
  for (const c of commands.values()) {
    if ((c.status === "pending" || c.status === "delivered") && now - c.createdAt > COMMAND_TIMEOUT_MS) {
      c.status = "timeout";
      c.error = "plugin did not respond in time — is the plugin open in Figma?";
    }
  }
}

function createCommand(type: string, params: any): AgentCommand | null {
  if (!["page-index", "frame", "selection"].includes(type)) return null;
  if (type === "frame" && !params?.id) return null;
  const id = `cmd_${Date.now()}_${++cmdCounter}`;
  // `type` is validated above, but TS can't narrow through .includes()
  const cmd: AgentCommand = { id, type: type as AgentCommand["type"], params: params ?? {}, status: "pending", createdAt: Date.now() };
  commands.set(id, cmd);
  console.log(`[bridge] command queued: ${type}${params?.id ? ` ${params.id}` : ""} (${id})`);
  return cmd;
}

function persistResult(cmd: AgentCommand, payload: any): void {
  const frames = Array.isArray(payload) ? payload : payload?.id ? [payload] : [];
  for (const f of frames) {
    if (f?.id) fs.writeFileSync(frameFile(f.id), JSON.stringify(f, null, 2));
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", frames: listFrames().length, pluginConnected: Date.now() - lastPluginSeen < 5000 });
});

/** Agent → plugin: queue a command for the open plugin. */
app.post("/api/agent/commands", (req, res) => {
  const cmd = createCommand(req.body?.type, req.body);
  if (cmd === null) {
    res.status(400).json({ error: 'body must be {type: "page-index"|"selection"} or {type: "frame", id: "<figma-node-id>"}' });
    return;
  }
  res.json({ requestId: cmd.id, status: cmd.status });
});

/** Plugin polls here — returns the oldest pending command (and marks it delivered). */
app.get("/api/agent/commands/pending", (_req, res) => {
  lastPluginSeen = Date.now();
  sweepStale();
  const next = [...commands.values()].find((c) => c.status === "pending");
  if (next) next.status = "delivered";
  res.json({ command: next ?? null });
});

/** Plugin → bridge: deliver the result of a command. */
app.post("/api/agent/commands/:id/result", (req, res) => {
  const cmd = commands.get(req.params.id);
  if (!cmd) {
    res.status(404).json({ error: "unknown command" });
    return;
  }
  if (req.body?.error) {
    cmd.status = "error";
    cmd.error = String(req.body.error);
    console.log(`[bridge] command failed: ${cmd.type} — ${cmd.error}`);
  } else {
    cmd.status = "success";
    cmd.result = req.body?.payload;
    persistResult(cmd, cmd.result);
    console.log(`[bridge] command done: ${cmd.type} (${cmd.id})`);
  }
  res.json({ status: "ok" });
});

/** Agent polls here for the outcome of a command. */
app.get("/api/agent/commands/:id", (req, res) => {
  const cmd = commands.get(req.params.id);
  if (!cmd) {
    res.status(404).json({ error: "unknown command" });
    return;
  }
  sweepStale();
  res.json({ requestId: cmd.id, type: cmd.type, status: cmd.status, result: cmd.result, error: cmd.error });
});

/** Agent checks whether the plugin is currently open and polling. */
app.get("/api/agent/status", (_req, res) => {
  sweepStale();
  res.json({
    pluginConnected: Date.now() - lastPluginSeen < 5000,
    lastPluginSeen: lastPluginSeen ? new Date(lastPluginSeen).toISOString() : null,
  });
});

/** From the plugin: one frame, several frames ({frames: [...]}) or an array. */
app.post("/api/design-tree", (req, res) => {
  const body = req.body ?? {};
  const frames = Array.isArray(body) ? body : body.frames ?? (body.id ? [body] : []);
  if (!frames.length) {
    res.status(400).json({ error: "no frames in payload" });
    return;
  }
  const saved = frames.map((f: any) => {
    fs.writeFileSync(frameFile(f.id), JSON.stringify(f, null, 2));
    return { id: f.id, name: f.name, file: `${safeId(f.id)}.json` };
  });
  console.log(`[bridge] stored ${saved.length} frame(s): ${saved.map((s: any) => s.name).join(", ")}`);
  res.json({ status: "success", saved });
});

/** All frames received so far (the index — what the agent lists first). */
app.get("/api/frames", (_req, res) => {
  res.json({ frames: listFrames() });
});

/** One full frame tree by Figma node id. */
app.get("/api/frames/:id", (req, res) => {
  const frame = readFrame(req.params.id);
  if (frame === null) {
    res.status(404).json({ error: "frame not received yet — send it from the plugin" });
    return;
  }
  res.json(frame);
});

/** Most recently stored frame (compat with the "latest frame" workflow). */
app.get("/api/latest", (_req, res) => {
  const all = listFrames().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  if (!all.length) {
    res.status(404).json({ error: "nothing received yet" });
    return;
  }
  res.redirect(`/api/frames/${encodeURIComponent(all[0].id)}`);
});

/** From the plugin: top-level frames of the current page (name/id map). */
app.post("/api/page-index", (req, res) => {
  const body = { pageName: req.body?.pageName ?? "unknown", frames: req.body?.frames ?? [], receivedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(FRAMES_DIR, "page-index.json"), JSON.stringify(body, null, 2));
  console.log(`[bridge] page index "${body.pageName}": ${body.frames.length} top-level frame(s)`);
  res.json({ status: "success" });
});

app.get("/api/page-index", (_req, res) => {
  const file = path.join(FRAMES_DIR, "page-index.json");
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "no page index received yet" });
    return;
  }
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

app.listen(PORT, () => {
  console.log(`Figma Bridge active on port ${PORT} (storing to ${FRAMES_DIR})`);
});

// ---------------------------------------------------------------------------
// Optional MCP tools (stdio) — registered when spawned by an MCP client.
// ---------------------------------------------------------------------------

const mcpServer = new Server({ name: "figma-local-bridge", version: "1.0.0" },
                              { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_figma_frames",
      description: "All frames received from the Figma plugin so far (id, name, size, when).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_figma_frame",
      description: "The full JSON design tree of one frame, by its Figma node id (e.g. '247:448').",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Figma node id" } },
        required: ["id"],
      },
    },
    {
      name: "get_latest_figma_frame",
      description: "The JSON layout tree of the most recently sent frame (legacy name kept for compatibility).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "request_from_figma",
      description:
        "Ask the open Figma plugin for fresh data on demand: type 'page-index' (top-level frames of the current page), 'frame' (full design tree by node id, e.g. '247:448'), or 'selection' (whatever is selected right now). Requires the plugin open in Figma.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["page-index", "frame", "selection"], description: "What to fetch" },
          id: { type: "string", description: "Figma node id — required for type 'frame'" },
        },
        required: ["type"],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list_figma_frames") {
    return { content: [{ type: "text", text: JSON.stringify(listFrames(), null, 2) }] };
  }
  if (request.params.name === "get_figma_frame") {
    const id = String((request.params.arguments as any)?.id ?? "");
    const frame = readFrame(id);
    if (frame === null) {
      return { content: [{ type: "text", text: `Frame ${id} not received yet. Send it from the Figma plugin.` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(frame) }] };
  }
  if (request.params.name === "get_latest_figma_frame") {
    const all = listFrames().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    if (!all.length) {
      return { content: [{ type: "text", text: "No frame received yet. Trigger export from Figma plugin." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(readFrame(all[0].id)) }] };
  }
  if (request.params.name === "request_from_figma") {
    const args = (request.params.arguments as any) ?? {};
    const cmd = createCommand(args.type, args);
    if (cmd === null) {
      return { content: [{ type: "text", text: "Invalid request — need {type:'page-index'|'selection'} or {type:'frame', id:'...'}" }] };
    }
    // wait for the plugin to pick it up and deliver (poll like the HTTP agent flow)
    const start = Date.now();
    for (;;) {
      const c = commands.get(cmd.id);
      if (!c) break;
      if (c.status === "success") return { content: [{ type: "text", text: JSON.stringify(c.result) }] };
      if (c.status === "error" || c.status === "timeout") {
        return { content: [{ type: "text", text: `Command failed: ${c.error}` }] };
      }
      if (Date.now() - start > 25000) {
        c.status = "timeout";
        c.error = "plugin did not respond in time — is the plugin open in Figma?";
        return { content: [{ type: "text", text: `Command timed out: ${c.error}` }] };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((e) => console.error("[mcp]", e));
