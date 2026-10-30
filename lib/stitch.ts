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

/**
 * Find a node id inside the stored frame documents — child ids resolve
 * without a plugin round-trip because the subtree is already in the
 * store (agent field report: silent child-id misses were the #1 gap).
 * Returns the owning frame and the node's subtree.
 */
export function findNodeDocument(
  frames: StoredFrame[],
  id: string,
): { frame: StoredFrame; node: Record<string, unknown> } | null {
  for (const frame of frames) {
    const stack: Record<string, unknown>[] = [frame.document];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur.id === id) return { frame, node: cur };
      const kids = cur.children as Record<string, unknown>[] | undefined;
      if (Array.isArray(kids)) for (const k of kids) stack.push(k);
    }
  }
  return null;
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
    // REST requires prototypeDevice on canvases. The plugin cannot read
    // prototype/device settings, so we emit the no-device default (the
    // corpus's second page carries exactly this value) — documented
    // deviation. prototypeBackgrounds is optional and omitted.
    prototypeDevice: { type: "NONE", rotation: "NONE" },
    scrollBehavior: "SCROLLS" as const,
    children:
      opts.depth !== undefined && opts.depth <= 1
        ? // REST depth=1 returns pages only — canvases with no children.
          []
        : page.children
            .filter((c) => !wanted || wanted.has(c.id))
            .map((c) => {
              const stored = byId.get(c.id);
              if (stored) {
                // REST counts depth from the DOCUMENT root: pages are
                // depth 1, top-level objects depth 2, their children
                // depth 3 (spec: /v1/files/{key} depth parameter).
                // `stored.document` is already a depth-2 frame, so the
                // levels below it are depth - 2.
                const doc =
                  opts.depth !== undefined
                    ? pruneDepth(stored.document, Math.max(0, opts.depth - 2))
                    : stored.document;
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
    linkAccess: "inherit",
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
 *
 * The wrapper mirrors GetFileNodesResponse: `name`, `role`, `lastModified`,
 * `editorType`, `thumbnailUrl`, `version`, `linkAccess` at the top level and
 * NO `name` on entries (spec 0.44.0; live-measured 2026-10-17 against a real
 * /nodes response — see deviations doc #33). Real success wrappers carry no
 * `err` (that field belongs to error payloads and /images), so neither do
 * we. `linkAccess` is plugin-invisible; we emit the file envelope's constant
 * "inherit" (documented deviation, same rationale as buildFileEnvelope).
 */
export function buildNodesResponse(
  frames: StoredFrame[],
  opts: EnvelopeOptions = {},
  meta?: { fileKey: string },
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  for (const f of frames) {
    // depth on the nodes endpoint counts from the requested node itself
    // (spec: "will be counted starting from the desired node") — so the
    // plain pruneDepth call is already correct here.
    nodes[f.id] = {
      document: opts.depth !== undefined ? pruneDepth(f.document, opts.depth) : f.document,
      components: f.components ?? {},
      componentSets: f.componentSets ?? {},
      schemaVersion: f.schemaVersion ?? 0,
      styles: f.styles ?? {},
    };
  }
  const extractedAt = frames
    .map((f) => (f._figmaAgent?.extractedAt as string | undefined) ?? "")
    .sort()
    .pop();
  return {
    name: "Figma Agent Local File",
    role: "owner",
    lastModified: extractedAt || new Date(0).toISOString(),
    editorType: "figma",
    thumbnailUrl: "", // no local thumbnail source — documented deviation
    version: `local-${meta?.fileKey ?? "unknown"}`,
    linkAccess: "inherit",
    nodes,
  };
}
