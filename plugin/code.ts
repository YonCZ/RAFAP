/**
 * Figma Agent plugin v3 — REST-parity design-tree extractor.
 *
 * Output mirrors GET https://api.figma.com/v1/files/:file_key per
 * figma/rest-api-spec (see agent.md §7). Our extensions (SVG markup,
 * render bounds) live under `_figmaAgent` — a strict superset of the
 * REST API, never a subset. One deliberate REST addition (Round 16.2):
 * `rotation` (degrees, non-zero only) on every scene node — REST omits
 * it, but agents rebuilding the design need it.
 *
 * Commands (all execute in the sandbox, results relay via ui.html):
 *   push buttons   → export-selection · export-page-index
 *   pull commands  → page-index · frame{id} · selection · export{ids}
 *
 * Serialization contract (agent.md §7.2):
 *   B1 invariant core (id/name/type/absoluteBoundingBox/visible/children)
 *   B2 omit absent props exactly like REST (never null/undefined)
 *   B3 "figma::mixed" sentinel for mixed values
 *   B4 unknown node types pass through with core + children
 *   B5 extensions namespaced under _figmaAgent
 */
import {
  MIXED,
  buildTextOverrides,
  buildTypeStyle,
  flatMainKey,
  mapColor,
  mapConstraints,
  mapEffects,
  mapPaints,
  omitEmpty,
  styleIdValue,
  type SegmentInput,
  type StyleSource,
} from "./lib/rest-mapping";

const PLUGIN_VERSION = "4.0.1";
const MAX_NODES_PER_EXTRACTION = 20000;

figma.showUI(__html__, { width: 220, height: 52 });

// ---------------------------------------------------------------------------
// postMessage plumbing — symbols (figma.mixed) cannot cross postMessage;
// the mapping layer converts them to "figma::mixed" deliberately, this is
// the safety net for any stragglers.
// ---------------------------------------------------------------------------

