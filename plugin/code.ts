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
  mapColor,
  mapEffects,
  mapPaints,
  omitEmpty,
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

function effectiveFileKey(): string {
  return figma.fileKey ?? `local-${figma.root.id.replace(/:/g, "-")}`;
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
  return { fileKey: effectiveFileKey(), pages };
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
    fileKey: effectiveFileKey(),
    _figmaAgent: {
      source: "plugin",
      extractedAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
    },
  };
}

async function extractTree(root: SceneNode): Promise<ExtractionResult> {
  const components: Record<string, unknown> = {};
  const componentSets: Record<string, unknown> = {};
  const styles: Record<string, unknown> = {};

  const objByNode = new Map<BaseNode, Record<string, unknown>>();
  const stack: SceneNode[] = [root];
  let count = 0;

  while (stack.length) {
    const node = stack.pop()!;
    if (++count > MAX_NODES_PER_EXTRACTION) {
      throw new Error(`frame too large: more than ${MAX_NODES_PER_EXTRACTION} nodes — split the extraction`);
    }
    objByNode.set(node, await serializeNode(node, components, componentSets, styles));

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

function absoluteBox(node: SceneNode): Record<string, number> | undefined {
  const bb = (node as any).absoluteBoundingBox;
  if (!bb) return undefined;
  return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
}

function parentHasAutoLayout(node: BaseNode): boolean {
  const parent = node.parent;
  if (!parent || !("layoutMode" in parent)) return false;
  const mode = (parent as any).layoutMode;
  return mode && mode !== "NONE";
}

async function serializeNode(
  node: SceneNode,
  components: Record<string, unknown>,
  componentSets: Record<string, unknown>,
  styles: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const n = node as any;

  // B1 — invariant core
  const out: Record<string, unknown> = omitEmpty({
    id: node.id,
    name: node.name,
    type: restNodeType(node.type),
    visible: node.visible,
    absoluteBoundingBox: absoluteBox(node),
  });

  // B3 — mixed sentinels; B2 — omit absent like REST
  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = n.opacity;
  if (n.blendMode && n.blendMode !== "NORMAL") out.blendMode = n.blendMode;
  if (n.constraints) out.constraints = { horizontal: n.constraints.horizontal, vertical: n.constraints.vertical };

  // fills / strokes / background (paints may be figma.mixed)
  for (const key of ["fills", "strokes", "background"]) {
    const paints = n[key];
    if (paints === undefined || paints === null) continue;
    if (typeof paints === "symbol") {
      out[key] = MIXED;
      continue;
    }
    if (Array.isArray(paints) && paints.length) out[key] = mapPaints(paints);
  }

  // strokes geometry
  if (Array.isArray(n.strokes) && n.strokes.length) {
    if (n.strokeWeight !== undefined && n.strokeWeight !== null) {
      out.strokeWeight = typeof n.strokeWeight === "symbol" ? MIXED : n.strokeWeight;
    }
    if (typeof n.strokeWeight === "symbol" && n.individualStrokeWeights) {
      out.individualStrokeWeights = { ...n.individualStrokeWeights };
    }
    if (n.strokeAlign) out.strokeAlign = n.strokeAlign;
    if (Array.isArray(n.strokeDashes) && n.strokeDashes.length) out.strokeDashes = n.strokeDashes;
    if (n.dashPattern && Array.isArray(n.dashPattern) && n.dashPattern.length) {
      out.strokeDashes = out.strokeDashes ?? n.dashPattern;
    }
  }

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
  if (typeof n.cornerSmoothing === "number" && n.cornerSmoothing) out.cornerSmoothing = n.cornerSmoothing;

  // effects — shadows, blurs, noise, texture (nothing dropped)
  if (Array.isArray(n.effects) && n.effects.length) out.effects = mapEffects(n.effects);

  // auto-layout container properties (only when layoutMode is active — REST's omission behaviour)
  if (n.layoutMode && n.layoutMode !== "NONE") {
    Object.assign(
      out,
      omitEmpty({
        layoutMode: n.layoutMode,
        layoutWrap: n.layoutWrap,
        primaryAxisSizingMode: n.primaryAxisSizingMode,
        counterAxisSizingMode: n.counterAxisSizingMode,
        primaryAxisAlignItems: n.primaryAxisAlignItems,
        counterAxisAlignItems: n.counterAxisAlignItems,
        paddingLeft: n.paddingLeft,
        paddingRight: n.paddingRight,
        paddingTop: n.paddingTop,
        paddingBottom: n.paddingBottom,
        itemSpacing: typeof n.itemSpacing === "symbol" ? MIXED : n.itemSpacing,
        counterAxisSpacing: typeof n.counterAxisSpacing === "symbol" ? MIXED : n.counterAxisSpacing,
        layoutPositioning: n.layoutPositioning,
        itemReverseZIndex: n.itemReverseZIndex,
        strokesIncludedInLayout: n.strokesIncludedInLayout,
      }),
    );
  }
  if (n.clipsContent === true) out.clipsContent = true;

  // how this node sits inside its parent's auto layout (child props)
  if (parentHasAutoLayout(node)) {
    if (n.layoutAlign) out.layoutAlign = n.layoutAlign;
    if (n.layoutGrow) out.layoutGrow = n.layoutGrow;
  }

  // text nodes — characters + style + per-character overrides (agent.md §7.3.8)
  if (node.type === "TEXT") {
    Object.assign(out, serializeText(node as TextNode));
  }

  // components / instances
  if (node.type === "INSTANCE") {
    const inst = node as InstanceNode;
    try {
      const main = inst.mainComponent ?? (await inst.getMainComponentAsync().catch(() => null));
      if (main) {
        out.componentId = main.id;
        registerComponent(main, components, componentSets);
      }
    } catch {
      /* main component inaccessible (library not loaded) — componentId omitted */
    }
    if (n.componentProperties) out.componentProperties = n.componentProperties;
  }
  if ((node.type === "COMPONENT" || node.type === "COMPONENT_SET") && n.componentPropertyDefinitions) {
    out.componentPropertyDefinitions = n.componentPropertyDefinitions;
  }
  if (node.type === "COMPONENT") {
    registerComponent(node as ComponentNode, components, componentSets);
  }
  if (node.type === "COMPONENT_SET") {
    registerComponentSet(node as ComponentSetNode, componentSets);
  }

  // bound styles — REST emits `styles` (ids) on nodes, metadata at file level
  if (n.styles && Object.keys(n.styles).length) {
    out.styles = { ...n.styles };
    for (const id of Object.values(n.styles as Record<string, string>)) {
      if (id && !styles[id]) {
        try {
          const st = await figma.getStyleByIdAsync(id);
          if (st) {
            styles[id] = {
              key: st.id,
              name: st.name,
              description: st.description ?? "",
              remote: (st as any).remote === true,
              styleType: (st as any).styleType,
            };
          }
        } catch {
          /* style unresolvable — referenced id still emitted on the node */
        }
      }
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
  components[comp.id] = {
    key: comp.id,
    name: comp.name,
    description: comp.description ?? "",
    ...(setId ? { componentSetId: setId } : {}),
    documentationLinks: [],
    remote: false,
  };
  if (setId && parent) registerComponentSet(parent as ComponentSetNode, componentSets);
}

function registerComponentSet(set: ComponentSetNode, componentSets: Record<string, unknown>) {
  if (componentSets[set.id]) return;
  componentSets[set.id] = {
    key: set.id,
    name: set.name,
    description: set.description ?? "",
    documentationLinks: [],
    remote: false,
  };
}

// ---------------------------------------------------------------------------
// TEXT — characters · style · characterStyleOverrides · styleOverrideTable
// ---------------------------------------------------------------------------

function serializeText(t: TextNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.characters = t.characters;

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
        textDecoration: s.textDecoration,
        textCase: s.textCase,
        paragraphSpacing: s.paragraphSpacing,
        paragraphIndent: s.paragraphIndent,
        textAlignHorizontal: t.textAlignHorizontal,
        textAlignVertical: t.textAlignVertical,
        fills: s.fills,
      };
      return { start: s.start, end: s.end, style: buildTypeStyle(source) };
    });
  } catch {
    /* fonts unavailable — fall back to node-level aggregate below */
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

  // node-level text properties REST puts inside `style`
  const styleExtras = omitEmpty({
    textAutoResize: t.textAutoResize,
    textTruncation: (t as any).textTruncation,
    maxLines: (t as any).maxLines,
  });
  Object.assign(style, styleExtras);

  out.style = style;
  out.characterStyleOverrides = characterStyleOverrides;
  out.styleOverrideTable = styleOverrideTable;
  // lineTypes/lineIndentations are newer plugin APIs — read defensively and
  // default to one "NONE" line per paragraph like REST does for plain text.
  const lineCount = t.characters.split(/\r\n|\r|\n/).length;
  out.lineTypes = ((t as any).lineTypes as string[] | undefined) ?? new Array(lineCount).fill("NONE");
  out.lineIndentations =
    ((t as any).lineIndentations as number[] | undefined) ?? new Array(lineCount).fill(0);
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
  return { images, fileKey: effectiveFileKey() };
}
