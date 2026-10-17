/**
 * Figma Agent plugin v3 — REST-parity design-tree extractor.
 *
 * Output mirrors GET https://api.figma.com/v1/files/:file_key per
 * figma/rest-api-spec (see agent.md §7). Our extensions (SVG markup,
 * render bounds, rotation) live under `_figmaAgent` — a strict
 * superset of the REST API, never a subset.
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
  detectOverrideFields,
  flatMainKey,
  mainRelativeId,
  mapColor,
  mapConstraints,
  mapEffects,
  mapPaints,
  omitEmpty,
  styleIdValue,
  type SegmentInput,
  type StyleSource,
} from "./lib/rest-mapping";

const PLUGIN_VERSION = "3.0.0";
const MAX_NODES_PER_EXTRACTION = 20000;
const SVG_EXPORT_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE"]);

figma.showUI(__html__, { width: 340, height: 300 });

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
      } else if (commandType === "probe") {
        // Round 1 dev tool — raw node facts for corpus-rule fitting
        // (vectorNetwork regions, constraints, style ids, dimensions), or a
        // full instance-vs-main subtree dump for override-correspondence
        // analysis when `instanceId` is given.
        if (params.instanceId) {
          const inst: any = await figma.getNodeByIdAsync(params.instanceId);
          if (!inst || inst.type !== "INSTANCE") {
            throw new Error(`not an instance: ${params.instanceId}`);
          }
          const main: any = await inst.getMainComponentAsync();
          const dump = (root: any): any[] => {
            const out: any[] = [];
            const stack: any[] = [root];
            while (stack.length) {
              const cur = stack.pop()!;
              out.push({
                id: cur.id,
                type: cur.type,
                name: cur.name,
                width: cur.width,
                height: cur.height,
                fillStyleId: cur.fillStyleId ?? null,
                strokeStyleId: cur.strokeStyleId ?? null,
                textStyleId: cur.textStyleId ?? null,
                visible: cur.visible,
                characters: cur.characters ?? undefined,
              });
              const kc = cur.children ?? [];
              for (let i = kc.length - 1; i >= 0; i--) stack.push(kc[i]);
            }
            return out;
          };
          payload = {
            instance: {
              id: inst.id,
              subtree: dump(inst),
            },
            main: main
              ? { id: main.id, name: main.name, remote: !!main.remote, subtree: dump(main) }
              : null,
          };
        } else {
          const probes: any[] = [];
          for (const id of (params.ids ?? []) as string[]) {
            try {
              const node: any = await figma.getNodeByIdAsync(id);
              if (!node) {
                probes.push({ id, error: "not found" });
                continue;
              }
              const rec: any = {
                id,
                type: node.type,
                name: node.name,
                width: node.width,
                height: node.height,
                constraints: typeof node.constraints === "symbol" ? "MIXED" : node.constraints ?? null,
                fillStyleId: node.fillStyleId ?? null,
                textStyleId: node.textStyleId ?? null,
                characters: node.characters ?? null,
                // raw export settings — Round 3 E-exportSettings: two nodes
                // (175:1274, 180:1137) report [{PNG}] to the plugin while
                // REST serializes none; capture raw shape + counterpart controls
                rawExportSettings: Array.isArray(node.exportSettings)
                  ? (node.exportSettings as any[]).map((es) => ({
                      format: es.format,
                      constraint: es.constraint ?? null,
                      suffix: es.suffix ?? null,
                    }))
                  : null,
              };
              if (node.type === "VECTOR") {
                try {
                  const vn = node.vectorNetwork;
                  rec.vectorRegions = vn?.regions?.length ?? 0;
                  rec.vectorRegionFillCounts = (vn?.regions ?? []).map(
                    (r: any) => r?.fills?.length ?? 0,
                  );
                  rec.vectorSegments = vn?.segments?.length ?? 0;
                  rec.vectorVertices = vn?.vertices?.length ?? 0;
                } catch {
                  rec.vectorRegions = "unavailable";
                }
              }
              probes.push(rec);
            } catch (e) {
              probes.push({ id, error: (e as Error).message });
            }
          }
          payload = { probes };
        }
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
 * Document ids of descendants start with `I<outermostInstanceId>;` — the
 * outermost instance's main index covers the whole subtree (flat keys reach
 * through nested instances).
 */
