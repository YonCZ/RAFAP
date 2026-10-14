/**
 * Bridge-side envelope stitching — pure, testable. Turns the plugin's
 * stored artifacts (pages.json + per-frame payloads) into REST-shaped
 * responses for the /v1 routes (agent.md §7.1, §8.5).
 *
 * Shapes per figma/rest-api-spec:
 *   GET /v1/files/:key      → tree at `document`
 *   GET /v1/files/:key/nodes → tree at `nodes[id].document`  (asymmetry!)
 */

export interface StoredPageChild {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: Record<string, number>;
}

export interface StoredPage {
  id: string;
  name: string;
  type: "CANVAS";
  backgroundColor: { r: number; g: number; b: number; a: number };
  children: StoredPageChild[];
}

export interface StoredPageIndex {
  fileKey: string;
  pages: StoredPage[];
}

export interface StoredFrame {
  id: string;
  name: string;
  document: Record<string, unknown>;
  components?: Record<string, unknown>;
  componentSets?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  schemaVersion?: number;
  fileKey?: string;
  _figmaAgent?: Record<string, unknown>;
}

/** Frame ids contain ":" — make them filename-safe (and reversible). */
export function frameFileName(id: string): string {
  return id.replace(/:/g, "_");
}

/** Merge every frame's component/style maps into file-level maps. */
function aggregate(
  frames: StoredFrame[],
  key: "components" | "componentSets" | "styles",
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const f of frames) {
    const map = f[key];
    if (map) Object.assign(merged, map);
  }
  return merged;
}

/** Recursively prune children past `depth` (REST prunes server-side). */
export function pruneDepth(node: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth <= 0) {
    const clone = { ...node };
    delete clone.children;
    return clone;
  }
  const kids = node.children as Record<string, unknown>[] | undefined;
  if (!Array.isArray(kids)) return node;
  return { ...node, children: kids.map((c) => pruneDepth(c, depth - 1)) };
}

export interface EnvelopeOptions {
  depth?: number;
  ids?: string[];
}

/**
 * Build the `GET /v1/files/:key` response body.
 * `pages` defines the CANVAS structure; `frames` are stored subtrees keyed
 * by id. Frames not (yet) extracted appear as page-child stubs so partial
 * pulls still render a coherent envelope.
 */
export function buildFileEnvelope(
  pageIndex: StoredPageIndex,
  frames: StoredFrame[],
  opts: EnvelopeOptions = {},
): Record<string, unknown> {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const wanted = opts.ids ? new Set(opts.ids) : null;
  const extractedAt = frames
    .map((f) => (f._figmaAgent?.extractedAt as string | undefined) ?? "")
    .sort()
    .pop();

  const canvases = pageIndex.pages.map((page) => ({
    id: page.id,
    name: page.name,
    type: "CANVAS" as const,
    backgroundColor: page.backgroundColor,
    prototypeStartNodeID: null,
    flowStartingPoints: [],
    children: page.children
      .filter((c) => !wanted || wanted.has(c.id))
      .map((c) => {
        const stored = byId.get(c.id);
        if (stored) {
          const doc = opts.depth ? pruneDepth(stored.document, opts.depth) : stored.document;
          return { ...doc, children: (doc as { children?: unknown[] }).children ?? [] };
        }
        // not extracted yet — the stub (id/name/type/bounds) keeps the
        // envelope structurally valid
        return { ...c, children: [] };
      }),
  }));

  return {
    name: "Figma Agent Local File",
    role: "owner",
    lastModified: extractedAt || new Date(0).toISOString(),
    editorType: "figma",
    version: `local-${pageIndex.fileKey}`,
    schemaVersion: 0,
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: canvases,
    },
    components: aggregate(frames, "components"),
    componentSets: aggregate(frames, "componentSets"),
    styles: aggregate(frames, "styles"),
    _figmaAgent: {
      source: "plugin",
      frameCount: frames.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Build the `GET /v1/files/:key/nodes?ids=…` response body — each subtree
 * nested under `nodes[id].document` with its own component maps.
 */
export function buildNodesResponse(
  frames: StoredFrame[],
  opts: EnvelopeOptions = {},
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  for (const f of frames) {
    nodes[f.id] = {
      document: opts.depth ? pruneDepth(f.document, opts.depth) : f.document,
      components: f.components ?? {},
      componentSets: f.componentSets ?? {},
      schemaVersion: f.schemaVersion ?? 0,
      styles: f.styles ?? {},
      name: f.name,
    };
  }
  return { nodes, err: null };
}
