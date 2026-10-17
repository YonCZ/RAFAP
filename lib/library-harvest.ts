/**
 * Round 4 (G1) — library style harvest + remote-style id resolution.
 *
 * Deviation #10: a plugin is file-scoped. In a *consumer* file, a published
 * (remote) style binding is only visible through a consumer-local marker id
 * (e.g. "776:35"), while REST emits the *defining library file's* node id
 * (e.g. "36:572"). The 40-hex publish `key` is identical from both sides —
 * that is the join.
 *
 * Harvest side: the plugin's `page-index` command now enumerates the local
 * styles of whatever file it runs in. Run inside a library file, that
 * enumeration IS the library's key→nodeId table; the bridge persists it as
 * `store/libraries/<fileKey>.json` (plugin harvest — the tokenless/
 * offline fallback).
 *
 * Rest bootstrap (the default path): a REST file envelope's `styles` map is
 * itself the complete join table (`{"36:572": {key: "bccec…", remote:
 * true}}` — the map key is the library node id). One cached call per file
 * (or a saved envelope fixture) mines it via `writeRestBootstrap`; the
 * mapping is stable across file edits, so the cache rarely needs
 * refreshing. This is the same one-time-bootstrap philosophy as
 * `store/font-metrics.json` (Round 2).
 *
 * Consumer side: at persist time (saveFrame), style entries in the frame's
 * `styles` map are re-keyed from the marker id to the join-table node id,
 * and `node.styles` binding values are renamed to match. The consumer's
 * own metadata (name/description/styleType) is kept — REST reads the same
 * cached copy the consumer file stores — only the un-seeable node id comes
 * from the join.
 *
 * Remote styles with no harvest entry are recorded in
 * `store/<fileKey>/unresolved-library-styles.json` so the operator knows
 * exactly which library files still need a harvest run.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A library-side style, keyed by its 40-hex publish key. */
export interface HarvestedStyle {
  nodeId: string;
  name: string;
  description: string;
  styleType: string;
}

/** Persisted shape of `store/libraries/<fileKey>.json`. */
export interface LibraryHarvest {
  fileKey: string;
  harvestedAt: string;
  /** 40-hex publish key → library-side style record. */
  styles: Record<string, HarvestedStyle>;
  /**
   * Rest-bootstrap only: this file's own node id → prototype transition
   * (duration/easing are server-side state the plugin cannot see). Node
   * ids are file-scoped — this table must only be applied to the file it
   * was bootstrapped from, never merged globally like `styles`.
   */
  transitions?: Record<string, HarvestedTransition>;
  /** Provenance: "plugin-harvest" (run inside the file) or "rest-bootstrap". */
  source?: string;
}

/** A remote style the bridge could not resolve — operator to-do item. */
export interface UnresolvedStyle {
  key: string;
  name: string;
  usedBy: string[];
}

/**
 * Round 5 (D4) — a prototype-transition record mined from REST. The node's
 * `transitionNodeID` (the destination, often a library-side frame) IS
 * plugin-visible via reactions (`action.destinationId`), but
 * `transitionDuration`/`transitionEasing` are server-side state the plugin
 * cannot see (probed: legacy reads and `action.transition` are all null
 * while REST reports 300/EASE_OUT — deviation #16). Keyed by the file's
 * OWN node ids — unlike style keys these are not globally unique, so a
 * transitions table only applies to the file it was bootstrapped from.
 */
export interface HarvestedTransition {
  transitionNodeID?: string;
  transitionDuration?: number;
  transitionEasing?: string;
}

/** Page-index `styles` map entry (keyed by file-local node id). */
interface PageIndexStyleEntry {
  key: string;
  name: string;
  description?: string;
  remote?: boolean;
  styleType: string;
}