function mainCorrespondent(nodeId: string, ctx: ExtractContext): any | null {
  const m = /^I([^;]+);(.+)$/.exec(nodeId);
  if (!m) return null;
  const main = ctx.instanceMains.get(m[1]);
  if (!main) return null;
  const index = ctx.mainIndexes.get(main.id);
  if (!index) return null;
  return index.get(flatMainKey(m[2])) ?? index.get(m[2]) ?? null;
}

/**
 * The resize ratio of a node's NEAREST instance ancestor (doc dims ÷ that
 * instance's main dims). This single ratio already composes every outer
 * scale — a nested instance's doc/main ratio includes its parent's resize
 * — so descendant size diffs explained by it are inherited scaling, not
 * stored overrides (Round 1, measured).
 */
function inheritedScale(node: any, ctx: ExtractContext): { x: number; y: number } | undefined {
  let p = node.parent;
  while (p) {
    if (p.type === "INSTANCE") {
      const main = ctx.instanceMains.get(p.id);
      if (main && main.width > 0 && main.height > 0) {
        return { x: p.width / main.width, y: p.height / main.height };
      }
      return undefined;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * Emit every INSTANCE's `overrides` array (Round 1 — B1). REST emits
 * `overrides` on every instance (`[]` when nothing differs); entries are
 * `{id, overriddenFields}`, self first, then descendants in document order
 * (measured). Inherited overrides (a nested instance's own array) are NOT
 * included — each instance reports only its direct edits.
 */
function attachInstanceOverrides(
  objByNode: Map<BaseNode, Record<string, unknown>>,
  ctx: ExtractContext,
): void {
  for (const [node, obj] of objByNode) {
    if (node.type !== "INSTANCE") continue;
    const overrides: { id: string; overriddenFields: string[] }[] = [];
    const main = ctx.instanceMains.get(node.id);
    if (main) {
      const index = ctx.mainIndexes.get(main.id)!;
      const selfFields = detectOverrideFields(node as any, main as any, inheritedScale(node, ctx));
      if (selfFields.length) overrides.push({ id: node.id, overriddenFields: selfFields });

      // descendants in document (pre-)order — iterative, depth-safe
      const stack: any[] = [...((node as any).children ?? [])].reverse();
      while (stack.length) {
        const kid = stack.pop()!;
        const rel = mainRelativeId(node.id, kid.id);
        if (rel !== null) {
          const mc = index.get(flatMainKey(rel)) ?? index.get(rel);
          if (mc) {
            const fields = detectOverrideFields(kid, mc, inheritedScale(kid, ctx));
            if (fields.length) overrides.push({ id: kid.id, overriddenFields: fields });
          }
        }
        const kc = kid.children ?? [];
        for (let i = kc.length - 1; i >= 0; i--) stack.push(kc[i]);
      }
    }
    obj.overrides = overrides;
  }
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
  return { fileKey: await effectiveFileKey(), pages };
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
// file-local node id REST keys the map by.
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
        const nodeId =
          typeof st.id === "string" && st.id.includes(",") ? st.id.slice(st.id.indexOf(",") + 1) : st.id;
        if (styles[nodeId]) continue;
        styles[nodeId] = {
          key: st.key,
          name: st.name,
          description: st.description ?? "",
          remote: st.remote === true,
          styleType: st.type,
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

  // Round 1 — instance override tables (needs every instance's main resolved
  // first, so it runs after the whole tree is serialized).
  attachInstanceOverrides(objByNode, ctx);

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

/** node.absoluteRenderBounds — REST emits this at the top level of every node. */
function absoluteRenderBox(node: SceneNode): Record<string, number> | null {
  const rb = (node as any).absoluteRenderBounds;
  if (!rb) return null;
  return { x: rb.x, y: rb.y, width: rb.width, height: rb.height };
}

/** Paints for REST's always-present fills/strokes/background arrays. */
function paintArray(paints: unknown): Record<string, unknown>[] | string {
  if (typeof paints === "symbol") return MIXED;
  if (Array.isArray(paints)) return mapPaints(paints as Paint[]);
  return [];
}

/** Frame backgroundColor — first VISIBLE solid fill's color, transparent otherwise. */
function frameBackgroundColor(fills: unknown): { r: number; g: number; b: number; a: number } {
  if (Array.isArray(fills)) {
    for (const p of fills as {
      type?: string;
      visible?: boolean;
      opacity?: number;
      color?: { r: number; g: number; b: number; a?: number };
    }[]) {
      if (p && p.type === "SOLID" && p.visible !== false && p.color) {
        // REST folds the paint's opacity into backgroundColor.a (while
        // keeping it separate on fills); plugin solid colors carry no
        // alpha of their own — measured.
        const a = typeof p.opacity === "number" ? p.opacity : 1;
        return { r: p.color.r, g: p.color.g, b: p.color.b, a };
      }
    }
  }
  return { r: 0, g: 0, b: 0, a: 0 };
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
  // REST emits absoluteRenderBounds on every node — null when not rendered
  out.absoluteRenderBounds = absoluteRenderBox(node);

  // B3 — mixed sentinels; B2 — omit absent like REST
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = n.opacity;
  if (n.blendMode && n.blendMode !== "NORMAL") out.blendMode = n.blendMode;
  // constraints — REST emits them on every scene node; the plugin omits
  // the property on GROUPs and auto-layout children. Defaults measured:
  // GROUP/regular → LEFT/TOP, auto-layout child → SCALE/SCALE.
  // Round 1 (B3): instance children report no constraints when unoverridden
  // — inherit the main child's value (measured: 13 such nodes in the corpus).
  let constraints: unknown = n.constraints;
  if (!constraints || typeof constraints === "symbol") {
    const mc = mainCorrespondent(node.id, ctx);
    if (mc && mc.constraints && typeof mc.constraints !== "symbol") constraints = mc.constraints;
  }
  if (constraints && typeof constraints !== "symbol") out.constraints = mapConstraints(constraints);
  else
    out.constraints = parentHasAutoLayout(node)
      ? { horizontal: "SCALE", vertical: "SCALE" }
      : { horizontal: "LEFT", vertical: "TOP" };
  if (node.locked === true) out.locked = true;

  // fills / strokes / effects / interactions / scrollBehavior — REST
  // emits these on EVERY node (empty array / "SCROLLS" when unset).
  out.fills = paintArray(n.fills);
  out.strokes = paintArray(n.strokes);
  out.effects = Array.isArray(n.effects) && n.effects.length ? mapEffects(n.effects) : [];
  out.interactions = (Array.isArray(n.reactions) ? n.reactions : []).map((r: any) => ({
    trigger: r?.trigger ?? null,
    actions: (Array.isArray(r?.actions) ? r.actions : r?.action ? [r.action] : []).map((a: any) =>
      a?.resetVideoPosition === false ? { ...a, resetVideoPosition: undefined } : a,
    ),
  }));
  // The plugin has no API to read scrollBehavior — REST's default is
  // SCROLLS; pinned (FIXED) frames are a documented deviation.
  out.scrollBehavior = "SCROLLS";

  // stroke geometry — also on every node. Per-side weights surface as
  // individualStrokeWeights when the sides are non-uniform; REST then
  // reports the constant 1 as the scalar strokeWeight (measured: 41/41
  // non-uniform nodes carry strokeWeight 1 — a placeholder, not the max).
  const sides = [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight];
  if (new Set(sides).size > 1) {
    out.individualStrokeWeights = {
      top: n.strokeTopWeight,
      right: n.strokeRightWeight,
      bottom: n.strokeBottomWeight,
      left: n.strokeLeftWeight,
    };
    out.strokeWeight = 1;
  } else {
    out.strokeWeight = typeof n.strokeWeight === "number" ? n.strokeWeight : 1;
  }
  out.strokeAlign = n.strokeAlign ?? "INSIDE";
  if (typeof n.strokeCap === "string" && n.strokeCap !== "NONE") out.strokeCap = n.strokeCap;
  if (typeof n.strokeJoin === "string" && n.strokeJoin !== "MITER") out.strokeJoin = n.strokeJoin;
  if (Array.isArray(n.strokeDashes) && n.strokeDashes.length) out.strokeDashes = n.strokeDashes;
  else if (Array.isArray(n.dashPattern) && n.dashPattern.length) out.strokeDashes = n.dashPattern;
  // BOOLEAN_OPERATION is the one type REST leaves this off (measured).
  if (node.type !== "BOOLEAN_OPERATION") out.complexStrokeProperties = { strokeType: "BASIC" };

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
  // cornerSmoothing rides along whenever radii are emitted (measured: REST
  // never emits smoothing without a radius, even when smoothing is set).
  // Vectors with smoothing but no radius get zeroed radii + smoothing 0.
  const hasRadii = out.cornerRadius !== undefined || out.rectangleCornerRadii !== undefined;
  if (hasRadii) {
    out.cornerSmoothing = n.cornerSmoothing ?? 0;
  } else if (
    node.type === "VECTOR" &&
    n.isMask === true &&
    typeof n.cornerSmoothing === "number" &&
    n.cornerSmoothing > 0 &&
    !(typeof n.cornerRadius === "number" && n.cornerRadius !== 0)
  ) {
    out.rectangleCornerRadii = [0, 0, 0, 0];
    out.cornerSmoothing = 0;
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

  // frame-like nodes: background paints, derived backgroundColor, real
  // clipsContent — GROUPs and COMPONENT_SETs carry these too (measured)
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT_SET"
  ) {
    out.background = paintArray(n.backgrounds);
    out.backgroundColor = frameBackgroundColor(n.fills);
    out.clipsContent = n.clipsContent === true;
  }

  // masks + boolean operation type + arc data
  if (n.isMask === true) {
    out.isMask = true;
    out.maskType = n.maskType ?? "ALPHA";
  }
  if (typeof n.booleanOperation === "string") out.booleanOperation = n.booleanOperation;
  if (n.arcData && typeof n.arcData.startingAngle === "number") {
    out.arcData = {
      startingAngle: n.arcData.startingAngle,
      endingAngle: n.arcData.endingAngle,
      innerRadius: n.arcData.innerRadius,
    };
  }
  // exposed component properties bound to this node (mostly TEXT in components)
  if (n.componentPropertyReferences && Object.keys(n.componentPropertyReferences as object).length) {
    out.componentPropertyReferences = n.componentPropertyReferences;
  }
  // frame prototype transitions (older API surface, read defensively)
  if (typeof n.transitionDuration === "number") out.transitionDuration = n.transitionDuration;
  if (typeof n.transitionEasing === "string") out.transitionEasing = n.transitionEasing;
  if (typeof n.transitionNodeID === "string") out.transitionNodeID = n.transitionNodeID;

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

  // assorted REST node fields the plugin exposes directly
  if (Array.isArray(n.layoutGrids) && n.layoutGrids.length) {
    // REST grid objects carry no boundVariables — strip the plugin extra
    out.layoutGrids = (n.layoutGrids as Record<string, unknown>[]).map((g) => {
      const { boundVariables: _bv, ...grid } = g;
      return grid;
    });
  }
  if (Array.isArray(n.exportSettings) && n.exportSettings.length) {
    // REST shape: {format, constraint (default SCALE 1 — even for SVG), suffix}
    out.exportSettings = (n.exportSettings as any[]).map((es) => ({
      format: es.format,
      constraint: es.constraint ?? { type: "SCALE", value: 1 },
      suffix: es.suffix ?? "",
    }));
  }
  // aspect lock surfaces as preserveRatio + targetAspectRatio in REST, but
  // only OUTSIDE auto-layout trees (inside them the layout drives sizing)
  if (n.preserveRatio === true || (n.targetAspectRatio && typeof n.targetAspectRatio.x === "number")) {
    if (!parentHasAutoLayout(node)) out.preserveRatio = true;
  }
  if (n.targetAspectRatio && typeof n.targetAspectRatio.x === "number") {
    out.targetAspectRatio = { x: n.targetAspectRatio.x, y: n.targetAspectRatio.y };
  }
  if (n.boundVariables && Object.keys(n.boundVariables as object).length) {
    out.boundVariables = n.boundVariables;
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

  // bound styles — the plugin's *StyleId properties return "" when unbound
  // and a style KEY ("S:<hash>,<id>") when bound; REST node.styles carries
  // the style's node id and the file-level map is keyed by it.
  // Round 1 (B3): instance children report "" for bindings they only inherit
  // from the main — resolve through the main child.
  const mc = mainCorrespondent(node.id, ctx);
  const binding = (key: string): string | undefined => {
    const own = styleIdValue(n[key]);
    if (own) return own;
    if (mc) {
      const inherited = styleIdValue((mc as Record<string, unknown>)[key]);
      if (inherited) return inherited;
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
            styleType: (st as any).type, // BaseStyle.type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID' | …
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

  // SVG markup — our extension (REST cannot do this), namespaced per B5
  if (SVG_EXPORT_TYPES.has(node.type)) {
    try {
      const bytes = await node.exportAsync({ format: "SVG" });
      // The sandbox has no TextDecoder — base64 carries the bytes; the
      // bridge decodes with Buffer (never hand-rolled fromCharCode).
      figmaAgentExt(out).svgBase64 = figma.base64Encode(bytes);
    } catch {
      /* export not allowed for this node — skip */
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
      return { start: s.start, end: s.end, style: buildTypeStyle(source) };
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
