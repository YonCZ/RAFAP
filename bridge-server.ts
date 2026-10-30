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
import os from "node:os";
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
import { searchNodes } from "./lib/search.js";
import { buildOutline } from "./lib/outline.js";
import { buildFlexLayout } from "./lib/flex-layout.js";
import {
  collectRenameTargets,
  computeRenderScale,
  resolveVisionConfig,
  sanitizeName,
  suggestNames,
  suggestionsToRenames,
  type VisionConfig,
} from "./lib/vision-rename.js";
import { collectStructuralFacts, describeFrame } from "./lib/vision-describe.js";
import { mergeFontProbeResult, parseFontMetricsTable, rewriteFontMetrics, type FontMetricsTable } from "./lib/font-metrics.js";
import {
  applyTransitionTable,
  collectUnresolvedStyles,
  hasRestBootstrap,
  loadLibraryIndex,
  loadTransitionTable,
  rewriteFrameStyles,
  writeLibraryHarvest,
  writeRestBootstrap,
} from "./lib/library-harvest.js";

/** Diagnostics must never touch stdout: when spawned by an MCP client,
 *  stdout IS the JSON-RPC channel and any stray log line corrupts the
 *  protocol. Everything goes to stderr (the dev workflow tees stderr). */
const log = (...args: unknown[]) => console.error(...args);

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1"; // numeric literal — never '0.0.0.0'
const PORT = Number(process.env.BRIDGE_PORT ?? 3002);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(ROOT, "store");
/** Round 13 — vision-rename call log (JSONL; API key never logged). */
const VISION_LOG = path.join(STORE_DIR, "logs", "vision-rename.jsonl");

/**
 * Round 2 (C1/C3/C4) — corpus-bootstrapped font metrics, built by
 * tools/build-font-metrics.ts. Applied at persist time (lib/font-metrics.ts);
 * null when the table is absent (rewriting simply disabled). Round 7 (C2)
 * `probe-fonts` results merge into it at runtime (`let` — a first successful
 * probe on a table-less install creates the table).
 */