function sanitize(value: unknown): unknown {
  if (typeof value === "symbol") return "figma::mixed";
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) {
      const v = sanitize((value as Record<string, unknown>)[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

function postToUI(msg: unknown) {
  figma.ui.postMessage(sanitize(msg));
}

// ---------------------------------------------------------------------------
// Round 7 (C2) — runtime font-metrics probing for unseen families
// ---------------------------------------------------------------------------

/**
 * Discover the largest font size Figma accepts on a scratch text node —
 * huge values may clamp or throw; the read-back is the truth.
 */
function discoverMaxFontSize(t: TextNode): number {
  for (const candidate of [100000, 50000, 20000, 10000, 5000, 2000]) {
    try {
      t.fontSize = candidate;
      const rb = t.fontSize;
      if (typeof rb === "number" && rb >= 1000) return Math.min(rb, candidate);
    } catch {
      /* try the next smaller candidate */
    }
  }
  return 1000;
}

/**
 * Measure per-family intrinsic line-height multipliers the bridge cannot
 * know for files outside the corpus. A scratch TEXT node is created, its
 * AUTO line height sampled across two bands of large font sizes, and the
 * node removed — all inside this one command, so it lands as a single undo
 * step in the document. Layout rounds line heights to integer px per line;
 * the many per-size samples let the bridge intersect the rounding windows
 * and recover the exact multiplier. Human-triggered only (undo stack +
 * dirty flag); never during pulls. With no `requested` list, every unique
 * font in the current document is probed.
 */
async function probeFonts(requested?: { family: string; style?: string }[]): Promise<unknown> {
  const wanted: FontName[] = [];
  if (Array.isArray(requested) && requested.length) {
    for (const f of requested) {
      if (typeof f?.family === "string" && f.family) {
        wanted.push({ family: f.family, style: typeof f.style === "string" ? f.style : "Regular" });
      }
    }
  } else {
    // dynamic page loading: pages must be loaded before their children are
    // readable (same rule as buildPageIndex)
    await figma.loadAllPagesAsync();
    const seen = new Set<string>();
    const visit = (node: BaseNode): void => {
      if (node.type === "TEXT") {
        const t = node as TextNode;
        const fn = (t as unknown as { fontName: FontName | typeof figma.mixed }).fontName;
        if (fn && fn !== figma.mixed) {
          seen.add(`${fn.family}\u0000${fn.style}`);
        } else {
          for (let i = 0; i < t.characters.length; i++) {
            const r = t.getRangeFontName(i, i + 1) as FontName;
            if (r) seen.add(`${r.family}\u0000${r.style}`);
          }
        }
      }
      for (const c of (node as ChildrenMixin).children ?? []) visit(c);
    };
    for (const page of figma.root.children) visit(page);
    for (const key of seen) {
      const [family, style] = key.split("\u0000");
      wanted.push({ family, style });
    }
  }

  const fonts: Record<string, unknown>[] = [];
  // figma.createText() starts with the default font (Inter Regular); it must
  // be loaded before any write to the scratch node.
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  for (const font of wanted) {
    const entry: Record<string, unknown> = { family: font.family, style: font.style };
    try {
      await figma.loadFontAsync(font);
      const t = figma.createText();
      try {
        t.textAutoResize = "HEIGHT";
        t.fontName = font;
        t.lineHeight = { unit: "AUTO" };
        t.characters = "Ag\nAg\nAg\nAg\nAg"; // ascenders + descenders, 5 lines
        // Sample several large sizes: line-height layout rounds to integer
        // px per line, so a single size only bounds the multiplier to
        // ±0.5/size. The bridge intersects the per-size windows (each
        // sample: m ∈ [(L−0.5)/S, (L+0.5)/S]) to recover the underlying
        // multiplier to well past the normalizer's 4 decimals.
        const samples: { size: number; linePx: number }[] = [];
        {
          const cap = discoverMaxFontSize(t);
          // Width covers "Ag" at the largest sampled size (wrapping would
          // double the line count and empty the bridge-side intersection).
          t.resize(cap * 3, t.height);
          // Two bands of descending sizes. Each sample bounds the multiplier
          // to ±0.5/size; ~4e7 total (count × size) recovers it to ~5e-8 —
          // far past the normalizer's 4 decimals. The second band at half
          // the size doubles as the linearity guard.
          const nHi = Math.min(3000, Math.max(200, Math.ceil(4e7 / cap)), cap - 200);
          const half = Math.floor(cap / 2);
          const nLo = Math.max(50, Math.min(1500, Math.ceil(nHi / 2), half - 100));
          for (let i = 0; i < nHi; i++) {
            t.fontSize = cap - i;
            samples.push({ size: t.fontSize, linePx: t.height / 5 });
          }
          for (let i = 0; i < nLo; i++) {
            t.fontSize = half - i;
            samples.push({ size: t.fontSize, linePx: t.height / 5 });
          }
        }
        entry.samples = samples;
      } finally {
        t.remove(); // create + measure + remove = one undo step
      }
    } catch (e) {
      entry.error = (e as Error).message ?? String(e);
    }
    fonts.push(entry);
  }
  return { fonts, probedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "export-selection") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("⚠️ Please select a frame first!");
      return;
    }
    const frames: any[] = [];
    for (const node of selection) {
      try {
        frames.push(await extractFramePayload(node));
      } catch (e) {
        figma.notify(`⚠️ ${node.name}: ${(e as Error).message}`);
      }
    }
    if (frames.length) postToUI({ type: "selection-data", payload: frames });
  }

  if (msg.type === "export-page-index") {
    postToUI({ type: "page-index-data", payload: await buildPageIndex() });
  }

  // Pull mode: a command the agent queued on the bridge, forwarded by the UI.
  if (msg.type === "agent-command") {
    const { commandId, commandType, params } = msg;
    try {
      let payload: any;
      if (commandType === "page-index") {
        payload = await buildPageIndex();
      } else if (commandType === "frame") {
        const node = await figma.getNodeByIdAsync(params.id);
        if (!node || !("visible" in node)) throw new Error(`node ${params.id} not found in this file`);
        payload = await extractFramePayload(node as SceneNode);
      } else if (commandType === "selection") {
        const sel = figma.currentPage.selection;
        if (sel.length === 0) throw new Error("nothing is selected in Figma");
        payload = [];
        for (const node of sel) payload.push(await extractFramePayload(node));
      } else if (commandType === "export") {
        payload = await exportNodes(params.ids, params.format, params.scale);
      } else if (commandType === "rename") {
        // Round 11 — the first WRITE command: batch-rename nodes by id.
        // The bridge scopes renames to lazy default names (Frame 336…);
        // a whole batch executes as a single Figma undo step.
        const renames: Array<{ id: string; name: string }> = params.renames ?? [];
        if (!Array.isArray(renames) || renames.length === 0) {
          throw new Error("rename needs {renames: [{id, name}]}");
        }
        const applied: Array<{ id: string; name: string }> = [];
        const notFound: string[] = [];
        for (const r of renames) {
          const node = await figma.getNodeByIdAsync(String(r.id));
          if (!node) {
            notFound.push(String(r.id));
            continue;
          }
          node.name = String(r.name).slice(0, 100);
          applied.push({ id: String(r.id), name: node.name });
        }
        payload = { applied, notFound };
      } else if (commandType === "probe-fonts") {
        // Round 7 (C2) — runtime font-metrics probing for unseen families.
        payload = await probeFonts(params?.fonts);
      } else {
        throw new Error(`unknown command type: ${commandType}`);
      }
      postToUI({ type: "command-result", commandId, payload });
    } catch (e) {
      postToUI({ type: "command-result", commandId, error: (e as Error).message });
    }
  }
};

// ---------------------------------------------------------------------------
// Page index (all pages — used by the bridge to stitch /v1/files envelopes)
// ---------------------------------------------------------------------------

/** Mutable per-extraction state shared by serializeNode (Round 1). */
interface ExtractContext {
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  styles: Record<string, unknown>;
  /** main-component subtree indexes, keyed by main component id (shared per component). */
  mainIndexes: Map<string, Map<string, any>>;
  /** resolved main components, keyed by the owning instance's node id. */
  instanceMains: Map<string, ComponentNode>;
}

/**
 * Walk a main component's subtree and index every node by its flat
 * main-relative id (nested-instance children carry an inner `I` when walked
 * from the main — flatMainKey strips it so document-space `I<inst>;<rel>`
 * ids resolve).
 */
function buildMainIndex(main: ComponentNode): Map<string, any> {
  const index = new Map<string, any>();
  const stack: any[] = [main];
  while (stack.length) {
    const cur = stack.pop()!;
    if (typeof cur.id === "string") {
      const flat = flatMainKey(cur.id);
      if (!index.has(flat)) index.set(flat, cur);
      if (!index.has(cur.id)) index.set(cur.id, cur);
    }
    if ("children" in cur && Array.isArray((cur as any).children)) {
      const kids = (cur as any).children as readonly any[];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  return index;
}

/**
 * The main-component correspondent of an instance descendant, or null.
 * Two id regimes (probed): Figma has reported descendant document ids as
 * `I<outermostInstanceId>;<rel>` — resolved through the main index (the
 * outermost instance's main covers the whole subtree, flat keys reach
 * through nested instances). Current Figma reports plain ids — fall back
 * to STRUCTURAL correspondence: the child-index chain up to the nearest
 * INSTANCE ancestor, walked down that instance's main subtree (instance
 * children preserve the main's child order; swap-property edits never
 * reorder children).
 */
function mainCorrespondent(node: any, ctx: ExtractContext): any | null {
  if (typeof node?.id === "string") {
    const m = /^I([^;]+);(.+)$/.exec(node.id);
    if (m) {
      const main = ctx.instanceMains.get(m[1]);
      if (!main) return null;
      const index = ctx.mainIndexes.get(main.id);
      if (!index) return null;
      return index.get(flatMainKey(m[2])) ?? index.get(m[2]) ?? null;
    }
  }
  // plain-id regime: structural correspondence via the parent chain
  const chain: number[] = [];
  let cur: any = node;
  let guard = 0;
  while (cur && cur.type !== "INSTANCE" && guard++ < 64) {
    const parent = cur.parent;
    if (!parent || !Array.isArray(parent.children)) return null;
    const idx = parent.children.indexOf(cur);
    if (idx < 0) return null;
    chain.unshift(idx);
    cur = parent;
  }
  if (!cur || cur.type !== "INSTANCE") return null;
  const main = ctx.instanceMains.get(cur.id);
  if (!main) return null;
  let mc: any = main;
  for (const idx of chain) {
    const kids = mc.children;
    if (!Array.isArray(kids) || idx >= kids.length) return null;
    mc = kids[idx];
  }
  return mc ?? null;
}

/** Read a property from a main-side node, defensively (remote mains can
 * restrict reads — an inherited value must never break serialization). */
function mainProp(mc: any, key: string): unknown {
  try {
    return mc?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Round 5 (#11 residue) — the node-level style binding REST reports for
 * MIXED rich text: the LAST segment carrying that style kind. Corpus 3/3:
 * "Not a member? Register now" reports the trailing link segment's
 * fill+text (" Register now" = Highlight/Darkest + Action/Action M); the
 * checkbox label, whose last segment is the plain body style, reports
 * body+body; a node ending in unstyled characters falls back to the last
 * styled segment.
 */
function lastSegmentStyleId(node: any, key: string): string | undefined {
  try {
    const segs = node.getStyledTextSegments([key]) as any[];
    for (let i = segs.length - 1; i >= 0; i--) {
      const v = styleIdValue(segs[i]?.[key]);
      if (v) return v;
    }
  } catch {
    /* segments unavailable — leave the binding unemitted */
  }
  return undefined;
}

/**
 * Real file keys require `enablePrivatePluginApi` (private org plugins
 * only — see the typings on figma.fileKey), which we deliberately don't
 * require. Instead we derive a stable, file-unique local key from the
 * file's page ids: deterministic, survives restarts, differs across files.
 */
async function effectiveFileKey(): Promise<string> {
  if (figma.fileKey) return figma.fileKey;
  await loadAllPagesSafe(); // all page ids must be visible for a stable hash
  const ids = figma.root.children
    .map((p) => p.id)
    .sort()
    .join(",");
  // djb2 — deterministic, no dependencies
  let h = 5381;
  for (let i = 0; i < ids.length; i++) h = ((h << 5) + h + ids.charCodeAt(i)) >>> 0;
  return `local-${h.toString(36)}`;
}

async function loadAllPagesSafe(): Promise<void> {
  // manifest uses "documentAccess": "dynamic-page" — only the current page's
  // subtree is loaded by default; load the rest before walking root.children.
  try {
    await figma.loadAllPagesAsync();
  } catch {
    /* stay on the current page — page-index then covers just that page */
  }
}

async function buildPageIndex() {
  await loadAllPagesSafe();
  // Round 4 harvest: enumerate this file's local styles. Run inside a
  // library file, this is the key→nodeId join table the bridge needs to
  // resolve consumer-side remote style bindings (deviation #10).
  const styles: Record<string, unknown> = {};
  await enumerateLocalStyles(styles);
  const pages = figma.root.children.map((page) => {
    const bg = ((page as any).backgrounds ?? []).find((p: any) => p.visible !== false && p.color);
    return {
      id: page.id,
      name: page.name,
      type: "CANVAS" as const,
      backgroundColor: mapColor(bg?.color ?? { r: 1, g: 1, b: 1 }),
      children: page.children.map((c) => ({
        id: c.id,
        name: c.name,
        type: restNodeType(c.type),
        absoluteBoundingBox: absoluteBox(c),
      })),
    };
  });
  return { fileKey: await effectiveFileKey(), pages, styles };
}

// ---------------------------------------------------------------------------
// Extraction — iterative traversal (deep trees never blow the call stack)
// ---------------------------------------------------------------------------

interface ExtractionResult {
  document: Record<string, unknown>;
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  styles: Record<string, unknown>;
}

async function extractFramePayload(node: SceneNode): Promise<Record<string, unknown>> {
  const { document, components, componentSets, styles } = await extractTree(node);
  return {
    id: node.id,
    name: node.name,
    document,
    components,
    componentSets,
    styles,
    schemaVersion: 0,
    fileKey: await effectiveFileKey(),
    _figmaAgent: {
      source: "plugin",
      extractedAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
    },
  };
}

// Local styles (even unused ones) belong in the file-level `styles` map —
// REST includes them all. Ids are "S:<hash>,<nodeId>" — the suffix is the
// file-local node id REST keys the map by. Current Figma builds report
// LOCAL styles as "S:<hash>," with an EMPTY suffix (remote styles still
// carry real markers via node *StyleId properties): key those by the full
// id instead, so distinct styles never collapse onto "". The bridge's
// rest-bootstrap join (Round 4) re-keys them to REST's real node ids.
async function enumerateLocalStyles(styles: Record<string, unknown>): Promise<void> {
  try {
    const lists = await Promise.all([
      (figma as any).getLocalPaintStylesAsync?.(),
      (figma as any).getLocalTextStylesAsync?.(),
      (figma as any).getLocalEffectStylesAsync?.(),
      (figma as any).getLocalGridStylesAsync?.(),
    ]);
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const st of list as any[]) {
        if (typeof st.id !== "string" || !st.id) continue;
        const suffix = st.id.includes(",") ? st.id.slice(st.id.indexOf(",") + 1) : st.id;
        const nodeId = suffix || st.id; // empty suffix → full id (no collapse)
        if (styles[nodeId]) continue;
        styles[nodeId] = {
          key: st.key,
          name: st.name,
          description: st.description ?? "",
          remote: st.remote === true,
          styleType: restStyleType(st.type),
        };
      }
    }
  } catch {
    /* local style enumeration unavailable — referenced styles still resolve */
  }
}

async function extractTree(root: SceneNode): Promise<ExtractionResult> {
  const ctx: ExtractContext = {
    components: {},
    componentSets: {},
    styles: {},
    mainIndexes: new Map(),
    instanceMains: new Map(),
  };
  const { components, componentSets, styles } = ctx;

  // REST's file-level `styles` map lists every local style (even unused
  // ones) plus the remote styles referenced in the file — enumerate local
  // styles up front so unused local styles appear too.
  await enumerateLocalStyles(styles);

  const objByNode = new Map<BaseNode, Record<string, unknown>>();
  const stack: SceneNode[] = [root];
  let count = 0;

  while (stack.length) {
    const node = stack.pop()!;
    if (++count > MAX_NODES_PER_EXTRACTION) {
      throw new Error(`frame too large: more than ${MAX_NODES_PER_EXTRACTION} nodes — split the extraction`);
    }
    let obj: Record<string, unknown>;
    try {
      obj = await serializeNode(node, ctx);
    } catch (e) {
      // Resilience: one bad node must never kill the whole frame. Emit the
      // invariant core plus a visible marker under _figmaAgent (Rule B5).
      obj = omitEmpty({
        id: node.id,
        name: node.name,
        type: restNodeType(node.type),
        ...(node.visible === false ? { visible: false } : {}),
        absoluteBoundingBox: absoluteBox(node),
      });
      figmaAgentExt(obj).error = `serialization failed: ${(e as Error).message}`;
    }
    objByNode.set(node, obj);

    if ("children" in node) {
      const kids = (node as BaseNode & { children: readonly SceneNode[] }).children;
      // push in reverse so children serialize in document order
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  // Attach children arrays in document order (iteratively — no recursion).
  for (const [node, obj] of objByNode) {
    if ("children" in node) {
      const kids = (node as BaseNode & { children: readonly SceneNode[] }).children;
      obj.children = kids.map((c) => objByNode.get(c)).filter(Boolean);
    }
  }

  const document = objByNode.get(root);
  if (!document) throw new Error("extraction failed: root node missing");
  return { document, components, componentSets, styles };
}

// ---------------------------------------------------------------------------
// Node serialization (REST conventions, agent.md §7.3)
// ---------------------------------------------------------------------------

/** Plugin node type → REST node type. Only real divergences listed. */
const TYPE_MAP: Record<string, string> = {
  POLYGON: "REGULAR_POLYGON",
};

function restNodeType(pluginType: string): string {
  return TYPE_MAP[pluginType] ?? pluginType; // B4: unknown types pass through
}

/**
 * REST StyleType vocabulary: the plugin's BaseStyle.type says "PAINT" where
 * REST's style metadata says "FILL" (others — TEXT, EFFECT, GRID — agree).
 */
function restStyleType(pluginType: string): string {
  return pluginType === "PAINT" ? "FILL" : pluginType;
}

function absoluteBox(node: SceneNode): Record<string, number> | undefined {
  const bb = (node as any).absoluteBoundingBox;
  if (!bb) return undefined;
  return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
}

/** REST emits layoutAlign/layoutGrow/layoutSizing only inside auto-layout trees. */
function parentHasAutoLayout(node: BaseNode): boolean {
  const parent = node.parent;
  if (!parent || !("layoutMode" in parent)) return false;
  const mode = (parent as any).layoutMode;
  return mode && mode !== "NONE";
}

/** Paints for the always-present fills/strokes arrays. */
function paintArray(paints: unknown): Record<string, unknown>[] | string {
  if (typeof paints === "symbol") return MIXED;
  if (Array.isArray(paints)) return mapPaints(paints as Paint[]);
  return [];
}

async function serializeNode(node: SceneNode, ctx: ExtractContext): Promise<Record<string, unknown>> {
  const { components, componentSets, styles } = ctx;
  const n = node as any;

  // B1 — invariant core. `visible` is emitted only when false and the
  // always-on REST fields (fills/strokes/effects/…) follow the emission
  // rules measured against real GET /v1/files payloads.
  const out: Record<string, unknown> = omitEmpty({
    id: node.id,
    name: node.name,
    type: restNodeType(node.type),
    ...(node.visible === false ? { visible: false } : {}),
    absoluteBoundingBox: absoluteBox(node),
  });
  // Round 16 — contract-only extraction (option A): structure, layout
  // intent, text, styling, components. The parity-grade extras
  // (renderBounds, blend modes, interactions, prototyping, vector
  // geometry, export settings, …) are gone — see docs/mined-data.md.
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = n.opacity;
  // Round 16.2 — rotation restored: REST files never emit it, but rotated
  // tiles/labels are real design data the agent cannot infer from
  // bounding boxes. Degrees, non-zero only. Figma's sign is positive
  // COUNTER-clockwise (rotation = atan2(-m10, m00)) — the opposite of
  // CSS rotate(); the bridge's flex digest applies the sign flip.
  if (typeof n.rotation === "number" && n.rotation !== 0) out.rotation = n.rotation;
  // constraints — REST emits them on every scene node; the plugin omits
  // the property on GROUPs and auto-layout children. Defaults measured:
  // GROUP/regular → LEFT/TOP, auto-layout child → SCALE/SCALE.
  // Round 1 (B3): instance children report no constraints when unoverridden
  // — inherit the main child's value (measured: 13 such nodes in the corpus).
  let constraints: unknown = n.constraints;
  if (!constraints || typeof constraints === "symbol") {
    const mc = mainCorrespondent(node, ctx);
    const inherited = mainProp(mc, "constraints");
    if (inherited && typeof inherited !== "symbol") constraints = inherited;
  }
  if (constraints && typeof constraints !== "symbol") out.constraints = mapConstraints(constraints);
  else
    out.constraints = parentHasAutoLayout(node)
      ? { horizontal: "SCALE", vertical: "SCALE" }
      : { horizontal: "LEFT", vertical: "TOP" };

  // fills / strokes / effects — the styling contract.
  out.fills = paintArray(n.fills);
  out.strokes = paintArray(n.strokes);
  out.effects = Array.isArray(n.effects) && n.effects.length ? mapEffects(n.effects) : [];

  // stroke — scalar weight + alignment only.
  out.strokeWeight = typeof n.strokeWeight === "number" ? n.strokeWeight : 1;
  out.strokeAlign = n.strokeAlign ?? "INSIDE";

  // corner radii — uniform cornerRadius OR rectangleCornerRadii [TL,TR,BR,BL]
  if (typeof n.topLeftRadius === "number") {
    const radii = [n.topLeftRadius, n.topRightRadius, n.bottomLeftRadius, n.bottomRightRadius];
    const uniform = radii.every((r) => r === radii[0]);
    if (uniform) {
      if (radii[0] !== 0) out.cornerRadius = radii[0];
    } else {
      out.rectangleCornerRadii = radii;
    }
  } else if (typeof n.cornerRadius === "number" && n.cornerRadius !== 0) {
    out.cornerRadius = n.cornerRadius;
  }

  // auto-layout container properties — only when layoutMode is active.
  // Emission rules measured from REST: zero paddings and MIN axis
  // alignments are omitted, sizing modes only surface FIXED (HUG/FILL
  // moved into layoutSizing*), counterAxisSpacing only for WRAP.
  if (n.layoutMode && n.layoutMode !== "NONE") {
    Object.assign(
      out,
      omitEmpty({
        layoutMode: n.layoutMode,
        layoutWrap: n.layoutWrap ?? "NO_WRAP",
        itemSpacing: typeof n.itemSpacing === "symbol" ? MIXED : n.itemSpacing || undefined,
        ...(n.paddingTop ? { paddingTop: n.paddingTop } : {}),
        ...(n.paddingRight ? { paddingRight: n.paddingRight } : {}),
        ...(n.paddingBottom ? { paddingBottom: n.paddingBottom } : {}),
        ...(n.paddingLeft ? { paddingLeft: n.paddingLeft } : {}),
        ...(n.primaryAxisAlignItems && n.primaryAxisAlignItems !== "MIN"
          ? { primaryAxisAlignItems: n.primaryAxisAlignItems } : {}),
        ...(n.counterAxisAlignItems && n.counterAxisAlignItems !== "MIN"
          ? { counterAxisAlignItems: n.counterAxisAlignItems } : {}),
        ...(n.primaryAxisSizingMode === "FIXED" ? { primaryAxisSizingMode: "FIXED" } : {}),
        ...(n.counterAxisSizingMode === "FIXED" ? { counterAxisSizingMode: "FIXED" } : {}),
        ...(n.strokesIncludedInLayout === true ? { strokesIncludedInLayout: true } : {}),
        ...(n.layoutWrap === "WRAP" && typeof n.counterAxisSpacing === "number"
          ? { counterAxisSpacing: n.counterAxisSpacing } : {}),
      }),
    );
  }

  // frame-like nodes: clipsContent (overflow: hidden is styling)
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT_SET"
  ) {
    out.clipsContent = n.clipsContent === true;
  }

  // how this node sits inside layouts — REST only emits these on children
  // of auto-layout containers (layoutSizing also on auto-layout frames
  // with non-auto-layout parents). BOOLEAN_OPERATION never carries them.
  const layoutSizingApplies = parentHasAutoLayout(node) || (n.layoutMode && n.layoutMode !== "NONE");
  if (parentHasAutoLayout(node)) {
    out.layoutAlign = n.layoutAlign ?? "INHERIT";
    out.layoutGrow = typeof n.layoutGrow === "number" ? n.layoutGrow : 0;
  }
  if (layoutSizingApplies && node.type !== "BOOLEAN_OPERATION") {
    out.layoutSizingHorizontal = n.layoutSizingHorizontal;
    out.layoutSizingVertical = n.layoutSizingVertical;
    if (out.layoutSizingHorizontal === undefined) delete out.layoutSizingHorizontal;
    if (out.layoutSizingVertical === undefined) delete out.layoutSizingVertical;
  }

  // text nodes — characters + style + per-character overrides (agent.md §7.3.8)
  if (node.type === "TEXT") {
    Object.assign(out, serializeText(node as TextNode));
  }

  // components / instances
  if (node.type === "INSTANCE") {
    // mainComponent THROWS (rather than returning null) for components on
    // other pages under dynamic-page access — read it in its own try so the
    // async fallback still runs.
    let main: ComponentNode | null = null;
    try {
      main = (node as InstanceNode).mainComponent;
    } catch {
      /* cross-page component under dynamic-page */
    }
    if (!main) {
      try {
        main = await (node as InstanceNode).getMainComponentAsync();
      } catch {
        /* main component unavailable */
      }
    }
    if (main) {
      out.componentId = main.id;
      registerComponent(main, components, componentSets);
      // Round 1 — remember the correspondence for overrides + inheritance
      ctx.instanceMains.set(node.id, main);
      if (!ctx.mainIndexes.has(main.id)) ctx.mainIndexes.set(main.id, buildMainIndex(main));
    }
    if (n.componentProperties && Object.keys(n.componentProperties as object).length) {
      out.componentProperties = n.componentProperties;
    }
  }
  if ((node.type === "COMPONENT" || node.type === "COMPONENT_SET")) {
    // Variant components throw on this property (only non-variant components
    // and component sets expose definitions) — read defensively.
    try {
      if (n.componentPropertyDefinitions) out.componentPropertyDefinitions = n.componentPropertyDefinitions;
    } catch {
      /* variant component — no property definitions exposed */
    }
  }
  if (node.type === "COMPONENT") {
    registerComponent(node as ComponentNode, components, componentSets);
  }
  if (node.type === "COMPONENT_SET") {
    registerComponentSet(node as ComponentSetNode, componentSets);
  }

  // Bound styles — the plugin's *StyleId properties return "" when unbound
  // and a style KEY ("S:<hash>,<id>") when bound; REST node.styles carries
  // the style's node id and the file-level map is keyed by it.
  // Round 5 correction: REST reports ONLY stored per-node bindings — no
  // inheritance from the main (measured: instance selves and children with
  // main-side bindings emit nothing in REST). The one plugin gap is MIXED
  // rich text, where REST reports the LAST styled segment's binding.
  const binding = (key: string): string | undefined => {
    const raw = n[key];
    const own = styleIdValue(raw);
    if (own) return own;
    // MIXED rich text: REST reports the last styled segment's binding
    if (typeof raw === "symbol" && node.type === "TEXT") {
      const seg = lastSegmentStyleId(node, key);
      if (seg) return seg;
    }
    return undefined;
  };
  const styleBindings = omitEmpty({
    fill: binding("fillStyleId"),
    stroke: binding("strokeStyleId"),
    effect: binding("effectStyleId"),
    text: binding("textStyleId"),
    grid: binding("gridStyleId"),
  });
  if (Object.keys(styleBindings).length) {
    out.styles = styleBindings;
    for (const [field, id] of Object.entries(styleBindings as Record<string, string>)) {
      if (styles[id]) continue;
      try {
        const st = await figma.getStyleByIdAsync(id);
        if (st) {
          // plugin style ids look like "S:<hash>,<nodeId>" — for local
          // styles the suffix is the file-local node id REST emits. Remote
          // (library) styles keep their local marker id (deviation: REST
          // uses the library file's id, which the plugin cannot see).
          const nodeId = st.id.includes(",") ? st.id.slice(st.id.indexOf(",") + 1) : st.id;
          styles[nodeId] = {
            key: st.key,
            name: st.name,
            description: st.description ?? "",
            remote: (st as any).remote === true,
            styleType: restStyleType((st as any).type), // BaseStyle.type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID' | …
          };
          (styleBindings as Record<string, string>)[field] = nodeId;
        }
      } catch {
        /* style unresolvable — referenced id still emitted on the node */
      }
    }
    // REST emits plural aliases alongside the singular binding keys on
    // frame-like nodes (measured: every styled FRAME/INSTANCE has both).
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
      const sb = styleBindings as Record<string, string>;
      if (sb.fill) sb.fills = sb.fill;
      if (sb.stroke) sb.strokes = sb.stroke;
    }
  }

  return out;
}

/** The per-node `_figmaAgent` extension object (Rule B5). */
function figmaAgentExt(out: Record<string, unknown>): Record<string, unknown> {
  if (!out._figmaAgent) out._figmaAgent = {};
  return out._figmaAgent as Record<string, unknown>;
}

function registerComponent(
  comp: ComponentNode,
  components: Record<string, unknown>,
  componentSets: Record<string, unknown>,
) {
  if (components[comp.id]) return;
  const parent = comp.parent;
  const setId = parent && parent.type === "COMPONENT_SET" ? parent.id : undefined;
  const links = (comp.documentationLinks ?? []) as { uri: string }[];
  components[comp.id] = omitEmpty({
    // PublishableMixin.key — the real publish key, present on local AND
    // published components (measured: REST emits 40-hex keys for local
    // components too, e.g. 238:75 → 5be0efce…).
    key: comp.key,
    name: comp.name,
    description: comp.description ?? "",
    ...(setId ? { componentSetId: setId } : {}),
    // REST emits documentationLinks on EVERY file-level component (remote
    // included, `[]` when none — measured on the file envelope; remote
    // componentSets omit it instead).
    documentationLinks: links,
    // REST always emits `remote` on components (false for local — measured).
    remote: !!comp.remote,
  });
  if (setId && parent) registerComponentSet(parent as ComponentSetNode, componentSets);
}

function registerComponentSet(set: ComponentSetNode, componentSets: Record<string, unknown>) {
  if (componentSets[set.id]) return;
  const links = (set.documentationLinks ?? []) as { uri: string }[];
  componentSets[set.id] = omitEmpty({
    key: set.key,
    name: set.name,
    description: set.description ?? "",
    ...(set.remote ? (links.length ? { documentationLinks: links } : {}) : { documentationLinks: links }),
    // REST emits `remote` on component sets only when true — the one local
    // set in the corpus (238:75) carries no `remote` key (measured).
    ...(set.remote ? { remote: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// TEXT — characters · style · characterStyleOverrides · styleOverrideTable
// ---------------------------------------------------------------------------

function serializeText(t: TextNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.characters = t.characters;

  // REST emits lineHeightPx even for intrinsic (AUTO) line heights — it
  // computes real font metrics server-side. The plugin cannot read font
  // metrics; for texts whose height is driven by their lines (auto-height),
  // rendered height ÷ line count IS the line height. Best-effort estimate,
  // see docs/rest-parity-deviations.md.
  const lineTypes = (t as any).lineTypes as string[] | undefined;
  const lineCount = lineTypes?.length ?? t.characters.split(/\r\n|\r|\n/).length;
  let intrinsicLineHeightPx: number | undefined;
  if (lineCount > 0 && (t.textAutoResize === "HEIGHT" || t.textAutoResize === "WIDTH_AND_HEIGHT")) {
    intrinsicLineHeightPx = t.height / lineCount;
  }

  let segments: SegmentInput[] = [];
  try {
    const raw = t.getStyledTextSegments([
      "fontName",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "fills",
      "textDecoration",
      "textCase",
      "paragraphSpacing",
      "paragraphIndent",
    ]);
    segments = raw.map((s) => {
      const source: StyleSource = {
        fontFamily: s.fontName?.family,
        fontStyle: s.fontName?.style,
        fontWeight: s.fontWeight,
        fontSize: s.fontSize,
        letterSpacing: s.letterSpacing,
        lineHeight: s.lineHeight,
        intrinsicLineHeightPx,
        textDecoration: s.textDecoration,
        textCase: s.textCase,
        paragraphSpacing: s.paragraphSpacing,
        paragraphIndent: s.paragraphIndent,
        textAlignHorizontal: t.textAlignHorizontal,
        textAlignVertical: t.textAlignVertical,
        fills: s.fills,
        // segment styles carry fills — the override-table deltas keep them
        includeFills: true,
      };
      return {
        start: s.start,
        end: s.end,
        style: buildTypeStyle(source),
      };
    });
  } catch {
    /* fonts unavailable — fall back to node-level aggregate below */
  }

  // Mixed-fill texts: the plugin only exposes the MIXED sentinel on the
  // node, but REST emits the default segment's paint as the node-level
  // fills (measured) — reuse the first segment's mapped fills.
  if (typeof (t as any).fills === "symbol" && segments.length) {
    const segFills = segments[0].style.fills;
    if (Array.isArray(segFills)) out.fills = segFills;
  }

  let style: Record<string, unknown>;
  let characterStyleOverrides: number[];
  let styleOverrideTable: Record<string, Record<string, unknown>>;

  if (segments.length) {
    const built = buildTextOverrides(t.characters, segments);
    style = built.style;
    characterStyleOverrides = built.characterStyleOverrides;
    styleOverrideTable = built.styleOverrideTable;
  } else {
    const deMixed = <T,>(v: unknown): T | undefined => (typeof v === "symbol" ? undefined : (v as T));
    const fn = deMixed<FontName>(t.fontName);
    const source: StyleSource = {
      fontFamily: fn?.family,
      fontStyle: fn?.style,
      fontSize: deMixed<number>(t.fontSize),
      fontWeight: typeof fn?.style === "string" ? fontWeightFromStyle(fn.style) : undefined,
      letterSpacing: deMixed<LetterSpacing>(t.letterSpacing),
      lineHeight: deMixed<LineHeight>(t.lineHeight),
      intrinsicLineHeightPx,
      textDecoration: deMixed<"NONE" | "STRIKETHROUGH" | "UNDERLINE">(t.textDecoration),
      textCase: deMixed<TextCase>(t.textCase),
      paragraphSpacing: deMixed<number>(t.paragraphSpacing),
      paragraphIndent: deMixed<number>(t.paragraphIndent),
      textAlignHorizontal: t.textAlignHorizontal,
      textAlignVertical: t.textAlignVertical,
      fills: Array.isArray(t.fills) ? t.fills : undefined,
    };
    style = buildTypeStyle(source);
    characterStyleOverrides = [];
    styleOverrideTable = {};
  }

  // node-level text properties REST puts inside `style` (omits NONE)
  if (t.textAutoResize && t.textAutoResize !== "NONE") style.textAutoResize = t.textAutoResize;

  out.style = style;
  out.characterStyleOverrides = characterStyleOverrides;
  out.styleOverrideTable = styleOverrideTable;
  // lineTypes/lineIndentations are newer plugin APIs — read defensively and
  // default to one "NONE" line per paragraph like REST does for plain text.
  const fallbackLineCount = t.characters.split(/\r\n|\r|\n/).length;
  out.lineTypes = lineTypes ?? new Array(fallbackLineCount).fill("NONE");
  out.lineIndentations =
    ((t as any).lineIndentations as number[] | undefined) ?? new Array(fallbackLineCount).fill(0);
  return out;
}

// ---------------------------------------------------------------------------
/** "Semi Bold" → 600, "Bold" → 700, "Regular" → 400 … */
function fontWeightFromStyle(style: string): number | undefined {
  const named: Record<string, number> = {
    thin: 100, extralight: 200, ultralight: 200, light: 300,
    regular: 400, normal: 400, book: 400,
    medium: 500, demibold: 600, semibold: 600,
    bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
  };
  const key = style.toLowerCase().replace(/\s+/g, "");
  if (named[key] !== undefined) return named[key];
  return undefined;
}

// ---------------------------------------------------------------------------
// Export command (backs /v1/images/:key)
// ---------------------------------------------------------------------------

async function exportNodes(ids: string[], format = "PNG", scale = 2): Promise<Record<string, unknown>> {
  const images: Record<string, unknown> = {};
  for (const id of ids ?? []) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || !("exportAsync" in node)) {
        images[id] = null;
        continue;
      }
      const settings: ExportSettings =
        format === "SVG"
          ? { format: "SVG" }
          : { format: (format as "JPG" | "PNG" | "PDF") ?? "PNG", constraint: { type: "SCALE", value: scale } };
      images[id] = figma.base64Encode(await node.exportAsync(settings));
    } catch {
      images[id] = null;
    }
  }
  return { images, fileKey: await effectiveFileKey() };
}
