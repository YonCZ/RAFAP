// Bridge-side design outline — the "understanding" view over stored frames.
//
// get_file/get_nodes return REST-shaped JSON: faithful, but enormous, and
// a depth-limited pull silently prunes children (agents then misread
// pruned frames as "empty"). get_outline is the cheap alternative: one
// indented text tree per frame with every node's id/name/type/size,
// auto-layout summary, child counts, and the FULL text content of TEXT
// nodes — and none of the paints/fills/effects JSON that makes the REST
// payloads 10-100x larger. One call = whole-design comprehension.

export interface OutlineOptions {
  /** Per-frame node cap — the outline stops and says so. Default 400. */
  maxNodes?: number;
  /** TEXT characters truncation length. Default 80. */
  maxTextChars?: number;
}

export interface OutlinableFrame {
  id: string;
  name: string;
  document: unknown;
}

interface WalkNode {
  id?: string;
  name?: string;
  type?: string;
  children?: unknown;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  visible?: boolean;
}

/** Collapse all whitespace runs to single spaces (newlines in TEXT
 *  characters would break the one-line-per-node format). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function size(n: WalkNode): string {
  const b = n.absoluteBoundingBox;
  if (!b || typeof b.width !== "number" || typeof b.height !== "number") return "";
  return `${Math.round(b.width)}x${Math.round(b.height)}`;
}

/** Auto-layout one-liner: `auto:H gap 12 pad T24 R8 size V:fixed H:fill
 *  align main:center cross:baseline` — non-zero paddings only; sizing and
 *  alignment shown when they differ from the plain FIXED/MIN defaults
 *  (hug/fill and centered/space-between are layout intent — see
 *  lib/flex-layout.ts for the full CSS translation). Omitted entirely
 *  for absolutely-positioned nodes. */
function layoutSummary(n: WalkNode): string {
  const parts: string[] = [];
  const vertical = n.layoutMode === "VERTICAL";
  if (n.layoutMode === "HORIZONTAL" || vertical) parts.push(vertical ? "auto:V" : "auto:H");
  else return "";
  if (typeof n.itemSpacing === "number" && n.itemSpacing > 0) {
    parts.push(`gap ${Math.round(n.itemSpacing)}`);
  }
  const pad: string[] = [];
  if (n.paddingTop) pad.push(`T${Math.round(n.paddingTop)}`);
  if (n.paddingRight) pad.push(`R${Math.round(n.paddingRight)}`);
  if (n.paddingBottom) pad.push(`B${Math.round(n.paddingBottom)}`);
  if (n.paddingLeft) pad.push(`L${Math.round(n.paddingLeft)}`);
  if (pad.length) parts.push(`pad ${pad.join(" ")}`);
  // sizing semantics (both schema generations; FIXED default stays implicit)
  const hIsPrimary = n.layoutMode === "HORIZONTAL";
  const sizing = (axis: "horizontal" | "vertical"): string => {
    const modern = axis === "horizontal" ? n.layoutSizingHorizontal : n.layoutSizingVertical;
    if (typeof modern === "string" && modern) return modern;
    const legacy =
      axis === "horizontal"
        ? hIsPrimary
          ? n.primaryAxisSizingMode
          : n.counterAxisSizingMode
        : hIsPrimary
          ? n.counterAxisSizingMode
          : n.primaryAxisSizingMode;
    return typeof legacy === "string" && legacy ? legacy : "FIXED";
  };
  const sV = sizing("vertical").toLowerCase();
  const sH = sizing("horizontal").toLowerCase();
  if (sV !== "fixed" || sH !== "fixed") parts.push(`size V:${sV} H:${sH}`);
  const main = String(n.primaryAxisAlignItems ?? "");
  const cross = String(n.counterAxisAlignItems ?? "");
  if (main && main !== "MIN" || cross && cross !== "MIN") {
    parts.push(`align main:${main.toLowerCase() || "min"} cross:${cross.toLowerCase() || "min"}`);
  }
  return parts.join(" ");
}

/**
 * Build the outline for one or more stored frames: one indented text tree
 * per frame, blank line between frames. Nodes are never pruned by depth —
 * that is the whole point — but each frame is capped at `maxNodes` nodes
 * (the outline says so when it happens; narrow with frameIds or switch to
 * get_nodes for the pruned detail).
 */
export function buildOutline(frames: OutlinableFrame[], opts: OutlineOptions = {}): string {
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 400, 2000));
  const maxText = Math.max(8, Math.min(opts.maxTextChars ?? 80, 400));
  const out: string[] = [];

  for (const frame of frames) {
    const lines: string[] = [];
    let count = 0;
    let truncated = false;

    const walk = (node: unknown, depth: number): void => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth);
        return;
      }
      if (!node || typeof node !== "object") return;
      const n = node as WalkNode;
      if (++count > maxNodes) {
        truncated = true;
        return;
      }
      const id = typeof n.id === "string" ? n.id : "?";
      const type = typeof n.type === "string" ? n.type : "NODE";
      const indent = "  ".repeat(depth);
      const sz = size(n);
      const hidden = n.visible === false ? " · [hidden]" : "";

      if (type === "TEXT" && typeof n.characters === "string") {
        let chars = oneLine(n.characters);
        if (chars.length > maxText) chars = `${chars.slice(0, maxText - 1)}…`;
        lines.push(`${indent}"${chars}" · ${id} · TEXT${sz ? ` · ${sz}` : ""}${hidden}`);
      } else {
        const parts = [`"${typeof n.name === "string" ? oneLine(n.name) : ""}"`, id, type];
        if (sz) parts.push(sz);
        const kids = Array.isArray(n.children) ? n.children.length : 0;
        if (kids) parts.push(`${kids} ch`);
        const layout = layoutSummary(n);
        if (layout) parts.push(layout);
        lines.push(`${indent}${parts.join(" · ")}${hidden}`);
        if (Array.isArray(n.children)) walk(n.children, depth + 1);
      }
    };

    // The document root's id/name/type/size live in the header line — walk
    // only its children so nothing is printed twice.
    const root = frame.document as WalkNode;
    if (root && Array.isArray(root.children)) walk(root.children, 0);

    const rootSz = root ? size(root) : "";
    const total = truncated ? `${maxNodes}+` : String(count);
    lines.unshift(
      `== ${frame.id} "${oneLine(frame.name)}" · ${root?.type ?? "FRAME"}${rootSz ? ` · ${rootSz}` : ""} · ${total} nodes ==`,
    );
    if (truncated) {
      lines.push(`… outline truncated at ${maxNodes} nodes — pass frameIds to narrow, or get_nodes for targeted detail`);
    }
    out.push(lines.join("\n"));
  }

  return out.join("\n\n");
}