let FONT_METRICS = parseFontMetricsTable(
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
let LIB_INDEX_LOADED_AT = Date.now();
/**
 * Reload the library join index when a harvest/bootstrap file newer than
 * the in-memory index appears on disk (seeded by hand, written by another
 * bridge run, or by the plugin harvest path of this one after the index
 * was built). The per-file transition tables go with it — they cache
 * per store key and would otherwise serve the pre-bootstrap (empty) state.
 */
function refreshLibraryIndexIfStale(): void {
  try {
    const stale = fs
      .readdirSync(LIBRARIES_DIR)
      .some((f) => f.endsWith(".json") && fs.statSync(path.join(LIBRARIES_DIR, f)).mtimeMs > LIB_INDEX_LOADED_AT);
    if (stale) {
      LIB_INDEX = loadLibraryIndex(LIBRARIES_DIR);
      TRANSITION_TABLES.clear();
      LIB_INDEX_LOADED_AT = Date.now();
      log("[bridge] library index reloaded (harvest/bootstrap newer than the in-memory index)");
    }
  } catch {
    /* no store/libraries yet */
  }
}
/**
 * Round 5 (D4) — per-file prototype-transition tables (rest-bootstrap).
 * Keyed by store file key; node ids are file-scoped, so a table never
 * applies across files. Cleared when a bootstrap is (re)written.
 */
const TRANSITION_TABLES = new Map<string, Map<string, import("./lib/library-harvest.js").HarvestedTransition>>();

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
      log(
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

/**
 * Round 5 (D4) — inject server-side prototype-transition state (duration/
 * easing — deviation #16) from the file's rest-bootstrap table. The node
 * id itself is plugin-derived (reactions destinationId); only the
 * un-seeable duration/easing come from the table.
 */
function applyPrototypeTransitions(storeKey: string, f: any): void {
  let table = TRANSITION_TABLES.get(storeKey);
  if (!table) {
    const realKey = realFileKey(storeKey);
    table = realKey ? loadTransitionTable(LIBRARIES_DIR, realKey) : new Map();
    TRANSITION_TABLES.set(storeKey, table);
  }
  applyTransitionTable(f, table);
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
  applyPrototypeTransitions(key, f);
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

/** Round 11 — after a plugin rename, patch the stored documents (node
 *  names, frame record names, pages.json children) so get_outline /
 *  get_file reflect the new names without a re-pull. Best-effort: ids not
 *  in the store (never-pulled subtrees) are simply skipped. */
function patchStoredNames(key: string, applied: Array<{ id: string; name: string }>): number {
  const byId = new Map(applied.map((r) => [r.id, r.name]));
  let patched = 0;
  for (const f of listFramesForFile(key)) {
    let dirty = false;
    if (typeof f.id === "string" && byId.has(f.id)) {
      f.name = byId.get(f.id)!;
      dirty = true;
    }
    const walk = (n: unknown): void => {
      if (n && typeof n === "object") {
        const node = n as { id?: string; name?: string; children?: unknown[] };
        if (typeof node.id === "string" && byId.has(node.id)) {
          node.name = byId.get(node.id)!;
          dirty = true;
          patched++;
        }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      }
    };
    walk(f.document);
    if (dirty) {
      const file = path.join(framesDirFor(key), `${frameFileName(f.id)}.json`);
      fs.writeFileSync(file, JSON.stringify(f, null, 2));
    }
  }
  const pages = getPages(key);
  if (pages) {
    let dirty = false;
    for (const p of pages.pages ?? []) {
      for (const c of p.children ?? []) {
        if (typeof c.id === "string" && byId.has(c.id)) {
          c.name = byId.get(c.id)!;
          dirty = true;
        }
      }
    }
    if (dirty) savePageIndex(pages as StoredPageIndex & Record<string, unknown>);
  }
  return patched;
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

type CommandType = "page-index" | "frame" | "selection" | "export" | "probe" | "probe-fonts" | "rename";

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

/**
 * Follower mode: when multiple bridge processes share one store (e.g. an
 * MCP client spawns one while another already holds the plugin port), only
 * the process that owns HTTP port PORT talks to the Figma plugin. The
 * others serve REST/MCP from the shared store and DELEGATE live plugin
 * commands to the owner over localhost HTTP. A 30s retry takes the port
 * over if the owner exits.
 */
let httpPortOwned = false;

function pluginConnected(): boolean {
  return Date.now() - lastPluginSeen < 5000;
}

function sweepStale(): void {
  const now = Date.now();
  for (const c of commands.values()) {
    if ((c.status === "pending" || c.status === "delivered") && now - c.createdAt > COMMAND_TIMEOUT_MS) {
      c.status = "timeout";
      c.error = "plugin did not respond in time — is the Figma Agent panel open and the Figma window visible (a minimized or backgrounded window throttles the plugin)?";
    }
  }
}

function createCommand(type: string, params: any): AgentCommand | null {
  const valid: CommandType[] = ["page-index", "frame", "selection", "export", "probe", "probe-fonts", "rename"];
  if (!valid.includes(type as CommandType)) return null;
  if (type === "frame" && !params?.id) return null;
  if (type === "export" && !Array.isArray(params?.ids)) return null;
  if (type === "rename" && !Array.isArray(params?.renames)) return null;
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
  log(`[bridge] command queued: ${type}${params?.id ? ` ${params.id}` : ""} (${id})`);
  return cmd;
}

function persistResult(cmd: AgentCommand, payload: any): void {
  if (cmd.type === "page-index") {
    if (payload?.fileKey) savePageIndex(payload);
    return;
  }
  if (cmd.type === "probe-fonts") {
    // Round 7 (C2) — merge runtime measurements into the font-metrics
    // store (corpus entries never overwritten; only linear probes accepted).
    if (!payload || !Array.isArray(payload.fonts)) return;
    if (!FONT_METRICS) FONT_METRICS = { lineHeightMultipliers: {}, postScriptNames: {} };
    const report = mergeFontProbeResult(FONT_METRICS as FontMetricsTable, payload);
    fs.writeFileSync(
      path.join(STORE_DIR, "font-metrics.json"),
      JSON.stringify(FONT_METRICS, null, 2) + "\n",
    );
    log(
      `[fonts] probe merged: added [${report.added
        .map((a) => `${a.family}=${a.multiplier.toPrecision(10)}${a.exact ? " (exact)" : ` ±${a.precision.toExponential(1)}`}`)
        .join(", ") || "-"}]` +
        (report.rejected.length
          ? ` rejected [${report.rejected.map((r) => `${r.family}: ${r.reason}`).join("; ")}]`
          : ""),
    );
    return;
  }
  if (cmd.type === "export") return; // assets handled by the /v1/images caller
  if (cmd.type === "rename") return; // store patching handled by apply_frame_names
  const frames = Array.isArray(payload) ? payload : payload?.id ? [payload] : [];
  for (const f of frames) if (f?.id) saveFrame(f);
}

/** Queue a command and wait for the plugin to execute it. */
async function runCommand(type: string, params: any, timeoutMs = 25_000): Promise<any> {
  if (!httpPortOwned) {
    // Follower mode: the plugin only talks to whichever bridge owns the
    // port, so delegate the command over localhost HTTP (the owner runs
    // the queue and returns the result). See POST /api/agent/run.
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, params, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 10_000),
      });
    } catch (e) {
      throw new BridgeError(
        502,
        `the bridge owning port ${PORT} is unreachable (${(e as Error).message}) — is it still running?`,
      );
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404) {
        throw new BridgeError(502, `the process on port ${PORT} is not a RAFAP bridge (404 on /api/agent/run)`);
      }
      throw new BridgeError(res.status, data?.error ?? "the port-owning bridge rejected the command");
    }
    return data.result;
  }
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
      c.error =
        "plugin did not respond in time — is the Figma Agent panel open and the Figma window visible " +
        "(a minimized or backgrounded window throttles the plugin)?";
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
/**
 * Round 4 (G1) — resolve the real REST file key for a local store key.
 * Dev plugin sessions have no figma.fileKey (store keys are `local-*`
 * fallbacks); `store/file-key-aliases.json` maps them to the real key.
 * Non-local store keys are already real keys.
 */
function realFileKey(localKey: string): string | null {
  try {
    const aliases = JSON.parse(
      fs.readFileSync(path.join(STORE_DIR, "file-key-aliases.json"), "utf8"),
    );
    const mapped = aliases?.[localKey];
    if (typeof mapped === "string" && mapped) return mapped;
  } catch {
    /* no alias table */
  }
  return localKey.startsWith("local-") ? null : localKey;
}

