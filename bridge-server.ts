/**
 * Figma Agent bridge v3 — local, loopback-only replacement for the parts of
 * api.figma.com that agents actually use.
 *
 *   Figma plugin (Figma Agent) ──POST /api/design-tree──▶ store/<fileKey>/
 *   · push mode: plugin buttons            frames/<id>.json (REST-shaped)
 *   · pull mode: agent queues a command    pages.json (CANVAS structure)
 *     (page-index | frame | selection |    assets/<id>.<ext> (exports)
 *      export) — the open plugin long-
 *     polls for it and executes
 *
 * REST-parity routes (drop-in for api.figma.com clients):
 *   GET /v1/me · /v1/files/:key (?ids,&depth,&fresh=1)
 *   GET /v1/files/:key/nodes?ids=… (tree at nodes[id].document)
 *   GET /v1/images/:key?ids=…&format=&scale= · /v1/files/:key/components|styles
 *   GET /assets/:key/:file
 *
 * Legacy agent routes (/api/*) and MCP tools are kept and additive.
 *
 * Security posture (agent.md §8.1):
 *   · binds 127.0.0.1 only (BRIDGE_HOST to override — never do remotely)
 *   · Host-header allowlist (blocks DNS rebinding)
 *   · CORS allows the Figma plugin iframe (Origin: null) + loopback pages
 *   · Authorization: Bearer / X-Figma-Token accepted and intentionally NOT
 *     validated — SDK clients send one; rejecting breaks drop-in use
 *
 * Ports: 3002 by default (this repo is the dev instance; production 3001
 * runs from a separate legacy copy and must never be touched).
 */

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  buildFileEnvelope,
  buildNodesResponse,
  frameFileName,
  type StoredFrame,
  type StoredPageIndex,
} from "./lib/stitch.js";
import { parseFontMetricsTable, rewriteFontMetrics } from "./lib/font-metrics.js";
import {
  collectUnresolvedStyles,
  loadLibraryIndex,
  rewriteFrameStyles,
  writeLibraryHarvest,
} from "./lib/library-harvest.js";

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1"; // numeric literal — never '0.0.0.0'
const PORT = Number(process.env.BRIDGE_PORT ?? 3002);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(ROOT, "store");

/**
 * Round 2 (C1/C3/C4) — corpus-bootstrapped font metrics, built by
 * tools/build-font-metrics.ts. Applied at persist time (lib/font-metrics.ts);
 * null when the table is absent (rewriting simply disabled).
 */
const FONT_METRICS = parseFontMetricsTable(
  (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(STORE_DIR, "font-metrics.json"), "utf8"));
    } catch {
      return null;
    }
  })(),
);

/**
 * Round 4 (G1) — harvested library styles, keyed by 40-hex publish key.
 * `store/libraries/*.json` is written whenever a `page-index` command runs
 * inside a library file (the plugin enumerates that file's local styles);
 * consumer frames are rewritten against this join table at persist time.
 */
const LIBRARIES_DIR = path.join(STORE_DIR, "libraries");
let LIB_INDEX = loadLibraryIndex(LIBRARIES_DIR);

class BridgeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Disk store v2 — keyed by the real Figma file key (figma.fileKey), with a
// stable fallback for local-only files.
//
//   store/<fileKey>/pages.json        CANVAS structure (all pages)
//   store/<fileKey>/frames/<id>.json  REST-shaped frame payloads
//   store/<fileKey>/assets/<id>.<ext> exported images (PNG/SVG/…)
// ---------------------------------------------------------------------------

/** File keys and node ids contain ":" — filename-safe, reversible. */
function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function storeDir(key: string): string {
  return path.join(STORE_DIR, safeId(key));
}

function framesDirFor(key: string): string {
  return path.join(storeDir(key), "frames");
}

function touchMeta(key: string): void {
  const dir = storeDir(key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "meta.json");
  const meta = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  meta.fileKey = key;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
}

