// Bridge-side node search — REST has no equivalent (the /v1/files endpoints
// return whole subtrees with no query surface), so this is the differentiator
// tool: a lightweight index over the stored frames, matched by node name,
// TEXT content, or node type.

export interface SearchHit {
  id: string;
  name: string;
  type: string;
  /** The top-level frame (stored subtree) the node lives in. */
  frameId: string;
  frameName: string;
  fileKey?: string;
  /** What criterion matched — "name"/"text" for query hits, "type" for
   *  type-only filters. */
  matchedOn?: "name" | "text" | "type";
  /** TEXT characters preview (≤60 chars + ellipsis). */
  characters?: string;
}

export interface SearchOptions {
  /** Case-insensitive substring matched against node name (all types) and
   *  characters (TEXT nodes). */
  query?: string;
  /** Exact node type, case-insensitive ("frame" ≡ "FRAME"). */
  type?: string;
  /** Match cap — default 50 (the index walks whole documents). */
  limit?: number;
}

interface WalkableNode {
  id?: string;
  name?: string;
  type?: string;
  children?: unknown;
  characters?: string;
}

export interface SearchableFrame {
  id: string;
  name: string;
  document: unknown;
  fileKey?: string;
}

function walk(node: unknown, out: WalkableNode[]): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as WalkableNode;
  out.push(n);
  if (Array.isArray(n.children)) walk(n.children, out);
}

/**
 * Search stored frames by name, text content, and/or node type.
 * When both `query` and `type` are given they AND. Returns hits capped at
 * `limit`, deepest-last (document order). Throws when neither criterion is
 * given — an unconstrained "search" would just be a node dump.
 */
export function searchNodes(frames: SearchableFrame[], opts: SearchOptions = {}): SearchHit[] {
  const query = typeof opts.query === "string" ? opts.query.trim() : "";
  const type = typeof opts.type === "string" ? opts.type.trim().toUpperCase() : "";
  if (!query && !type) {
    throw new Error("search_nodes needs a query (name/text substring) and/or a type (node type, e.g. 'TEXT')");
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const frame of frames) {
    const nodes: WalkableNode[] = [];
    walk(frame.document, nodes);
    for (const n of nodes) {
      if (hits.length >= limit) return hits;
      if (typeof n.id !== "string" || typeof n.type !== "string") continue;
      if (type && n.type.toUpperCase() !== type) continue;
      let matchedOn: "name" | "text" | undefined;
      if (query) {
        const nameHit = typeof n.name === "string" && n.name.toLowerCase().includes(needle);
        const textHit = n.type === "TEXT" && typeof n.characters === "string" && n.characters.toLowerCase().includes(needle);
        if (!nameHit && !textHit) continue;
        matchedOn = nameHit ? "name" : "text";
      }
      hits.push({
        id: n.id,
        name: typeof n.name === "string" ? n.name : "",
        type: n.type,
        frameId: frame.id,
        frameName: frame.name,
        fileKey: frame.fileKey,
        matchedOn: query ? matchedOn : "type",
        characters:
          n.type === "TEXT" && typeof n.characters === "string"
            ? n.characters.length > 60
              ? `${n.characters.slice(0, 60)}…`
              : n.characters
            : undefined,
      });
    }
  }
  return hits;
}
