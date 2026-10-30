// Round 15 — flexbox translation of the design's auto-layout.
//
// Field report: agents style from bounding-box pixels because they are the
// path of least resistance, even though the tree carries the design's
// LAYOUT INTENT (auto-layout hug/fill/fixed, gaps, padding, alignment).
// Mapping Figma's auto-layout to flexbox 1:1 makes the CSS inherit that
// intent. This digest hands agents the translation so the easy path is
// also the correct one.
//
// Mapping (Figma → CSS):
//   layoutMode            → flex-direction: row | column
//   itemSpacing           → gap
//   padding*              → padding
//   primaryAxisAlignItems → justify-content (flex-start/center/flex-end/space-between)
//   counterAxisAlignItems → align-items (flex-start/center/flex-end/baseline)
//   layoutWrap WRAP       → flex-wrap: wrap
//   child FIXED           → width/height in px (from the bounding box)
//   child HUG            → fit-content
//   child FILL           → flex:1 on the parent's main axis, align-self:stretch on the cross axis
//   layoutGrow           → flex-grow
//   layoutAlign (legacy) → align-self
//
// Both sizing schema generations are supported: the modern
// layoutSizingHorizontal/Vertical and the legacy
// primaryAxisSizingMode/counterAxisSizingMode pair.

export interface FlexLayoutOptions {
  /** Per-frame node cap — the digest stops and says so. Default 400. */
  maxNodes?: number;
}

export interface FlexLayoutFrame {
  id: string;
  name: string;
  document: unknown;
}

interface WalkNode {
  id?: string;
  name?: string;
  type?: string;
  children?: unknown;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  layoutWrap?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  layoutGrow?: number;
  layoutAlign?: string;
  absoluteBoundingBox?: { width: number; height: number };
}

function isAuto(n: WalkNode): boolean {
  return n.layoutMode === "HORIZONTAL" || n.layoutMode === "VERTICAL";
}

/** Resolve a node's sizing semantics on one axis, handling both schema
 *  generations. Returns "FIXED" | "HUG" | "FILL" (or raw value). */
export function axisSizing(n: WalkNode, axis: "horizontal" | "vertical"): string {
  const modern = axis === "horizontal" ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  if (typeof modern === "string" && modern) return modern;
  // legacy: the primary axis follows layoutMode; the other is counter.
  const horizontalIsPrimary = n.layoutMode === "HORIZONTAL";
  const legacy =
    axis === "horizontal"
      ? horizontalIsPrimary
        ? n.primaryAxisSizingMode
        : n.counterAxisSizingMode
      : horizontalIsPrimary
        ? n.counterAxisSizingMode
        : n.primaryAxisSizingMode;
  if (typeof legacy === "string" && legacy) return legacy;
  return "FIXED";
}

const JUSTIFY: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};

const ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  BASELINE: "baseline",
  STRETCH: "stretch",
};