function savePageIndex(payload: StoredPageIndex & Record<string, unknown>): void {
  if (!payload?.fileKey) throw new BridgeError(400, "page-index payload missing fileKey");
  const dir = storeDir(payload.fileKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify(payload, null, 2));
  // Round 4 harvest: a page-index run inside ANY file records that file's
  // local styles as a library join table. Inside a library file this is the
  // key→nodeId mapping REST's consumer-side output is keyed by.
  if (payload.styles && typeof payload.styles === "object") {
    const harvest = writeLibraryHarvest(LIBRARIES_DIR, payload.fileKey, payload.styles as Record<string, any>);
    if (harvest) {
      LIB_INDEX = loadLibraryIndex(LIBRARIES_DIR);
      console.log(
        `[bridge] library harvest: ${payload.fileKey} — ${Object.keys(harvest.styles).length} styles`,
      );
    }
  }
  touchMeta(payload.fileKey);
}

/**
 * Round 2 (C1/C3/C4) — rewrite text-style font metrics from the corpus table.
 *
 * The plugin can only estimate intrinsic line heights (height ÷ lines) and
 * cannot see server-side font metrics at all: REST's INTRINSIC lineHeightPx,
 * PIXELS lineHeightPercent and named fontPostScriptName values are all
 * computed from real font data. They are pure per-family functions
 * (corpus-validated, see tools/build-font-metrics.ts), so the bridge
 * rewrites them at persist time — plugin output stays untouched.
 */
function applyFontMetrics(f: any): void {
  if (FONT_METRICS) rewriteFontMetrics(f, FONT_METRICS);
}

/**
 * Round 4 (G1) — resolve remote (library) style ids to the defining
 * library file's node ids via the harvest join table. The unresolved-style
 * report is refreshed by saveFrame after the frame hits disk (it reads the
 * whole stored file, including the frame just saved).
 */
function applyLibraryStyles(f: any): void {
  rewriteFrameStyles(f, LIB_INDEX);
}

/** Rebuild store/<fileKey>/unresolved-library-styles.json from stored frames. */
function refreshUnresolvedReport(key: string): void {
  const frames = listFramesForFile(key);
  const unresolved = collectUnresolvedStyles(frames, LIB_INDEX);
  const report = { fileKey: key, generatedAt: new Date().toISOString(), styles: unresolved };
  fs.writeFileSync(
    path.join(storeDir(key), "unresolved-library-styles.json"),
    JSON.stringify(report, null, 2),
  );
}

function saveFrame(f: any): { id: string; name: string; file: string } {
  const key = f?.fileKey ?? "default";
  const dir = framesDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  applyFontMetrics(f);
  applyLibraryStyles(f);
  const file = path.join(dir, `${frameFileName(f.id)}.json`);
  fs.writeFileSync(file, JSON.stringify(f, null, 2));
  touchMeta(key);
  refreshUnresolvedReport(key);
  return { id: f.id, name: f.name, file: path.basename(file) };
}

function getPages(key: string): StoredPageIndex | null {
  const file = path.join(storeDir(key), "pages.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFramesForFile(key: string, only?: string[]): StoredFrame[] {
  const dir = framesDirFor(key);
  if (!fs.existsSync(dir)) return [];
  const wanted = only ? new Set(only) : null;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as StoredFrame)
    .filter((f) => !wanted || wanted.has(f.id));
}

interface FrameSummary {
  id: string;
  name: string;
  fileKey: string;
  file: string;
  receivedAt: string;
}

