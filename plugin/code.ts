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

const PLUGIN_VERSION = "3.5.1";
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
        } else if (params.instances && Array.isArray(params.instances)) {
          // Round 5 D4/#11: instance-vs-main subtree accessibility — which
          // children are visible, with which ids, and whether main-side
          // (library) child ids resolve in this file's id space.
          const out: any[] = [];
          for (const iid of params.instances as string[]) {
            try {
              const inst: any = await figma.getNodeByIdAsync(iid);
              if (!inst) {
                out.push({ id: iid, error: "not found" });
                continue;
              }
              const main: any = await inst.getMainComponentAsync();
              const kids = Array.isArray(inst.children) ? inst.children.map((c: any) => c.id) : null;
              const mainKids = main
                ? Array.isArray(main.children)
                  ? main.children.map((c: any) => c.id)
                  : null
                : null;
              // can a main-side (library) child id resolve here?
              let resolvedMainChild: string | null = null;
              if (mainKids && mainKids.length && typeof mainKids[0] === "string") {
                try {
                  const n = await figma.getNodeByIdAsync(mainKids[0]);
                  resolvedMainChild = n ? n.id : null;
                } catch (e) {
                  resolvedMainChild = `error: ${(e as Error).message}`;
                }
              }
              out.push({
                id: iid,
                type: inst.type,
                childIds: kids,
                mainId: main?.id ?? null,
                mainRemote: main?.remote ?? null,
                mainChildIds: mainKids,
                mainChildResolvesHere: resolvedMainChild,
              });
            } catch (e) {
              out.push({ id: iid, error: (e as Error).message });
            }
          }
          payload = { instances: out };
        } else if (Array.isArray(params.ids) && params.ids.length > 0) {
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
              // Round 5 D4: raw prototype-transition facts — legacy reads +
              // reactions as the plugin really reports them (transition:
              // null in interactions vs REST's transitionDuration 300).
              try {
                rec.transitionReads = {
                  duration: node.transitionDuration ?? null,
                  easing: node.transitionEasing ?? null,
                  nodeID: node.transitionNodeID ?? null,
                };
                rec.reactionsRaw = JSON.parse(JSON.stringify(node.reactions ?? null));
              } catch (e) {
                rec.transitionError = (e as Error).message;
              }
              // Round 5 (#11 residue): MIXED style ids on rich text — the
              // per-segment bindings are the only view of what REST reports
              // node-level for these nodes.
              // Round 5 F2: pin-to-viewport reads — typings expose no
              // scrollBehavior; check whether the runtime does anyway.
              try {
                const pin: any = {};
                try { pin.scrollBehavior = (node as any).scrollBehavior ?? null; } catch (e) { pin.scrollBehavior = `error: ${(e as Error).message}`; }
                try { pin.isFixed = (node as any).isFixed ?? null; } catch (e) { pin.isFixed = `error: ${(e as Error).message}`; }
                const names = new Set<string>();
                let proto: any = Object.getPrototypeOf(node);
                let guard = 0;
                while (proto && guard++ < 20) {
                  for (const nm of Object.getOwnPropertyNames(proto)) names.add(nm);
                  proto = Object.getPrototypeOf(proto);
                }
                pin.protoScrollish = [...names].filter((nm) => /scroll|fixed|sticky/i.test(nm));
                rec.pinReads = pin;
              } catch {
                /* pin probe unavailable */
              }
              if (node.type === "TEXT") {
                try {
                  const segs = (node as any).getStyledTextSegments(["fillStyleId", "textStyleId", "hyperlink"]);
                  rec.textSegments = segs.map((s: any) => ({
                    fillStyleId: s.fillStyleId ?? null,
                    textStyleId: s.textStyleId ?? null,
                    hyperlink: s.hyperlink ?? null,
                    characters: String(s.characters ?? "").slice(0, 24),
                  }));
                } catch (e) {
                  rec.textSegments = `error: ${(e as Error).message}`;
                }
              }
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
        } else if (params.styles === true) {
          // Round 4 diagnostics: raw local-style enumeration, sync vs async
          // getters side by side — settles how style ids really look (two
          // files reported a single style with an empty id marker).
          const dump: Record<string, any> = {};
          const getterPairs: [string, string, string][] = [
            ["paint", "getLocalPaintStyles", "getLocalPaintStylesAsync"],
            ["text", "getLocalTextStyles", "getLocalTextStylesAsync"],
            ["effect", "getLocalEffectStyles", "getLocalEffectStylesAsync"],
            ["grid", "getLocalGridStyles", "getLocalGridStylesAsync"],
          ];
          const brief = (s: any) => ({
            id: s?.id ?? null,
            key: s?.key ?? null,
            name: s?.name ?? null,
            remote: s?.remote === true,
          });
          for (const [label, syncName, asyncName] of getterPairs) {
            const entry: Record<string, any> = {};
            try {
              const sync = (figma as any)[syncName]?.();
              entry.sync = Array.isArray(sync)
                ? { count: sync.length, styles: sync.map(brief) }
                : String(sync);
            } catch (e) {
              entry.syncError = (e as Error).message;
            }
            try {
              const async = await (figma as any)[asyncName]?.();
              entry.async = Array.isArray(async)
                ? { count: async.length, styles: async.map(brief) }
                : String(async);
            } catch (e) {
              entry.asyncError = (e as Error).message;
            }
            dump[label] = entry;
          }
          payload = { fileKey: await effectiveFileKey(), styles: dump };
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

// Timing accumulator — reset per extraction, reported under _figmaAgent
// (dev diagnostics for slow extractions; stripped by the normalizer).
const TIMINGS = { nodes: 0, serializeMs: 0, segmentsMs: 0, getStyleMs: 0, styleCalls: 0 };

async function extractFramePayload(node: SceneNode): Promise<Record<string, unknown>> {
  const t0 = Date.now();
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
      timings: { ...TIMINGS, totalMs: Date.now() - t0 },
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
  TIMINGS.nodes = 0;
  TIMINGS.serializeMs = 0;
  TIMINGS.segmentsMs = 0;
  TIMINGS.getStyleMs = 0;
  TIMINGS.styleCalls = 0;

  while (stack.length) {
    const node = stack.pop()!;
    if (++count > MAX_NODES_PER_EXTRACTION) {
      throw new Error(`frame too large: more than ${MAX_NODES_PER_EXTRACTION} nodes — split the extraction`);
    }
    let obj: Record<string, unknown>;
    try {
      const _t0 = Date.now();
      obj = await serializeNode(node, ctx);
      TIMINGS.serializeMs += Date.now() - _t0;
      TIMINGS.nodes++;
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

/**
 * The first NODE-type action's destination across a node's reactions —
 * REST's legacy `transitionNodeID`. Cross-file destinations included: the
 * plugin reports the destination's own id (e.g. a library-side frame)
 * even though it cannot resolve the node itself.
 */
function firstNodeDestinationId(reactions: unknown): string | undefined {
  if (!Array.isArray(reactions)) return undefined;
  for (const r of reactions as any[]) {
    const actions = Array.isArray(r?.actions) ? r.actions : r?.action ? [r.action] : [];
    for (const a of actions as any[]) {
      if (a?.type === "NODE" && typeof a?.destinationId === "string" && a.destinationId) {
        return a.destinationId;
      }
    }
  }
  return undefined;
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
    const mc = mainCorrespondent(node, ctx);
    const inherited = mainProp(mc, "constraints");
    if (inherited && typeof inherited !== "symbol") constraints = inherited;
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
  // Round 5 (D4): REST derives the legacy triple from reactions — and the
  // legacy reads above are always null in current Figma (probed: even a
  // wired instance reports null from all three). The first NODE action's
  // destinationId IS the destination node id, cross-file included (probed:
  // '10:1098', the library-side frame REST emits). Duration/easing remain
  // server-side — the bridge's rest-bootstrap transition table injects
  // them at persist time (deviation #16).
  if (out.transitionNodeID === undefined) {
    const dest = firstNodeDestinationId(n.reactions);
    if (dest) out.transitionNodeID = dest;
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
    // Round 6 (#21) — register every range-bound style id in the file-level
    // styles map (REST's map includes styles referenced only from rich-text
    // ranges) and normalize entry values to the marker form, exactly like
    // the node-level binding loop below.
    const sot = out.styleOverrideTable as Record<string, Record<string, unknown>> | undefined;
    if (sot) {
      for (const entry of Object.values(sot)) {
        for (const field of ["inheritFillStyleId", "inheritTextStyleId"] as const) {
          const id = entry?.[field];
          if (typeof id !== "string" || !id || styles[id]) continue;
          try {
            const _st0 = Date.now();
            TIMINGS.styleCalls++;
            const st = await figma.getStyleByIdAsync(id);
            TIMINGS.getStyleMs += Date.now() - _st0;
            if (!st) continue;
            const nodeId = st.id.includes(",") ? st.id.slice(st.id.indexOf(",") + 1) : st.id;
            styles[nodeId] = {
              key: st.key,
              name: st.name,
              description: st.description ?? "",
              remote: (st as any).remote === true,
              styleType: restStyleType((st as any).type),
            };
            if (nodeId !== id) entry[field] = nodeId;
          } catch {
            /* style unresolvable — keep the raw id */
          }
        }
      }
    }
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
        const _st0 = Date.now();
        TIMINGS.styleCalls++;
        const st = await figma.getStyleByIdAsync(id);
        TIMINGS.getStyleMs += Date.now() - _st0;
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
    const _seg0 = Date.now();
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
      // Round 6 (#21) — per-range bound style ids ARE exposed here (probed;
      // the typings' claim "not exposed" was wrong). REST surfaces them as
      // inheritFillStyleId/inheritTextStyleId on styleOverrideTable entries.
      "fillStyleId",
      "textStyleId",
    ]);
    TIMINGS.segmentsMs += Date.now() - _seg0;
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
        // marker form ("S:<hash>,<nodeId>") — the bridge join renames to
        // the library-side node id at persist time (deviation #10)
        inheritFillStyleId: styleIdValue(s.fillStyleId) || undefined,
        inheritTextStyleId: styleIdValue(s.textStyleId) || undefined,
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