/**
 * Round 4 (G1) — rest-bootstrap the style-id join table, once per file.
 * A REST file envelope's `styles` map IS the join (map key = library node
 * id, field key = 40-hex publish key). One cached call per real file key
 * (`store/libraries/bootstrap_<key>.json`); failures never break the pull
 * (tokenless setups fall back to the plugin harvest / unresolved report).
 */
async function autoBootstrapLibraryStyles(localKey: string): Promise<void> {
  const realKey = realFileKey(localKey);
  if (!realKey) return;
  if (hasRestBootstrap(LIBRARIES_DIR, realKey)) {
    // Cached earlier — but possibly after this bridge built its in-memory
    // index (hand-seeded from a saved envelope, or written by a previous
    // run): pick it up before serving.
    refreshLibraryIndexIfStale();
    return;
  }
  let token = process.env.FIGMA_TOKEN;
  if (!token) {
    try {
      token = fs.readFileSync(path.join(os.homedir(), ".figma-token"), "utf8").trim();
    } catch {
      /* no token — harvest/unresolved path */
    }
  }
  if (!token) return;
  try {
    // Full depth: the style join only needs the `styles` map, but the
    // transition table (D4) lives on nodes deep in the document tree.
    const res = await fetch(`https://api.figma.com/v1/files/${realKey}`, {
      headers: { "X-Figma-Token": token },
    });
    if (res.status === 429) {
      log("[bridge] rest-bootstrap skipped: rate-limited (429) — harvest/unresolved path stays active");
      return;
    }
    if (!res.ok) {
      log(`[bridge] rest-bootstrap skipped: Figma API ${res.status}`);
      return;
    }
    const env = (await res.json()) as { styles?: Record<string, any>; document?: unknown };
    const harvest = writeRestBootstrap(LIBRARIES_DIR, realKey, env);
    if (harvest) {
      LIB_INDEX = loadLibraryIndex(LIBRARIES_DIR);
      TRANSITION_TABLES.clear();
      log(
        `[bridge] rest-bootstrap: ${realKey} — ${Object.keys(harvest.styles).length} style ids` +
          (harvest.transitions ? `, ${Object.keys(harvest.transitions).length} transitions` : "") +
          " joined",
      );
    }
  } catch (e) {
    log(`[bridge] rest-bootstrap failed (offline?): ${String(e)}`);
  }
}