function listAllFrames(): FrameSummary[] {
  if (!fs.existsSync(STORE_DIR)) return [];
  const out: FrameSummary[] = [];
  for (const key of fs.readdirSync(STORE_DIR)) {
    const dir = framesDirFor(key);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(dir, f);
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      out.push({
        id: raw.id,
        name: raw.name,
        fileKey: key,
        file: f,
        receivedAt: fs.statSync(full).mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

function readFrame(id: string): StoredFrame | null {
  for (const s of listAllFrames()) {
    if (s.id === id) {
      return JSON.parse(fs.readFileSync(path.join(framesDirFor(s.fileKey), s.file), "utf8"));
    }
  }
  return null;
}

function latestPageIndex(): StoredPageIndex | null {
  if (!fs.existsSync(STORE_DIR)) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const key of fs.readdirSync(STORE_DIR)) {
    const file = path.join(storeDir(key), "pages.json");
    if (fs.existsSync(file)) {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }
  return best ? JSON.parse(fs.readFileSync(best.file, "utf8")) : null;
}

// ---------------------------------------------------------------------------
// Command queue — agent asks, the open plugin executes (long-polled).
// ---------------------------------------------------------------------------

type CommandType = "page-index" | "frame" | "selection" | "export" | "probe";

interface AgentCommand {
  id: string;
  type: CommandType;
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
const LONG_POLL_MS = 10_000;

function pluginConnected(): boolean {
  return Date.now() - lastPluginSeen < 5000;
}

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
  const valid: CommandType[] = ["page-index", "frame", "selection", "export", "probe"];
  if (!valid.includes(type as CommandType)) return null;
  if (type === "frame" && !params?.id) return null;
  if (type === "export" && !Array.isArray(params?.ids)) return null;
  const id = `cmd_${Date.now()}_${++cmdCounter}`;
  // `type` is validated above, but TS can't narrow through .includes()
  const cmd: AgentCommand = {
    id,
    type: type as CommandType,
    params: params ?? {},
    status: "pending",
    createdAt: Date.now(),
  };
  commands.set(id, cmd);
  console.log(`[bridge] command queued: ${type}${params?.id ? ` ${params.id}` : ""} (${id})`);
  return cmd;
}

function persistResult(cmd: AgentCommand, payload: any): void {
  if (cmd.type === "page-index") {
    if (payload?.fileKey) savePageIndex(payload);
    return;
  }
  if (cmd.type === "export") return; // assets handled by the /v1/images caller
  const frames = Array.isArray(payload) ? payload : payload?.id ? [payload] : [];
  for (const f of frames) if (f?.id) saveFrame(f);
}

/** Queue a command and wait for the plugin to execute it. */
async function runCommand(type: string, params: any, timeoutMs = 25_000): Promise<any> {
  if (!pluginConnected()) {
    throw new BridgeError(503, "plugin not connected — open the Figma Agent plugin in Figma");
  }
  const cmd = createCommand(type, params);
  if (!cmd) throw new BridgeError(400, `invalid command: ${type}`);
  const start = Date.now();
  for (;;) {
    const c = commands.get(cmd.id)!;
    if (c.status === "success") return c.result;
    if (c.status === "error" || c.status === "timeout") {
      throw new BridgeError(502, `plugin command failed: ${c.error}`);
    }
    if (Date.now() - start > timeoutMs) {
      c.status = "timeout";
      c.error = "plugin did not respond in time";
      throw new BridgeError(504, `command timed out: ${c.error}`);
    }
    await sleep(150);
  }
}

/**
 * Fresh pull orchestration (backs ?fresh=1): page-index first, then every
 * top-level frame, max 3 in flight — partial progress survives a plugin
 * reload because each frame persists as it lands.
 */
async function freshPull(fileKey: string): Promise<void> {
  const idx = await runCommand("page-index", {});
  if (idx?.fileKey && safeId(idx.fileKey) !== safeId(fileKey)) {
    throw new BridgeError(409, `plugin is in a different file (${idx.fileKey}) than requested (${fileKey})`);
  }
  savePageIndex(idx);
  const ids: string[] = (idx.pages ?? []).flatMap((p: any) => (p.children ?? []).map((c: any) => c.id));
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const payload = await runCommand("frame", { id });
        persistResult({ type: "frame", id: "" } as AgentCommand, payload);
      } catch (e) {
        console.warn(`[bridge] fresh pull skipped ${id}: ${(e as Error).message}`);
      }
    }
  };
  const concurrency = Math.min(3, Math.max(1, ids.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();

// DNS-rebinding defense: only our own loopback hosts are ever accepted.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    console.warn(`[security] rejected request with Host: ${req.headers.host ?? "<none>"}`);
    res.status(403).type("text/plain").send("Invalid Host header");
    return;
  }
  next();
});

// The Figma plugin iframe has Origin "null"; local test pages come from
// loopback. Everything else gets no CORS headers. Defense = loopback bind
// + Host validation, not CORS.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
  }),
);

// SDK clients send Authorization: Bearer … / X-Figma-Token. Accepted and
// intentionally not validated — loopback-only bridge (agent.md §8.2).
// Never log auth headers.
app.use(express.json({ limit: "50mb" }));

