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
 * `store/libraries/<fileKey>.json`. Because `figma.fileKey` is available in
 * the plugin sandbox, a library harvest is named by the library's real REST
 * file key.
 *
 * Consumer side: at persist time (saveFrame), remote style entries in the
 * frame's `styles` map are re-keyed from the marker id to the library node
 * id, and `node.styles` binding values are renamed to match. The consumer's
 * own metadata (name/description/styleType) is kept — REST reads the same
 * cached copy the consumer file stores — only the un-seeable nodeId comes
 * from the harvest.
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
}

/** A remote style the bridge could not resolve — operator to-do item. */
export interface UnresolvedStyle {
  key: string;
  name: string;
  usedBy: string[];
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
  for (const [nodeId, entry] of Object.entries(stylesByNodeId ?? {})) {
    if (!entry?.key || !nodeId) continue;
    styles[entry.key] = {
      nodeId,
      name: entry.name ?? "",
      description: entry.description ?? "",
      styleType: entry.styleType ?? "",
    };
  }
  if (!Object.keys(styles).length) return null;
  const harvest: LibraryHarvest = { fileKey, harvestedAt: now.toISOString(), styles };
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
      if (style?.nodeId) index.set(key, style);
    }
  }
  return index;
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
 * Rewrite a stored frame in place (idempotent): re-key remote `styles` map
 * entries from consumer marker ids to library node ids and rename the
 * matching `node.styles` binding values. Local styles and unresolved remote
 * styles pass through untouched.
 */
export function rewriteFrameStyles(frame: any, index: Map<string, HarvestedStyle>): RewriteResult {
  const styles = frame?.styles;
  if (!styles || typeof styles !== "object") return { resolved: 0, unresolved: [] };

  // Pass 1 — styles map: marker id → library node id for harvested remotes.
  const rename = new Map<string, string>(); // markerId → library nodeId
  const unresolvedByMarker = new Map<string, UnresolvedStyle>(); // markerId → entry
  const rewritten: Record<string, unknown> = {};
  let resolved = 0;
  for (const [markerId, raw] of Object.entries(styles)) {
    const meta = raw as PageIndexStyleEntry;
    if (meta?.remote === true && typeof meta.key === "string") {
      const lib = index.get(meta.key);
      if (lib) {
        // Keep the consumer's cached metadata (REST reads the same copy);
        // only the node id is un-seeable from the consumer file.
        rewritten[lib.nodeId] = meta;
        rename.set(markerId, lib.nodeId);
        resolved++;
        continue;
      }
      unresolvedByMarker.set(markerId, { key: meta.key, name: meta.name ?? "", usedBy: [] });
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