async function freshPull(fileKey: string): Promise<void> {
  await autoBootstrapLibraryStyles(fileKey);
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
    log(`[req] ${req.method} ${req.originalUrl} → ${res.statusCode} ${Date.now() - start}ms`);
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

/** Follower-mode counterpart of runCommand: another bridge (one that lost
 *  the port race) delegates its live plugin commands here. The request
 *  blocks until the plugin executes the command (or times out). */
app.post("/api/agent/run", async (req, res) => {
  const { type, params, timeoutMs } = req.body ?? {};
  try {
    const result = await runCommand(
      String(type ?? ""),
      params ?? {},
      typeof timeoutMs === "number" ? Math.max(1_000, Math.min(timeoutMs, 120_000)) : 25_000,
    );
    res.json({ result });
  } catch (e) {
    if (e instanceof BridgeError) {
      restError(res, e.status, e.message);
      return;
    }
    restError(res, 500, (e as Error).message);
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
    log(`[bridge] command failed: ${cmd.type} — ${cmd.error}`);
  } else {
    cmd.status = "success";
    cmd.result = req.body?.payload;
    persistResult(cmd, cmd.result);
    log(`[bridge] command done: ${cmd.type} (${cmd.id})`);
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
  log(`[bridge] stored ${saved.length} frame(s): ${saved.map((s: any) => s.name).join(", ")}`);
  res.json({ status: "success", saved });
});

app.post("/api/page-index", (req, res) => {
  if (!req.body?.fileKey || !Array.isArray(req.body?.pages)) {
    res.status(400).json({ error: "payload must be {fileKey, pages: […]}" });
    return;
  }
  savePageIndex(req.body);
  const n = req.body.pages.reduce((a: number, p: any) => a + (p.children?.length ?? 0), 0);
  log(`[bridge] page index for ${req.body.fileKey}: ${req.body.pages.length} page(s), ${n} frame(s)`);
  res.json({ status: "success" });
});

// Round 13 — one-click "Rename Selected" from the plugin panel. The plugin
// UI calls this; the bridge orchestrates through the existing command queue
// (selection → export → rename), so the plugin itself needs no new message
// types. One undo step reverts the whole batch.
app.post("/api/rename/selected", async (_req, res) => {
  try {
    const { status, body } = await renameSelectionOneClick();
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
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

/** Resolve node ids to stored frames, live-pulling missing ones via the
 *  plugin (the shared core of `GET /v1/files/:key/nodes` and the MCP
 *  `get_nodes` tool). Throws BridgeError(404) for anything unresolvable. */
async function resolveFramesForIds(key: string, ids: string[]): Promise<StoredFrame[]> {
  const frames: StoredFrame[] = [];
  for (const id of ids) {
    let frame = listFramesForFile(key, [id])[0] ?? null;
    if (!frame && (pluginConnected() || !httpPortOwned)) {
      // not stored yet — try pulling it live
      const payload = await runCommand("frame", { id });
      if (payload?.id) {
        persistResult({ type: "frame", id: "" } as AgentCommand, payload);
        frame = payload;
      }
    }
    if (!frame) {
      throw new BridgeError(404, `node ${id} not found in file ${key} — send it from the plugin or check the id`);
    }
    frames.push(frame);
  }
  return frames;
}

/** The most recently pulled file — the default `fileKey` for the MCP tools
 *  (an agent mid-session should not have to know the key by heart). */
function defaultFileKey(): string | null {
  if (!fs.existsSync(STORE_DIR)) return null;
  let best: { key: string; mtime: number } | null = null;
  for (const key of fs.readdirSync(STORE_DIR)) {
    const file = path.join(storeDir(key), "pages.json");
    if (!fs.existsSync(file)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { key, mtime };
  }
  return best?.key ?? null;
}

app.get("/v1/files/:key/nodes", async (req, res) => {
  const key = req.params.key;
  if (typeof req.query.ids !== "string" || !req.query.ids.trim()) {
    restError(res, 400, "ids query parameter required (comma-separated Figma node ids)");
    return;
  }
  const ids = req.query.ids.split(",").map((s) => s.trim());
  const depth = req.query.depth ? Number(req.query.depth) : undefined;
  try {
    const frames = await resolveFramesForIds(key, ids);
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
  try {
    const images = await exportImagesForKey(key, ids, format, scale);
    res.json({ images, err: null });
  } catch (e) {
    if (e instanceof BridgeError) {
      restError(res, e.status, e.message);
      return;
    }
    restError(res, 500, (e as Error).message);
  }
});

/**
 * Export node images (the shared core of `GET /v1/images/:key` and the MCP
 * `get_images` tool): cached asset → serve; else plugin `exportAsync` →
 * cache → serve; else null. Returns the REST `{ [id]: url | null }` map.
 * SVG/PDF work here although REST's /v1/images cannot produce them (the
 * plugin's exportAsync can) — a superset, documented in the README.
 */
async function exportImagesForKey(
  key: string,
  ids: string[],
  format: string,
  scale: number,
): Promise<Record<string, string | null>> {
  const images: Record<string, string | null> = {};
  for (const id of ids) {
    const cached = assetPath(key, id, format);
    if (fs.existsSync(cached)) {
      images[id] = assetUrl(key, id, format);
      continue;
    }
    if (pluginConnected() || !httpPortOwned) {
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
  return images;
}

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
    if (req.query.styles !== undefined) {
      const result = await runCommand("probe", { styles: true });
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

/**
 * Round 7 (C2) — human-triggered runtime font probing. Probes every unique
 * font in the currently-open file (or an explicit list), merges linear
 * measurements into store/font-metrics.json (corpus entries kept), and
 * returns the raw report. The document is touched (one undo step per
 * probe batch) — this is why it is never run automatically during pulls.
 */
app.post("/api/dev/probe-fonts", async (req, res) => {
  try {
    const fonts = Array.isArray(req.body?.fonts) ? req.body.fonts : undefined;
    const result = await runCommand("probe-fonts", fonts ? { fonts } : {}, 120_000);
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

function startHttpListener(): void {
  const srv = app.listen(PORT, HOST, () => {
    httpPortOwned = true;
    log(`Figma Agent bridge listening on http://${HOST}:${PORT} (store: ${STORE_DIR})`);
  });
  srv.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      httpPortOwned = false;
      log(
        `[bridge] port ${PORT} is owned by another bridge — following it: REST/MCP serve ` +
          `from the shared store, live plugin commands are delegated to the owner. ` +
          `Retrying every 30s to take over if it exits.`,
      );
      setTimeout(startHttpListener, 30_000);
    } else {
      log(`[bridge] HTTP server error: ${e.code ?? "unknown"} — ${e.message}`);
    }
  });
  server = srv;
}

let server: ReturnType<typeof app.listen>;
startHttpListener();

export { app, server };

// ---------------------------------------------------------------------------
// Optional MCP tools (stdio) — registered when spawned by an MCP client.
// ---------------------------------------------------------------------------

const mcpServer = new Server({ name: "figma-agent-bridge", version: "3.1.0" }, { capabilities: { tools: {} } });

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
    // --- Round 8: the parity-grade REST-shaped surface -----------------
    {
      name: "get_file",
      description:
        "GET /v1/files/:key — the whole file as one REST-shaped document tree (pages → frames → nodes), plus the file-level components/componentSets/styles maps. Cached pulls return instantly. Defaults to the most recently pulled file.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          ids: { type: "array", items: { type: "string" }, description: "Restrict to these top-level node ids" },
          depth: { type: "number", description: "Prune the tree below this depth (REST depth semantics) — children below it are omitted; use get_outline for the full structure" },
        },
      },
    },
    {
      name: "get_nodes",
      description:
        "GET /v1/files/:key/nodes?ids= — REST-shaped subtrees by node id, nested under nodes[id].document. Unstored ids are live-pulled from the plugin when connected. Defaults to the most recently pulled file. Prefer get_outline for structural exploration (a compact digest of the whole tree) and describe_frames for what the design visually looks like — get_nodes returns full REST payloads that can be very large. Caution: depth prunes children — a frame that looks empty at low depth may just be pruned; use get_outline when you need the whole picture.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          ids: { type: "array", items: { type: "string" }, description: "Figma node ids, e.g. ['247:448']" },
          depth: { type: "number", description: "Prune each subtree below this depth (counts from the node) — children below it are omitted" },
        },
        required: ["ids"],
      },
    },
    {
      name: "get_images",
      description:
        "GET /v1/images/:key — render nodes to images (PNG/JPG/SVG/PDF; SVG and PDF supersede REST here) and return {images: {id: url|null}, err: null}. URLs are served by the local bridge and never expire. Cached renders return instantly.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          ids: { type: "array", items: { type: "string" }, description: "Figma node ids to render" },
          format: { type: "string", enum: ["png", "jpg", "svg", "pdf"], description: "Defaults to png" },
          scale: { type: "number", description: "Raster scale factor, defaults to 2" },
        },
        required: ["ids"],
      },
    },
    {
      name: "get_metadata",
      description:
        "The file's design tokens: the REST-shaped maps of local components, component sets, and paint/text styles (keyed by node id, exactly as in GET /v1/files). Defaults to the most recently pulled file.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
        },
      },
    },
    {
      name: "get_selection",
      description:
        "Whatever is selected in Figma right now, as a REST-shaped nodes response (the differentiator — 'grab what I selected'). Selected subtrees are also stored, so follow-up get_nodes/get_file see them. Requires the plugin open in Figma.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_nodes",
      description:
        "Search the stored design by node name, TEXT content, and/or node type (REST has no equivalent). Returns matching node ids with their frame and a text preview — feed the ids to get_nodes/get_images.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          query: { type: "string", description: "Case-insensitive substring matched against node names and text content" },
          type: { type: "string", description: "Node type filter, e.g. 'TEXT', 'INSTANCE', 'frame'" },
          limit: { type: "number", description: "Match cap (default 50)" },
        },
      },
    },
    {
      name: "get_outline",
      description:
        "Compact whole-tree digest of frames — one indented line per node with id, name, type, size, child count, auto-layout summary (direction/gap/padding), and the FULL text content of TEXT nodes. No paints/fills/effects JSON, no depth pruning: this is the tool for UNDERSTANDING a design (structure + intent) before building or reviewing it, at a fraction of get_file/get_nodes token cost. Unstored frame ids are live-pulled from the plugin when connected. Follow up with get_nodes/get_images on specific ids for implementation detail.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          frameIds: { type: "array", items: { type: "string" }, description: "Figma frame ids — defaults to all stored frames of the file" },
          maxNodes: { type: "number", description: "Per-frame node cap before the outline truncates (default 400)" },
        },
      },
    },
    {
      name: "suggest_frame_names",
      description:
        "Dry-run AI renaming of lazy Figma frame names (Frame 336 → 'Top Nav'): renders the frames, sends the PNG plus each layer's type/size/text content to a vision LLM, and returns proposed names. Scope defaults to the current selection (plus its unnamed children); pass frameIds to target stored frames instead. Only default names like 'Frame 336'/'Group 5' are ever proposed — deliberately-named nodes are untouched. Nothing is written; review the suggestions, then apply with apply_frame_names. The vision endpoint comes from VISION_BASE_URL/VISION_MODEL/VISION_API_KEY env vars, or the user's OpenCode provider config.",
      inputSchema: {
        type: "object",
        properties: {
          frameIds: { type: "array", items: { type: "string" }, description: "Figma frame ids to rename inside (defaults to the current Figma selection)" },
          fileKey: { type: "string", description: "File key (defaults to the selection's / most recently pulled file)" },
        },
      },
    },
    {
      name: "get_flex_layout",
      description:
        "CSS flexbox translation of the design's auto-layout — the layout INTENT, not bounding boxes. Per node: display/flex-direction/gap/padding/justify-content/align-items declarations, plus each child's sizing semantics (fixed → px, hug → fit-content, fill → flex-grow on the main axis / align-self:stretch on the cross axis, layoutGrow → flex-grow). Build layout CSS from this so it inherits the design's intent — pixel dimensions describe the result, not the rule. Scope: frameIds or all stored frames of the file (defaults to the most recently pulled file).",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
          frameIds: { type: "array", items: { type: "string" }, description: "Figma frame ids — defaults to all stored frames of the file" },
        },
      },
    },
    {
      name: "describe_frames",
      description:
        "What the design actually LOOKS like: renders the frames and asks a vision model to describe the visual structure — layout regions and their roles, visual hierarchy, grouping, alignment, spacing — as markdown that references layer ids (joins with get_outline). Use when building or reproducing a design, or when the numbers alone do not explain the layout. Scope defaults to the current Figma selection; pass frameIds to target stored frames. Vision endpoint from VISION_BASE_URL/VISION_MODEL/VISION_API_KEY env vars or the user's OpenCode provider config.",
      inputSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key (defaults to the selection's / most recently pulled file)" },
          frameIds: { type: "array", items: { type: "string" }, description: "Figma frame ids to describe (defaults to the current selection)" },
        },
      },
    },
    {
      name: "apply_frame_names",
      description:
        "Apply frame renames in Figma: {renames: [{id, name}]} — pass the suggestions from suggest_frame_names. The whole batch executes as one Figma undo step (Cmd+Z). The stored design is patched to match, so get_outline/get_file immediately reflect the new names. Requires the plugin connected.",
      inputSchema: {
        type: "object",
        properties: {
          renames: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }, description: "Renamed nodes — [{id, name}]" },
          fileKey: { type: "string", description: "File key (defaults to the most recently pulled file)" },
        },
        required: ["renames"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Round 13 — shared vision-rename pipeline.
// One implementation used by BOTH surfaces: the suggest_frame_names MCP
// tool (dry-run) and the one-click "Rename Selected" panel button
// (POST /api/rename/selected, which also applies).
// ---------------------------------------------------------------------------

/**
 * Resolve the frames a vision tool (rename or describe) should work on:
 * explicit frameIds from the store, or — by default — the current Figma
 * selection, live-pulled and stored. Shared so every scope behaves the
 * same way. Returns an error string when nothing usable is in scope.
 */
async function resolveToolFrames(
  args: any,
): Promise<{ frames: StoredFrame[]; key: string; error?: string }> {
  const frameIds = Array.isArray(args.frameIds) ? args.frameIds.map(String) : [];
  if (frameIds.length) {
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    try {
      return { frames: await resolveFramesForIds(key, frameIds), key };
    } catch (e) {
      return { frames: [], key, error: (e as Error).message };
    }
  }
  if (!pluginConnected() && httpPortOwned) {
    return { frames: [], key: "", error: "the Figma plugin is not connected — open the Figma Agent panel in Figma, or pass frameIds." };
  }
  const picked = await runCommand("selection", {});
  const frames = (Array.isArray(picked) ? picked : []) as StoredFrame[];
  if (!frames.length) {
    return { frames: [], key: "", error: "nothing is selected in Figma — select frames, or pass frameIds." };
  }
  for (const f of frames) {
    if (f?.id) persistResult({ type: "frame", id: "" } as AgentCommand, f);
  }
  return { frames, key: String(args.fileKey ?? frames[0]?.fileKey ?? defaultFileKey() ?? "") };
}

/**
 * Render a stored frame to a base64 PNG at the smart vision scale.
 * Returns null when the render fails (plugin offline etc.).
 */
async function renderFramePng(key: string, frame: StoredFrame): Promise<string | null> {
  const bb = (frame.document as any)?.absoluteBoundingBox;
  const scale = computeRenderScale(Number(bb?.width) || 0, Number(bb?.height) || 0);
  const images = await exportImagesForKey(key, [frame.id], "png", scale);
  const asset = assetPath(key, frame.id, "png");
  if (!images[frame.id] || !fs.existsSync(asset)) return null;
  return fs.readFileSync(asset).toString("base64");
}

/**
 * Collect lazy-name targets inside the given frames, render each frame
 * (smart-scaled so vision endpoints accept it), and ask the vision model
 * for names. Returns per-target suggestions (suggestedName null when the
 * model had nothing usable).
 */
async function suggestRenamesForFrames(
  cfg: VisionConfig,
  frames: StoredFrame[],
  key: string,
): Promise<{ suggestions: Array<Record<string, unknown>>; withNames: number; renderError?: string }> {
  const suggestions: Array<Record<string, unknown>> = [];
  let withNames = 0;
  for (const frame of frames) {
    const targets = collectRenameTargets(frame.document);
    if (!targets.length) continue;
    const b64 = await renderFramePng(key, frame);
    if (!b64) {
      return { suggestions: [], withNames: 0, renderError: `could not render frame ${frame.id} ("${frame.name}") — is the plugin connected?` };
    }
    const names = await suggestNames(cfg, b64, targets, fetch, VISION_LOG);
    for (const t of targets) {
      const suggestedName = names[t.id] ?? null;
      if (suggestedName) withNames++;
      suggestions.push({
        id: t.id,
        currentName: t.currentName,
        suggestedName,
        type: t.type,
        size: `${t.width}x${t.height}`,
        textInside: t.textInside,
      });
    }
  }
  return { suggestions, withNames };
}

/**
 * One-click flow behind the plugin panel's "Rename Selected" button:
 * scope = current Figma selection (+ lazy descendants) → vision suggest →
 * apply as ONE undo step → patch the store so get_outline reflects it.
 */
async function renameSelectionOneClick(): Promise<{ status: number; body: Record<string, unknown> }> {
  const cfg = resolveVisionConfig();
  if (!cfg) {
    return {
      status: 503,
      body: { error: "no vision endpoint configured — set VISION_BASE_URL + VISION_MODEL + VISION_API_KEY, or configure a provider in ~/.config/opencode/opencode.json" },
    };
  }
  if (!pluginConnected() && httpPortOwned) {
    return { status: 503, body: { error: "the Figma plugin is not connected — reopen the Figma Agent panel" } };
  }
  const picked = await runCommand("selection", {});
  const frames = (Array.isArray(picked) ? picked : []) as StoredFrame[];
  if (!frames.length) {
    return { status: 400, body: { error: "nothing is selected in Figma — select the frames to rename" } };
  }
  for (const f of frames) {
    if (f?.id) persistResult({ type: "frame", id: "" } as AgentCommand, f);
  }
  const key = String(frames[0]?.fileKey ?? defaultFileKey() ?? "");
  const { suggestions, withNames, renderError } = await suggestRenamesForFrames(cfg, frames, key);
  if (renderError) return { status: 502, body: { error: renderError } };
  if (!suggestions.length) {
    return {
      status: 200,
      body: { applied: [], count: 0, message: 'nothing to rename — every node in the selection has a deliberate name (only default names like "Frame 336" are candidates)' },
    };
  }
  const renames = suggestionsToRenames(suggestions as Array<{ id: unknown; suggestedName: unknown }>);
  if (!renames.length) {
    return { status: 502, body: { error: "vision model returned no usable names", suggestions } };
  }
  const result = await runCommand("rename", { renames });
  const applied: Array<{ id: string; name: string }> = Array.isArray(result?.applied) ? result.applied : [];
  const patched = patchStoredNames(key, applied);
  return { status: 200, body: { applied, notFound: result?.notFound ?? [], storePatched: patched, model: cfg.model } };
}

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
    if (!createCommand(String(args.type ?? ""), args)) {
      return {
        content: [{ type: "text", text: "Invalid request — need {type:'page-index'|'selection'} or {type:'frame', id:'…'} or {type:'export', ids:[…]}" }],
      };
    }
    try {
      const result = await runCommand(String(args.type ?? ""), args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Command failed: ${(e as Error).message}` }] };
    }
  }
  // --- Round 8: parity-grade tools (REST-shaped returns) ---------------
  if (request.params.name === "get_file") {
    const args = (request.params.arguments as any) ?? {};
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const pages = getPages(key);
    if (!pages) {
      return {
        content: [{ type: "text", text: `file ${key || "(none)"} not found — no pages stored. Pull first: request_from_figma {type:'page-index'}, then get_file again.` }],
      };
    }
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
    const depth = typeof args.depth === "number" ? args.depth : undefined;
    const frames = listFramesForFile(key, ids);
    return { content: [{ type: "text", text: JSON.stringify(buildFileEnvelope(pages, frames, { ids, depth })) }] };
  }
  if (request.params.name === "get_nodes") {
    const args = (request.params.arguments as any) ?? {};
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length) {
      return { content: [{ type: "text", text: "Error: ids is required (array of Figma node ids)" }], isError: true };
    }
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const depth = typeof args.depth === "number" ? args.depth : undefined;
    try {
      const frames = await resolveFramesForIds(key, ids);
      const pages = getPages(key);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(buildNodesResponse(frames, { depth }, pages ? { fileKey: pages.fileKey } : undefined)),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "get_images") {
    const args = (request.params.arguments as any) ?? {};
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    if (!ids.length) {
      return { content: [{ type: "text", text: "Error: ids is required (array of Figma node ids)" }], isError: true };
    }
    const format = String(args.format ?? "png").toLowerCase();
    if (!CONTENT_TYPES[format]) {
      return { content: [{ type: "text", text: `Error: format must be one of ${Object.keys(CONTENT_TYPES).join(", ")}` }], isError: true };
    }
    const scale = Number(args.scale ?? 2);
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const images = await exportImagesForKey(key, ids, format, scale);
    return { content: [{ type: "text", text: JSON.stringify({ images, err: null }) }] };
  }
  if (request.params.name === "get_metadata") {
    const args = (request.params.arguments as any) ?? {};
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const frames = listFramesForFile(key);
    if (!frames.length) {
      return {
        content: [{ type: "text", text: `no stored frames for ${key || "(any file)"} — pull first: request_from_figma {type:'page-index'}` }],
        isError: true,
      };
    }
    const components: Record<string, unknown> = {};
    const componentSets: Record<string, unknown> = {};
    const styles: Record<string, unknown> = {};
    for (const f of frames) {
      Object.assign(components, f.components ?? {});
      Object.assign(componentSets, f.componentSets ?? {});
      Object.assign(styles, f.styles ?? {});
    }
    return { content: [{ type: "text", text: JSON.stringify({ components, componentSets, styles }) }] };
  }
  if (request.params.name === "get_selection") {
    if (!pluginConnected() && httpPortOwned) {
      return { content: [{ type: "text", text: "Error: the Figma plugin is not connected — open the Figma Agent panel in Figma." }], isError: true };
    }
    try {
      const picked = await runCommand("selection", {});
      const frames = Array.isArray(picked) ? picked : [];
      if (!frames.length) {
        return { content: [{ type: "text", text: "Error: nothing is selected in Figma." }], isError: true };
      }
      // store the picked subtrees so follow-up get_nodes/get_file see them
      for (const f of frames) {
        if (f?.id) persistResult({ type: "frame", id: "" } as AgentCommand, f);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(buildNodesResponse(frames, {}, { fileKey: frames[0]?.fileKey ?? "selection" })),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "search_nodes") {
    const args = (request.params.arguments as any) ?? {};
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const frames = listFramesForFile(key);
    if (!frames.length) {
      return {
        content: [{ type: "text", text: `no stored frames for ${key || "(any file)"} — pull first: request_from_figma {type:'page-index'}` }],
        isError: true,
      };
    }
    try {
      const hits = searchNodes(frames, {
        query: args.query,
        type: args.type,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ fileKey: key, count: hits.length, nodes: hits }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "get_outline") {
    const args = (request.params.arguments as any) ?? {};
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const frameIds = Array.isArray(args.frameIds) ? args.frameIds.map(String) : [];
    const maxNodes = typeof args.maxNodes === "number" ? args.maxNodes : undefined;
    try {
      const frames = frameIds.length ? await resolveFramesForIds(key, frameIds) : listFramesForFile(key);
      if (!frames.length) {
        return {
          content: [{ type: "text", text: `no stored frames for ${key || "(any file)"} — pull first: request_from_figma {type:'page-index'}` }],
          isError: true,
        };
      }
      const outline = buildOutline(frames, { maxNodes });
      return { content: [{ type: "text", text: `fileKey: ${key} · ${frames.length} frame(s)\n\n${outline}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "get_flex_layout") {
    // Round 15 — paste-ready flexbox translation of the auto-layout.
    // The anti-bounding-box view: layout intent (hug/fill/fixed, gaps,
    // padding, alignment) as CSS, so building from intent is easier
    // than styling around pixel dimensions.
    const args = (request.params.arguments as any) ?? {};
    const key = String(args.fileKey ?? defaultFileKey() ?? "");
    const frameIds = Array.isArray(args.frameIds) ? args.frameIds.map(String) : [];
    const maxNodes = typeof args.maxNodes === "number" ? args.maxNodes : undefined;
    try {
      const frames = frameIds.length ? await resolveFramesForIds(key, frameIds) : listFramesForFile(key);
      if (!frames.length) {
        return {
          content: [{ type: "text", text: `no stored frames for ${key || "(any file)"} — pull first: request_from_figma {type:'page-index'}` }],
          isError: true,
        };
      }
      const digest = buildFlexLayout(frames, { maxNodes });
      return { content: [{ type: "text", text: `fileKey: ${key} · ${frames.length} frame(s)\n\n${digest}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "suggest_frame_names") {
    const args = (request.params.arguments as any) ?? {};
    const cfg = resolveVisionConfig();
    if (!cfg) {
      return {
        content: [{
          type: "text",
          text: "no vision endpoint configured — set VISION_BASE_URL + VISION_MODEL + VISION_API_KEY (any OpenAI-compatible endpoint), or configure a provider in ~/.config/opencode/opencode.json",
        }],
      };
    }
    try {
      const { frames, key, error } = await resolveToolFrames(args);
      if (error) {
        return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
      }

      const { suggestions, withNames, renderError } = await suggestRenamesForFrames(cfg, frames, key);
      if (renderError) {
        return { content: [{ type: "text", text: `Error: ${renderError}` }], isError: true };
      }
      if (!suggestions.length) {
        return { content: [{ type: "text", text: "nothing to rename — every frame in scope already has a deliberate name (only default names like \"Frame 336\" are candidates)" }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            { fileKey: key, model: cfg.model, source: cfg.source, dryRun: true, count: withNames, suggestions },
            null,
            2,
          ),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "describe_frames") {
    // Round 14 — the agent's eyes: render the frames, send PNG + main
    // layer facts to the vision model, and return a markdown description
    // of the VISUAL structure with inline layer-id references that join
    // with get_outline.
    const args = (request.params.arguments as any) ?? {};
    const cfg = resolveVisionConfig();
    if (!cfg) {
      return {
        content: [{
          type: "text",
          text: "no vision endpoint configured — set VISION_BASE_URL + VISION_MODEL + VISION_API_KEY (any OpenAI-compatible endpoint), or configure a provider in ~/.config/opencode/opencode.json",
        }],
        isError: true,
      };
    }
    try {
      const { frames, key, error } = await resolveToolFrames(args);
      if (error) {
        return { content: [{ type: "text", text: `Error: ${error}` }], isError: true };
      }
      const parts: string[] = [];
      for (const frame of frames) {
        const b64 = await renderFramePng(key, frame);
        if (!b64) {
          return { content: [{ type: "text", text: `Error: could not render frame ${frame.id} ("${frame.name}") — is the plugin connected?` }], isError: true };
        }
        const facts = collectStructuralFacts(frame.document);
        const description = await describeFrame(cfg, b64, facts, fetch, VISION_LOG);
        const bb = (frame.document as any)?.absoluteBoundingBox;
        parts.push(
          `## ${frame.name} (${frame.id}) — ${Math.round(bb?.width ?? 0)}x${Math.round(bb?.height ?? 0)}\n\n${description}`,
        );
      }
      return {
        content: [{ type: "text", text: `fileKey: ${key} · model: ${cfg.model}\n\n${parts.join("\n\n---\n\n")}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  if (request.params.name === "apply_frame_names") {
    const args = (request.params.arguments as any) ?? {};
    const renames = (Array.isArray(args.renames) ? args.renames : [])
      .map((r: any) => ({ id: String(r?.id ?? ""), name: sanitizeName(r?.name) }))
      .filter((r: { id: string; name: string }) => r.id && r.name);
    if (!renames.length) {
      return { content: [{ type: "text", text: "Error: renames is required — [{id, name}], e.g. the suggestions from suggest_frame_names" }], isError: true };
    }
    if (!pluginConnected() && httpPortOwned) {
      return { content: [{ type: "text", text: "Error: the Figma plugin is not connected — open the Figma Agent panel in Figma." }], isError: true };
    }
    try {
      const key = String(args.fileKey ?? defaultFileKey() ?? "");
      const result = await runCommand("rename", { renames });
      const applied: Array<{ id: string; name: string }> = Array.isArray(result?.applied) ? result.applied : [];
      const patched = patchStoredNames(key, applied);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ applied, notFound: result?.notFound ?? [], storePatched: patched }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
mcpServer.connect(transport).catch((e) => console.error("[mcp]", e));