// Structured request log (skip the long-poll heartbeat path).
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path === "/api/agent/commands/pending") return;
    console.log(`[req] ${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

function restError(res: express.Response, status: number, message: string): void {
  // REST error shape: {status, err} (spec ErrorResponsePayloadWithErrMessage;
  // empirically confirmed by a real 429 from api.figma.com). The legacy
  // /api/* routes keep their own {error: "..."} shapes.
  res.status(status).json({ status, err: message });
}

// --- plugin/agent command endpoints ---------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", frames: listAllFrames().length, pluginConnected: pluginConnected() });
});

app.post("/api/agent/commands", (req, res) => {
  const cmd = createCommand(req.body?.type, req.body);
  if (cmd === null) {
    res
      .status(400)
      .json({ error: 'body must be {type: "page-index"|"selection"} or {type: "frame", id: "<figma-node-id>"}' });
    return;
  }
  res.json({ requestId: cmd.id, status: cmd.status });
});

/** Plugin long-polls here — held up to 10s until a command arrives. */
app.get("/api/agent/commands/pending", async (_req, res) => {
  lastPluginSeen = Date.now();
  const deadline = Date.now() + LONG_POLL_MS;
  for (;;) {
    sweepStale();
    const next = [...commands.values()].find((c) => c.status === "pending");
    if (next) {
      next.status = "delivered";
      res.json({ command: next });
      return;
    }
    if (Date.now() >= deadline) {
      res.json({ command: null });
      return;
    }
    lastPluginSeen = Date.now();
    await sleep(200);
  }
});

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

app.get("/api/agent/commands/:id", (req, res) => {
  const cmd = commands.get(req.params.id);
  if (!cmd) {
    res.status(404).json({ error: "unknown command" });
    return;
  }
  sweepStale();
  res.json({ requestId: cmd.id, type: cmd.type, status: cmd.status, result: cmd.result, error: cmd.error });
});

app.get("/api/agent/status", (_req, res) => {
  sweepStale();
  res.json({
    pluginConnected: pluginConnected(),
    lastPluginSeen: lastPluginSeen ? new Date(lastPluginSeen).toISOString() : null,
  });
});

// --- plugin push endpoints -------------------------------------------------

app.post("/api/design-tree", (req, res) => {
  const body = req.body ?? {};
  const frames = Array.isArray(body) ? body : body.frames ?? body.id ? [body] : [];
  if (!frames.length) {
    res.status(400).json({ error: "no frames in payload" });
    return;
  }
  const saved = frames.map((f: any) => saveFrame(f));
  console.log(`[bridge] stored ${saved.length} frame(s): ${saved.map((s: any) => s.name).join(", ")}`);
  res.json({ status: "success", saved });
});

app.post("/api/page-index", (req, res) => {
  if (!req.body?.fileKey || !Array.isArray(req.body?.pages)) {
    res.status(400).json({ error: "payload must be {fileKey, pages: […]}" });
    return;
  }
  savePageIndex(req.body);
  const n = req.body.pages.reduce((a: number, p: any) => a + (p.children?.length ?? 0), 0);
  console.log(`[bridge] page index for ${req.body.fileKey}: ${req.body.pages.length} page(s), ${n} frame(s)`);
  res.json({ status: "success" });
});

// --- legacy read endpoints (v2 agent flow, now backed by store v2) ---------

app.get("/api/frames", (_req, res) => {
  res.json({ frames: listAllFrames() });
});

app.get("/api/frames/:id", (req, res) => {
  const frame = readFrame(req.params.id);
  if (frame === null) {
    res.status(404).json({ error: "frame not received yet — send it from the plugin" });
    return;
  }
  res.json(frame);
});

app.get("/api/latest", (_req, res) => {
  const all = listAllFrames();
  if (!all.length) {
    res.status(404).json({ error: "nothing received yet" });
    return;
  }
  res.redirect(`/api/frames/${encodeURIComponent(all[0].id)}`);
});

app.get("/api/page-index", (_req, res) => {
  const idx = latestPageIndex();
  if (!idx) {
    res.status(404).json({ error: "no page index received yet" });
    return;
  }
  res.json(idx);
});

// ---------------------------------------------------------------------------
// REST-parity routes — /v1 (drop-in for api.figma.com clients)
// ---------------------------------------------------------------------------

app.get("/v1/me", (_req, res) => {
  // GetMeResponse = User & {email}; User requires id, handle, img_url.
  res.json({
    id: "figma-agent-local",
    handle: "figma-agent",
    img_url: "", // no local avatar source — documented deviation
    email: "local@figma-agent",
  });
});

app.get("/v1/files/:key", async (req, res) => {
  const key = req.params.key;
  try {
    if (req.query.fresh === "1") {
      await freshPull(key);
    }
    const pages = getPages(key);
    if (!pages) {
      restError(res, 404, `file ${key} not found — no pages stored. Open the Figma Agent plugin and pull (?fresh=1) first.`);
      return;
    }
    const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").map((s) => s.trim()) : undefined;
    const depth = req.query.depth ? Number(req.query.depth) : undefined;
    const frames = listFramesForFile(key, ids);
    res.json(buildFileEnvelope(pages, frames, { ids, depth }));
  } catch (e) {
    if (e instanceof BridgeError) {
      restError(res, e.status, e.message);
      return;
    }
    restError(res, 500, (e as Error).message);
  }
});

app.get("/v1/files/:key/nodes", async (req, res) => {
  const key = req.params.key;
  if (typeof req.query.ids !== "string" || !req.query.ids.trim()) {
    restError(res, 400, "ids query parameter required (comma-separated Figma node ids)");
    return;
  }
  const ids = req.query.ids.split(",").map((s) => s.trim());
  const depth = req.query.depth ? Number(req.query.depth) : undefined;
  try {
    const frames: StoredFrame[] = [];
    for (const id of ids) {
      let frame = listFramesForFile(key, [id])[0] ?? null;
      if (!frame && pluginConnected()) {
        // not stored yet — try pulling it live
        const payload = await runCommand("frame", { id });
        if (payload?.id) {
          persistResult({ type: "frame", id: "" } as AgentCommand, payload);
          frame = payload;
        }
      }
      if (!frame) {
        restError(res, 404, `node ${id} not found in file ${key} — send it from the plugin or check the id`);
        return;
      }
      frames.push(frame);
    }
    const pages = getPages(key);
    res.json(
      buildNodesResponse(frames, { depth }, pages ? { fileKey: pages.fileKey } : undefined),
    );
  } catch (e) {
    if (e instanceof BridgeError) {
      restError(res, e.status, e.message);
      return;
    }
    restError(res, 500, (e as Error).message);
  }
});

// --- exported images (plugin exportAsync behind a REST-shaped route) -------

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

function assetPath(key: string, id: string, format: string): string {
  return path.join(storeDir(key), "assets", `${frameFileName(id)}.${format}`);
}

function assetUrl(key: string, id: string, format: string): string {
  return `${BASE}/assets/${safeId(key)}/${frameFileName(id)}.${format}`;
}

app.get("/v1/images/:key", async (req, res) => {
  const key = req.params.key;
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    restError(res, 400, "ids query parameter required");
    return;
  }
  const format = String(req.query.format ?? "png").toLowerCase();
  if (!CONTENT_TYPES[format]) {
    restError(res, 400, `format must be one of ${Object.keys(CONTENT_TYPES).join(", ")}`);
    return;
  }
  const scale = Number(req.query.scale ?? 2);

  const images: Record<string, string | null> = {};
  for (const id of ids) {
    const cached = assetPath(key, id, format);
    if (fs.existsSync(cached)) {
      images[id] = assetUrl(key, id, format);
      continue;
    }
    if (pluginConnected()) {
      try {
        const result = await runCommand("export", { ids: [id], format: format.toUpperCase(), scale });
        const b64 = result?.images?.[id];
        if (typeof b64 === "string" && b64) {
          fs.mkdirSync(path.dirname(cached), { recursive: true });
          fs.writeFileSync(cached, Buffer.from(b64, "base64"));
          images[id] = assetUrl(key, id, format);
          continue;
        }
      } catch (e) {
        console.warn(`[bridge] export failed for ${id}: ${(e as Error).message}`);
      }
    }
    images[id] = null;
  }
  res.json({ images, err: null });
});

app.get("/assets/:key/:file", (req, res) => {
  const file = path.basename(req.params.file); // no traversal
  const full = path.join(storeDir(req.params.key), "assets", file);
  if (!fs.existsSync(full)) {
    restError(res, 404, "asset not found");
    return;
  }
  const ext = file.split(".").pop() ?? "";
  res.type(CONTENT_TYPES[ext] ?? "application/octet-stream").send(fs.readFileSync(full));
});

// --- components / styles (best-effort parity from the local maps) -----------

app.get("/v1/files/:key/components", (req, res) => {
  const frames = listFramesForFile(req.params.key);
  const merged: Record<string, unknown> = {};
  for (const f of frames) Object.assign(merged, f.components ?? {});
  res.json({ meta: { components: Object.values(merged) }, status: 200, error: false });
});

app.get("/v1/files/:key/styles", (req, res) => {
  const frames = listFramesForFile(req.params.key);
  const merged: Record<string, unknown> = {};
  for (const f of frames) Object.assign(merged, f.styles ?? {});
  res.json({ meta: { styles: Object.values(merged) }, status: 200, error: false });
});

// Dev-only probe (Round 1): raw node facts from the live plugin for corpus
// rule-fitting — vectorNetwork regions, constraints, style ids, dimensions.
app.get("/api/dev/probe", async (req, res) => {
  try {
    if (req.query.instanceId) {
      const result = await runCommand("probe", { instanceId: String(req.query.instanceId) });
      res.json(result);
      return;
    }
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      res.status(400).json({ error: "ids query parameter required" });
      return;
    }
    const result = await runCommand("probe", { ids });
    res.json(result);
  } catch (e) {
    if (e instanceof BridgeError) {
      restError(res, e.status, e.message);
      return;
    }
    restError(res, 500, (e as Error).message);
  }
});

// ---------------------------------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  console.log(`Figma Agent bridge listening on http://${HOST}:${PORT} (store: ${STORE_DIR})`);
});