function oneLine(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function rounded(v: number | undefined): number {
  return Math.round(Number(v ?? 0));
}

/** The flexbox declaration line for an auto-layout container. */
function containerCss(n: WalkNode): string {
  const decls: string[] = ["display: flex"];
  decls.push(`flex-direction: ${n.layoutMode === "VERTICAL" ? "column" : "row"}`);
  if (typeof n.itemSpacing === "number" && n.itemSpacing > 0) {
    decls.push(`gap: ${rounded(n.itemSpacing)}px`);
  }
  const pads = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
  if (pads.some((p) => typeof p === "number" && p > 0)) {
    decls.push(`padding: ${pads.map((p) => `${rounded(p)}px`).join(" ")}`);
  }
  const jc = JUSTIFY[String(n.primaryAxisAlignItems ?? "")];
  if (jc && jc !== "flex-start") decls.push(`justify-content: ${jc}`);
  const ai = ALIGN[String(n.counterAxisAlignItems ?? "")];
  if (ai && ai !== "flex-start") decls.push(`align-items: ${ai}`);
  if (n.layoutWrap === "WRAP") decls.push("flex-wrap: wrap");
  return decls.join("; ") + ";";
}

/** Sizing phrase for one axis of a child inside an auto-layout parent. */
function childAxisPhrase(n: WalkNode, axis: "horizontal" | "vertical", primaryAxis: "horizontal" | "vertical"): string {
  const sizing = axisSizing(n, axis);
  const bb = n.absoluteBoundingBox;
  const px = axis === "horizontal" ? rounded(bb?.width) : rounded(bb?.height);
  if (sizing === "HUG") return `${axis === "horizontal" ? "w" : "h"}:fit-content`;
  if (sizing === "FILL") {
    return axis === primaryAxis ? `${axis === "horizontal" ? "w" : "h"}:flex:1` : `${axis === "horizontal" ? "w" : "h"}:stretch`;
  }
  if (sizing === "INTRINSIC") return `${axis === "horizontal" ? "w" : "h"}:fit-content`;
  return `${axis === "horizontal" ? "w" : "h"}:${px}px`;
}

/** Full child note: both axes + grow/align overrides. */
function childNote(n: WalkNode, parentLayoutMode: string): string {
  const primaryAxis = parentLayoutMode === "VERTICAL" ? "vertical" : "horizontal";
  const parts = [childAxisPhrase(n, "horizontal", primaryAxis), childAxisPhrase(n, "vertical", primaryAxis)];
  if (typeof n.layoutGrow === "number" && n.layoutGrow > 0) parts.push(`flex-grow:${rounded(n.layoutGrow)}`);
  const selfAlign = ALIGN[String(n.layoutAlign ?? "")];
  if (selfAlign && n.layoutAlign !== "INHERIT") parts.push(`align-self:${selfAlign}`);
  return parts.join(" · ");
}

/**
 * Build the flex digest for one or more stored frames: per auto-layout
 * node, its paste-ready flexbox declaration line plus every child's
 * sizing translation (fixed px / fit-content / flex-grow / stretch).
 * Non-auto frames produce a single "no auto-layout" line — that is
 * itself information (absolute positioning / CSS grid territory).
 */
export function buildFlexLayout(frames: FlexLayoutFrame[], opts: FlexLayoutOptions = {}): string {
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 400, 2000));
  const out: string[] = [];

  for (const frame of frames) {
    const lines: string[] = [];
    let count = 0;
    let truncated = false;

    const walk = (node: unknown, depth: number): void => {
      if (truncated) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth);
        return;
      }
      if (!node || typeof node !== "object") return;
      const n = node as WalkNode;
      const indent = "  ".repeat(depth);
      const id = typeof n.id === "string" ? n.id : "?";
      const name = oneLine(n.name) || "(unnamed)";
      const bb = n.absoluteBoundingBox;
      const sz = bb ? ` · ${rounded(bb.width)}x${rounded(bb.height)}` : "";

      if (isAuto(n)) {
        if (++count > maxNodes) {
          truncated = true;
          return;
        }
        const dir = n.layoutMode === "VERTICAL" ? "column" : "row";
        lines.push(`${indent}"${name}" (${id}) · flex ${dir}${sz}`);
        lines.push(`${indent}  ${containerCss(n)}`);
        const kids = Array.isArray(n.children) ? (n.children as WalkNode[]) : [];
        const noted = kids.filter((k) => k && typeof k === "object" && String(k.type) !== "TEXT");
        if (noted.length) {
          lines.push(`${indent}  children:`);
          for (const k of noted) {
            const kid = k as WalkNode;
            const kidId = typeof kid.id === "string" ? kid.id : "?";
            lines.push(`${indent}  · "${oneLine(kid.name) || "(unnamed)"}" (${kidId}): ${childNote(kid, String(n.layoutMode))}`);
          }
        }
        if (Array.isArray(n.children)) walk(n.children, depth + 1);
      } else if (Array.isArray(n.children)) {
        walk(n.children, depth);
      }
    };

    const root = frame.document as WalkNode;
    if (root && isAuto(root)) {
      walk(root, 0);
    } else {
      // top-level frame without auto-layout: still worth one line
      lines.push(`"${oneLine(frame.name)}" (${frame.id}) · no auto-layout (absolutely positioned children)`);
      if (Array.isArray(root?.children)) walk(root.children, 0);
    }

    if (truncated) {
      lines.push(`… flex digest truncated at ${maxNodes} nodes — pass frameIds to narrow`);
    }
    lines.unshift(`== ${frame.id} "${oneLine(frame.name)}" · flex layout ==`);
    out.push(lines.join("\n"));
  }

  return out.join("\n\n");
}