/** File keys contain ":" — filename-safe (mirrors bridge-server's safeId). */
function safeFileName(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Persist a library harvest. `stylesByNodeId` is the plugin's page-index
 * styles map (nodeId-keyed); it is inverted to the key-keyed join table.
 * A harvest is a full enumeration snapshot — it replaces the file's previous
 * table wholesale (deleted styles drop out; ids stay fresh).
 */
export function writeLibraryHarvest(
  librariesDir: string,
  fileKey: string,
  stylesByNodeId: Record<string, PageIndexStyleEntry>,
  now = new Date(),
): LibraryHarvest | null {
  const styles: Record<string, HarvestedStyle> = {};
  // The plugin's styles map is nodeId-keyed; invert to the key-keyed join
  // table (the nodeId is the map key, the 40-hex publish key a field).
  // Skip entries whose map key is not a real node id — current Figma
  // reports local styles as "S:<hash>," (empty suffix); joining a
  // placeholder id would rewrite consumer bindings to garbage.
  for (const [nodeId, entry] of Object.entries(stylesByNodeId ?? {})) {
    if (!entry?.key || !nodeId) continue;
    if (nodeId.startsWith("S:")) continue; // placeholder id, not a REST node id
    styles[entry.key] = {
      nodeId,
      name: entry.name ?? "",
      description: entry.description ?? "",
      styleType: entry.styleType ?? "",
    };
  }
  if (!Object.keys(styles).length) return null;
  const harvest: LibraryHarvest = {
    fileKey,
    harvestedAt: now.toISOString(),
    styles,
    source: "plugin-harvest",
  };
  fs.mkdirSync(librariesDir, { recursive: true });
  fs.writeFileSync(path.join(librariesDir, `${safeFileName(fileKey)}.json`), JSON.stringify(harvest, null, 2));
  return harvest;
}

/**
 * Load every harvested library into one join table: 40-hex key → library
 * style record. Files are read in sorted name order; on key collisions the
 * later file wins (in practice libraries define disjoint keys).
 */
export function loadLibraryIndex(librariesDir: string): Map<string, HarvestedStyle> {
  const index = new Map<string, HarvestedStyle>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(librariesDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return index; // no store/libraries yet
  }
  for (const file of files) {
    let harvest: LibraryHarvest | null = null;
    try {
      harvest = JSON.parse(fs.readFileSync(path.join(librariesDir, file), "utf8"));
    } catch {
      continue; // corrupt file — skip, never block serving
    }
    for (const [key, style] of Object.entries(harvest?.styles ?? {})) {
      if (!style?.nodeId) continue;
      // Defensive: placeholder ids ("S:<hash>," — current Figma reports local
      // styles this way) must never enter the join table; they would rewrite
      // consumer bindings to garbage. (Write-side guards exist too, but a
      // file written by an older bridge or by hand must not poison serving.)
      if (style.nodeId.startsWith("S:")) continue;
      index.set(key, style);
    }
  }
  return index;
}

/**
 * Mine the key→nodeId join table from a REST file envelope's `styles` map
 * (`{"36:572": {key: "bccec…", remote: true, …}}` — the map key IS the
 * library node id). This is the rest-bootstrap source: one cached call (or
 * a saved envelope fixture) yields the complete mapping for every remote
 * style a consumer file references; the plugin-harvest path remains as the
 * tokenless/offline fallback.
 */
export function bootstrapFromRestStyles(
  stylesMap: Record<string, any>,
): Record<string, HarvestedStyle> {
  const styles: Record<string, HarvestedStyle> = {};
  for (const [nodeId, meta] of Object.entries(stylesMap ?? {})) {
    const m = meta as PageIndexStyleEntry;
    if (!nodeId || !m?.key) continue;
    styles[m.key] = {
      nodeId,
      name: m.name ?? "",
      description: m.description ?? "",
      styleType: m.styleType ?? "",
    };
  }
  return styles;
}

/**
 * Mine the file's prototype-transition table from a REST envelope's document
 * tree: every node with a `transitionNodeID` (REST's legacy surface, derived
 * server-side from reactions). Duration/easing are un-seeable from the
 * plugin (deviation #16), so this is the only source for them.
 */
export function bootstrapTransitionsFromDocument(
  documentRoot: unknown,
): Record<string, HarvestedTransition> {
  const transitions: Record<string, HarvestedTransition> = {};
  for (const node of walkNodes(documentRoot)) {
    if (typeof node.id !== "string" || typeof node.transitionNodeID !== "string") continue;
    const t: HarvestedTransition = { transitionNodeID: node.transitionNodeID };
    if (typeof node.transitionDuration === "number") t.transitionDuration = node.transitionDuration;
    if (typeof node.transitionEasing === "string") t.transitionEasing = node.transitionEasing;
    transitions[node.id] = t;
  }
  return transitions;
}

/**
 * Persist a rest-bootstrap join table (mined from a REST envelope). Takes
 * the whole envelope: `styles` → the key→nodeId join, `document` → this
 * file's prototype-transition table (Round 5 D4).
 */
export function writeRestBootstrap(
  librariesDir: string,
  realFileKey: string,
  envelope: { styles?: Record<string, any>; document?: unknown },
  now = new Date(),
): LibraryHarvest | null {
  const styles = bootstrapFromRestStyles(envelope?.styles ?? {});
  const transitions = bootstrapTransitionsFromDocument(envelope.document);
  if (!Object.keys(styles).length && !Object.keys(transitions).length) return null;
  const harvest: LibraryHarvest = {
    fileKey: realFileKey,
    harvestedAt: now.toISOString(),
    styles,
    ...(Object.keys(transitions).length ? { transitions } : {}),
    source: "rest-bootstrap",
  };
  fs.mkdirSync(librariesDir, { recursive: true });
  fs.writeFileSync(
    path.join(librariesDir, `bootstrap_${safeFileName(realFileKey)}.json`),
    JSON.stringify(harvest, null, 2),
  );
  return harvest;
}

/** Has a rest-bootstrap already been cached for this real file key? */
export function hasRestBootstrap(librariesDir: string, realFileKey: string): boolean {
  return fs.existsSync(path.join(librariesDir, `bootstrap_${safeFileName(realFileKey)}.json`));
}

/** Depth-first over every node object in a serialized document tree. */
function* walkNodes(root: unknown): Generator<Record<string, any>> {
  const stack: unknown[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    yield n as Record<string, any>;
    const kids = Array.isArray((n as any).children) ? (n as any).children : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

export interface RewriteResult {
  /** Remote style entries rewritten to library node ids. */
  resolved: number;
  /** Remote styles with no harvest entry (with usedBy node ids). */
  unresolved: UnresolvedStyle[];
}

/**
 * Rewrite a stored frame in place (idempotent): re-key `styles` map entries
 * whose 40-hex key has a join-table entry — remote entries (consumer marker
 * id → library node id) and local entries alike (a rest-bootstrap table can
 * repair degenerate plugin markers, e.g. the empty-string style id) — and
 * rename the matching `node.styles` binding values. Entries with no join
 * pass through untouched; remote misses are recorded for the unresolved
 * report.
 */
export function rewriteFrameStyles(frame: any, index: Map<string, HarvestedStyle>): RewriteResult {
  const styles = frame?.styles;
  if (!styles || typeof styles !== "object") return { resolved: 0, unresolved: [] };

  // Pass 1 — styles map: marker id → join-table node id.
  const rename = new Map<string, string>(); // markerId → resolved node id
  const unresolvedByMarker = new Map<string, UnresolvedStyle>(); // markerId → entry
  const rewritten: Record<string, unknown> = {};
  let resolved = 0;
  for (const [markerId, raw] of Object.entries(styles)) {
    const meta = raw as PageIndexStyleEntry;
    const key = typeof meta?.key === "string" ? meta.key : undefined;
    const lib = key ? index.get(key) : undefined;
    if (lib) {
      // Keep the consumer's cached metadata (REST reads the same copy);
      // only the node id is un-seeable from the consumer file.
      rewritten[lib.nodeId] = meta;
      rename.set(markerId, lib.nodeId);
      if (meta?.remote === true) resolved++;
      continue;
    }
    if (meta?.remote === true && key) {
      unresolvedByMarker.set(markerId, { key, name: meta.name ?? "", usedBy: [] });
    }
    rewritten[markerId] = meta; // local or unresolved-remote: unchanged
  }
  frame.styles = rewritten;

  // Pass 2 — node.styles bindings: rename values, collect usedBy.
  const unresolvedByKey = new Map<string, UnresolvedStyle>();
  for (const u of unresolvedByMarker.values()) unresolvedByKey.set(u.key, u);
  for (const node of walkNodes(frame?.document)) {
    const bindings = node.styles;
    if (!bindings || typeof bindings !== "object") continue;
    const hits = new Set<string>(); // distinct unresolved keys bound on this node
    for (const [field, value] of Object.entries(bindings)) {
      if (typeof value !== "string") continue;
      const to = rename.get(value);
      if (to !== undefined) bindings[field] = to;
      else {
        const entry = unresolvedByMarker.get(value);
        if (entry) hits.add(entry.key);
      }
    }
    for (const key of hits) unresolvedByKey.get(key)?.usedBy.push(node.id);
  }

  return { resolved, unresolved: [...unresolvedByMarker.values()] };
}

/**
 * Collect the unresolved-remote-style report for a whole file: every remote
 * style across all stored frames with no harvest entry, with usedBy node ids.
 */
export function collectUnresolvedStyles(
  frames: any[],
  index: Map<string, HarvestedStyle>,
): UnresolvedStyle[] {
  const byKey = new Map<string, UnresolvedStyle>();
  for (const f of frames) {
    const { unresolved } = rewriteFrameStyles(f, index);
    for (const u of unresolved) {
      const existing = byKey.get(u.key);
      if (existing) existing.usedBy.push(...u.usedBy.filter((id) => !existing.usedBy.includes(id)));
      else byKey.set(u.key, { ...u });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Round 5 (D4) — load ONE file's prototype-transition table. Node ids are
 * file-scoped, so — unlike the styles index — tables are never merged
 * across files: only the bootstrap of the file being served applies.
 */
export function loadTransitionTable(
  librariesDir: string,
  realFileKey: string,
): Map<string, HarvestedTransition> {
  const table = new Map<string, HarvestedTransition>();
  let harvest: LibraryHarvest | null = null;
  try {
    harvest = JSON.parse(
      fs.readFileSync(path.join(librariesDir, `bootstrap_${safeFileName(realFileKey)}.json`), "utf8"),
    );
  } catch {
    return table; // no bootstrap for this file — degradation, not an error
  }
  for (const [nodeId, t] of Object.entries(harvest?.transitions ?? {})) {
    if (nodeId && t?.transitionNodeID) table.set(nodeId, t);
  }
  return table;
}

/**
 * Round 5 (D4) — inject a file's prototype-transition records into a stored
 * frame at persist time. The plugin derives `transitionNodeID` itself from
 * reactions (`action.destinationId` is the library-side node id), so the
 * table only fills it when missing; `transitionDuration`/`transitionEasing`
 * are server-side state the plugin cannot see at all (deviation #16), so a
 * table entry is authoritative for them. Nodes not in the table are
 * untouched; injection is idempotent.
 */
export function applyTransitionTable(
  frame: any,
  table: Map<string, HarvestedTransition>,
): number {
  if (!table.size) return 0;
  let injected = 0;
  for (const node of walkNodes(frame?.document)) {
    const t = typeof node.id === "string" ? table.get(node.id) : undefined;
    if (!t) continue;
    if (node.transitionNodeID === undefined && t.transitionNodeID !== undefined) {
      node.transitionNodeID = t.transitionNodeID;
    }
    if (t.transitionDuration !== undefined) node.transitionDuration = t.transitionDuration;
    if (t.transitionEasing !== undefined) node.transitionEasing = t.transitionEasing;
    injected++;
  }
  return injected;
}