export { app, server };

// ---------------------------------------------------------------------------
// Optional MCP tools (stdio) — registered when spawned by an MCP client.
// ---------------------------------------------------------------------------

const mcpServer = new Server({ name: "figma-agent-bridge", version: "3.0.0" }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_figma_frames",
      description: "All frames stored from the Figma plugin so far (id, name, file key, when).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_figma_frame",
      description:
        "The full REST-shaped design tree of one frame, by its Figma node id (e.g. '247:448').",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Figma node id" } },
        required: ["id"],
      },
    },
    {
      name: "get_latest_figma_frame",
      description: "The most recently stored frame (REST-shaped tree).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "request_from_figma",
      description:
        "Ask the open Figma plugin for fresh data on demand: type 'page-index' (all pages + top-level frames), 'frame' (full design tree by node id, e.g. '247:448'), 'selection' (whatever is selected right now), or 'export' (PNG/JPG/SVG/PDF images by node ids). Requires the plugin open in Figma.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["page-index", "frame", "selection", "export"], description: "What to fetch" },
          id: { type: "string", description: "Figma node id — required for type 'frame'" },
          ids: { type: "array", items: { type: "string" }, description: "Node ids — required for type 'export'" },
          format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"] },
          scale: { type: "number" },
        },
        required: ["type"],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list_figma_frames") {
    return { content: [{ type: "text", text: JSON.stringify(listAllFrames(), null, 2) }] };
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
    const all = listAllFrames();
    if (!all.length) {
      return { content: [{ type: "text", text: "No frame received yet. Trigger export from the Figma plugin." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(readFrame(all[0].id)) }] };
  }
  if (request.params.name === "request_from_figma") {
    const args = (request.params.arguments as any) ?? {};
    const cmd = createCommand(args.type, args);
    if (cmd === null) {
      return {
        content: [{ type: "text", text: "Invalid request — need {type:'page-index'|'selection'} or {type:'frame', id:'…'} or {type:'export', ids:[…]}" }],
      };
    }
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
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((e) => console.error("[mcp]", e));
