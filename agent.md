# Figma Agent — Project Context & v3 Implementation Plan

> **Audience:** AI coding assistants (Cursor / Copilot / OpenCode / Claude Code) working in this repo.
> **Read this file completely before editing anything.** It defines what exists, what is sacred, what to build, and how to prove it works.

---

## 0. How to use this file

1. Read §1–§4 to load context.
2. Read §5 (Operating Rules) — these are hard constraints, not suggestions.
3. Pick a phase (§6–§10). Phase B and C are the real work.
4. Follow §13 (Execution Protocol) — read first, propose diffs second, typecheck always.
5. Use §14 (Definition of Done) and §15 (Appendix mapping tables) as your reference while coding.

---

## 1. What this project is

**Figma Agent** is a local, rate-limit-free pipeline that extracts design data from the Figma desktop app and serves it to AI coding agents.

- **Today (v2):** JSON design trees in our own conventions, persisted to disk, exposed via custom `/api/*` endpoints and optional MCP tools.
- **Goal (v3):** a **drop-in local replacement** for the official Figma REST API (`api.figma.com`), so any SDK client, agent, or prompt built against Figma's real API works against ours unchanged — while remaining a *superset* (inline SVG, pull-mode commands, zero rate limits, zero tokens).

### Data flow

```
Figma Desktop
  └── plugin  (code.js sandbox  ↔  ui.html iframe, via postMessage)
        │   HTTP polling (pull mode) + manual buttons (push mode)
        ▼
      bridge  (Express, Node + tsx)
        │   • REST-parity /v1 routes            (v3 — to build)
        │   • agent command queue               (built)
        │   • permanent disk store frames/<id>.json (built)
        ▼
      agents: plain HTTP/curl, direct disk reads, or MCP tools (built)
```

### Why it exists

| Official REST API | Figma Agent |
|---|---|
| Rate limited — 429s in practice on file-content endpoints (free tier) | No rate limits; plugin runs inside the live document |
| Requires a personal access token | No token needed for our own use |
| Cannot export real SVG markup per node | Inline `svg` via `exportAsync` |
| Cannot read per-range text styles cheaply | `getStyledTextSegments` gives exact per-range styles |
| Read-only for file content | Read now, writes later (v4+, human-gated) |

### Long-term goal

Open-source it (MIT) as a standalone repo + Figma Community plugin.

**Competitors:** Figma's official Dev Mode MCP server, Framelink's `figma-context-mcp`. Both are REST-based, therefore both are rate-limited and token-gated.

**Our differentiation:** plugin-based (no token, no rate limits) · pull-mode (agent queues commands, plugin executes) · permanent disk persistence · REST-shape compatibility so existing tooling works unchanged.

---

## 2. Current status (verified end-to-end)

### Live production instance — DO NOT TOUCH
- Plugin folder `Agent Plugin/`, bridge on **port 3001**, running from a separate legacy copy inside a private webapp repo.
- Another AI session actively reads design data through it.

### This repo — `figma-bridge/` (canonical home)
Contains the bridge server, the plugin source (canonical), docs, and the
golden-diff tooling. **v3 (REST parity) is implemented**: extractor v3 +
`/v1` routes + store v2 + security hardening + unit tests. See §4 for
what remains (end-to-end verification + golden diff).

### Plugin extractor v2 — fully working
- Full design trees: `id` / `name` / `type` / `x` / `y` / `width` / `height`, `children`
- Fills & strokes as **hex** + opacity + gradient stops
- Per-range text styles via `getStyledTextSegments` (real fonts, weights, sizes, colors when styles vary inside one text node)
- Effects incl. shadows and blurs
- Rotation, `absoluteRenderBounds`, dash patterns, per-side strokes, per-corner radii + smoothing, blend modes, clipping
- Auto-layout: mode, `itemSpacing`, paddings, alignment, sizing modes, wrap, per-child `layoutAlign` / `layoutGrow`
- Real SVG markup for vector/icon nodes via `exportAsync`
- Component info, incl. cross-page instance resolution via `getMainComponentAsync`

### Bridge — built
- **Push mode:** plugin buttons "Send Selected Frame(s)" / "Send Page Index"
- **Pull mode:** agent queues a command (`page-index` | `frame {id}` | `selection`); the open plugin polls (~1.5s), executes, returns. 20s command timeout.
- Every received frame persists permanently to `frames/<id>.json`; re-sending the same id refreshes the snapshot
- Read endpoints: `/api/frames`, `/api/frames/<id>`, `/api/latest`, `/api/page-index`, `/api/health`
- Optional MCP tools (stdio): `list_figma_frames`, `get_figma_frame`, `get_latest_figma_frame`, `request_from_figma`
- `BRIDGE_PORT` env override exists so dev testing runs on port 3002 without touching the shared 3001 instance

---

## 3. Repo layout

```
Programming/Figma/
├── Agent Plugin/       # LIVE plugin (port 3001 flow) — DO NOT EDIT
├── Figma Agent/        # DEV plugin (human creates via Figma wizard; wired to 3002) — Phase A
└── figma-bridge/       # ← this repo, the canonical home
    ├── bridge-server.ts     # Express + command queue + MCP + frames store
    ├── plugin/              # canonical plugin source: code.ts, ui.html, manifest.json
    ├── frames/              # received design trees (gitignored)
    ├── docs/
    │   ├── agent_coding_instructions.md     # how agents use the bridge
    │   └── human_setup_connection_guide.md  # setup + publish workflow
    ├── package.json
    ├── tsconfig.json
    └── agent.md             # this file
```

### Commands (run inside `figma-bridge/`)

| Command | Purpose |
|---|---|
| `npm start` | Bridge on **3001** — production. Do not run. |
| `npm run start:dev` | Bridge on **3002** — your dev target. |
| `npm run check` | TypeScript typecheck. Must pass after every change. |
| `npm run publish` | Sync `plugin/` → dev plugin folder + build. **Human-approved only.** |

---

## 4. Known gaps / honest status

- **End-to-end verification pending (human needed):** run `npm start`,
  open the Figma Agent plugin in Figma, and exercise `/v1/files/:key`.
  Code is typechecked and unit-tested (29 tests) but has NOT yet run
  against the live plugin.
- **Golden diff: not run** (human REST token status uncertain). The
  harness exists: `npm run golden-diff` + `tools/normalize.ts`.
- **Implemented in v3:** REST envelope + node schema (§7), `/v1` routes
  (§8) incl. `?fresh=1` orchestration and `/v1/images`, store v2 keyed
  by real file key, 127.0.0.1 bind + Host validation + CORS posture,
  long-poll command queue, `characterStyleOverrides` +
  `styleOverrideTable` (delta-based, deduped), SVG via base64 under
  `_figmaAgent`, iterative traversal with a 20 000-node cap.
- **Known follow-ups:** prototype fields (reactions/transitions) not yet
  extracted; `geometry=paths` not supported; `?fresh=1` on very large
  files pulls every frame sequentially (≤3 concurrent) and can take a
  while — fine locally.
- The legacy webapp copy's `frames/` belongs to that session. This repo
  uses `store/<fileKey>/`.

---

## 5. Operating rules (CRITICAL — hard constraints)

1. **Port 3001 and the `Agent Plugin/` folder are production.** Another AI session may be mid-extraction at any moment. Never kill, restart, edit, or reference them. No exceptions without explicit human permission.
2. **All development and testing happens on port 3002** (`npm run start:dev`) with the dev plugin.
3. **Plugin source edits happen only in `figma-bridge/plugin/`.** They reach the dev/live plugin folder *exclusively* via `npm run publish` (human-approved sync + build), after which a human reopens the plugin in Figma.
4. **Humans run shared processes.** The bridge runs in the human's own terminal. AI sessions ask; they never spawn, kill, restart, or manage the server.
5. **`npm run check` must pass** after every change. Never leave the tree red.
6. **Never commit secrets.** No tokens, no `--secret` file contents, no absolute local paths in docs.
7. **Do not relitigate settled design decisions** (§11) without a concrete technical reason.

---

## 6. Phase A — Wiring the dev instance *(DONE)*

The `Figma Agent/` dev plugin folder exists (created via the Figma
wizard, id `1692298303631543959`), the repo source is synced into it via
`npm run publish`, and it builds with typecheck + esbuild (bundle). The
manifest has `networkAccess` → `localhost:3002` and
`documentAccess: dynamic-page`. Old `Agent Plugin` / 3001 stays frozen.

**After any publish, a human must reopen the plugin in Figma** to load
the new build.

---

## 7. Phase B — Extractor v3: REST parity *(the meat, part 1)*

**File:** `figma-bridge/plugin/code.ts`
**Goal:** output mirrors `GET https://api.figma.com/v1/files/:file_key` so closely that a REST client cannot tell the difference — except that ours is a superset.

### 7.0 Prerequisite gotcha — document access mode

With `"documentAccess": "dynamic-page"` in the manifest, **only the current page's subtree is loaded by default.** Walking `figma.root.children` will give you page stubs.

- To extract a full page: `await figma.loadAllPagesAsync()` (or `page.loadAsync()`).
- To resolve an instance's main component on another page: `await instance.getMainComponentAsync()`.
- Always `try/catch` these — they can reject for inaccessible/library content.

If the manifest omits `documentAccess`, the legacy full-document model applies and everything is loaded eagerly (slower startup, simpler traversal). **Decide once and be consistent.** Recommendation: use `dynamic-page` + explicit loads, because it keeps large files responsive.

Also note: **avoid unbounded recursion.** Use an explicit stack/queue for traversal. Deeply nested Figma trees can blow the call stack, and a plugin crash loses the whole extraction.

---

### 7.1 The response envelope

`GET /v1/files/:key` returns this shape. Our extractor + bridge must reproduce it.

```jsonc
{
  "name": "My Design File",
  "lastModified": "2026-10-15T09:12:33Z",
  "thumbnailUrl": "…",
  "version": "…",
  "role": "owner",
  "editorType": "figma",
  "schemaVersion": 0,
  "document": {
    "id": "0:0",
    "name": "Document",
    "type": "DOCUMENT",
    "children": [
      {
        "id": "0:1",
        "name": "Page 1",
        "type": "CANVAS",
        "backgroundColor": { "r": 0.96, "g": 0.96, "b": 0.96, "a": 1 },
        "prototypeFlowStartingPoints": [],
        "children": [ /* FRAME / COMPONENT / … nodes */ ]
      }
    ]
  },
  "components":    { "<nodeId>": { "key": "…", "name": "…", "description": "…", "containingFrame": "…", "containingStateGroup": null } },
  "componentSets":{ "<nodeId>": { "key": "…", "name": "…", "description": "…" } },
  "styles":       { "<styleId>": { "key": "…", "name": "…", "styleType": "FILL", "description": "" } }
}
```

`GET /v1/files/:key/nodes?ids=1:2,1:3` returns:

```jsonc
{
  "nodes": {
    "1:2": {
      "document": { /* the node subtree */ },
      "components": {},
      "componentSets": {},
      "schemaVersion": 0,
      "styles": {},
      "name": "Frame 1"
    }
  },
  "err": null
}
```

Note the asymmetry: the file endpoint puts the tree at `document`; the nodes endpoint puts each tree at `nodes[id].document`. **Get this right — it is the #1 drop-in-compatibility breakage.**

---

### 7.2 Serialization contract (the anti-missing-fields rules)

These five rules are non-negotiable. They are what makes the output feel like a real API instead of a scraped blob.

| # | Rule | Why |
|---|---|---|
| **B1** | **Invariant core on every node:** `id`, `name`, `type`, `absoluteBoundingBox`, `visible`, `children` | Clients assume these exist. `children` is `[]` for leaves, never absent. |
| **B2** | **Omit optional props exactly when REST omits them.** Never emit `null`, never emit `undefined`, never emit a zero-value placeholder for an absent property. | REST clients do `if ('cornerRadius' in node)`. Emitting `null` changes that branch. |
| **B3** | **Use the `"figma::mixed"` sentinel string** for mixed values instead of dropping the data or picking an arbitrary segment. | This is REST's exact convention. Dropping loses information silently. |
| **B4** | **Unknown node types pass through** with the invariant core + `children`. Never collapse to `null`, never throw. | Forward compatibility when Figma ships new node types. |
| **B5** | **Our extensions live in clearly-namespaced extra fields**, e.g. `_figmaAgent: { svg, extractedAt, pluginVersion, source }`. Never overwrite or shadow a REST field name. | Keeps the payload a strict superset and makes golden-diff normalization trivial. |

**Extra recommendation (not in the original plan, add it):** emit object keys in a **deterministic order**. Stable key order makes diffs readable and lets you byte-compare snapshots across runs.

---

### 7.3 Type mappings — Plugin API → REST API

#### 7.3.1 Node types

Most are identical uppercase strings. **Known divergences to handle explicitly:**

| Plugin API `node.type` | REST `type` | Note |
|---|---|---|
| `POLYGON` | `REGULAR_POLYGON` | **Real gotcha — must map.** |
| `PAGE` (i.e. `figma.root.children[n]`) | `CANVAS` | Pages serialize as `CANVAS`. |
| `figma.root` | `DOCUMENT` | id `0:0`, name `"Document"`. |
| `BOOLEAN_OPERATION` | `BOOLEAN_OPERATION` | Include `booleanOperation` field (`UNION`/`SUBTRACT`/`INTERSECT`/`EXCLUDE`). |
| `STICKY`, `SHAPE_WITH_TEXT`, `CONNECTOR`, `WASHI_TAPE`, `TABLE`, `TABLE_CELL`, `HIGHLIGHT` | same | FigJam types — pass through with core + children if unmapped. |

#### 7.3.2 Colors — **floats 0–1, never hex**

This is the single biggest v2→v3 change. Drop all hex conversion.

```typescript
// REST Color: { r, g, b, a } — all floats 0..1
// REST Paint: has its own separate `opacity` float.
function mapColor(c: RGB, a = 1) {
  return { r: c.r, g: c.g, b: c.b, a };
}

function mapPaint(paint: Paint): Record<string, unknown> | undefined {
  if (!paint.visible && paint.visible !== undefined) {
    // REST includes `visible: false` when explicitly hidden; omit when true-by-default
  }
  switch (paint.type) {
    case 'SOLID':
      return omitUndefined({
        type: 'SOLID',
        visible: paint.visible === false ? false : undefined,
        opacity: paint.opacity !== 1 ? paint.opacity : undefined,
        blendMode: paint.blendMode ?? 'NORMAL',
        color: mapColor(paint.color),
        // `a` presence: resolve via golden diff — REST sometimes includes it,
        // sometimes relies on paint.opacity. Default: include `a` from opacity.
      });

    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      return omitUndefined({
        type: paint.type,
        visible: paint.visible === false ? false : undefined,
        opacity: paint.opacity !== 1 ? paint.opacity : undefined,
        blendMode: paint.blendMode ?? 'NORMAL',
        gradientHandlePositions: paint.gradientHandlePositions.map(p => ({ x: p.x, y: p.y })),
        gradientStops: paint.gradientStops.map(s => ({
          position: s.position,
          color: mapColor(s.color, s.color.a ?? 1),
        })),
      });

    case 'IMAGE':
      return omitUndefined({
        type: 'IMAGE',
        visible: paint.visible === false ? false : undefined,
        opacity: paint.opacity !== 1 ? paint.opacity : undefined,
        blendMode: paint.blendMode ?? 'NORMAL',
        scaleMode: paint.scaleMode,               // FILL | FIT | CROP | TILE
        imageRef: paint.imageHash ?? undefined,
        imageTransform: paint.imageTransform,      // 2x3 matrix, CROP only
        scalingFactor: paint.scalingFactor,        // TILE only
        rotation: paint.rotation,                  // TILE only
        filters: paint.filters,
      });

    case 'VIDEO':
    case 'EMOJI':
    case 'STICKER':
      return { type: paint.type, visible: paint.visible === false ? false : undefined };

    default:
      // Unknown paint type — pass through with `type` so nothing is silently lost.
      return { type: (paint as Paint).type };
  }
}
```

`omitUndefined(obj)` = strip every key whose value is `undefined` (Rule B2). Write it once, use it everywhere.

```typescript
function omitUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
```

#### 7.3.3 The `"figma::mixed"` sentinel

The Plugin API returns the `figma.mixed` symbol when a property varies across a node's contents (text ranges, or a frame's children with differing radii/strokes). REST encodes this as the literal string `"figma::mixed"`.

```typescript
const MIXED = 'figma::mixed' as const;

/** Map a possibly-mixed plugin value to its REST representation. */
function mapMixed<T>(val: T | typeof figma.mixed): T | typeof MIXED {
  return val === figma.mixed ? MIXED : val;
}

// Usage — every property that can be mixed MUST go through this:
// fontSize, fontName, fontWeight, letterSpacing, lineHeight, textDecoration,
// textCase, fills, cornerRadius, strokeWeight, strokeAlign, opacity, itemSpacing…
const fontSize = mapMixed(node.fontSize);
```

**Rule:** never write `node.fontSize` directly into the output. Always `mapMixed(...)`. Grep for bare property reads during review.

#### 7.3.4 Geometry & transforms

```typescript
// REST absoluteBoundingBox: { x, y, width, height } — floats
absoluteBoundingBox: node.absoluteBoundingBox
  ? { x, y, width, height }
  : undefined   // omitted for nodes with no bounds (Rule B2)

absoluteRenderBounds: node.absoluteRenderBounds ?? undefined  // includes effect bleed

relativeTransform: node.relativeTransform ?? undefined         // [[a,b,c],[d,e,f]] 2×3

size: { width: node.width, height: node.height }

constraints: { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical }

rotation: node.rotation !== 0 ? node.rotation : undefined
```

**Per-corner radii & per-side strokes** — REST uses arrays in a specific order:

```typescript
// cornerRadius (uniform) OR rectangleCornerRadii [TL, TR, BR, BL]
cornerRadius:       node.cornerRadius !== figma.mixed ? node.cornerRadius : MIXED,
rectangleCornerRadii: node.rectangleCornerRadii ?? undefined,
cornerSmoothing:    node.cornerSmoothing || undefined,

// strokeWeight (uniform number) OR per-side [top, right, bottom, left]
strokeWeight: mapMixed(node.strokeWeight),
individualStrokeWeights: node.strokeWeight === figma.mixed
  ? { top, right, bottom, left }
  : undefined,

strokeAlign: node.strokeAlign,      // INSIDE | OUTSIDE | CENTER
dashPattern: node.dashPattern?.length ? node.dashPattern : undefined,
```

> ⚠️ Your `agent.md` says "`strokeWeight` as `[top,right,bottom,left]` when per-side." The real REST API actually emits a **uniform number** in `strokeWeight` and puts per-side values in `individualStrokeWeights` as an object. **Emit both shapes during development and let the golden diff (§9) settle it.** Flag this in your PR description.

#### 7.3.5 Effects

```typescript
type RESTEffect =
  | { type: 'DROP_SHADOW' | 'INNER_SHADOW'; visible: boolean; radius: number;
      spread?: number; color: RGBA; blendMode: string;
      offset: { x: number; y: number }; showShadowBehindNode?: boolean }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; visible: boolean; radius: number }
  | { type: 'NOISE' | 'TEXTURE'; visible: boolean; /* … */ };

function mapEffects(effects: readonly Effect[]): RESTEffect[] {
  return effects
    .filter(e => e.visible !== false || true)   // REST includes invisible effects with visible:false
    .map(e => {
      switch (e.type) {
        case 'DROP_SHADOW':
        case 'INNER_SHADOW':
          return omitUndefined({
            type: e.type,
            visible: e.visible,
            radius: e.radius,
            spread: 'spread' in e ? e.spread : undefined,
            color: mapColor(e.color, e.color.a ?? 1),
            blendMode: e.blendMode ?? 'NORMAL',
            offset: { x: e.offset.x, y: e.offset.y },
            showShadowBehindNode: 'showShadowBehindNode' in e ? e.showShadowBehindNode : undefined,
          }) as RESTEffect;
        case 'LAYER_BLUR':
        case 'BACKGROUND_BLUR':
          return { type: e.type, visible: e.visible, radius: e.radius };
        default:
          return { type: (e as Effect).type, visible: (e as Effect).visible } as RESTEffect;
      }
    });
}
```

Include `NOISE` and `TEXTURE` if present — do not silently drop them.

#### 7.3.6 Auto-layout — full REST property set

Use REST names verbatim. The Plugin API mostly matches already.

```typescript
// On FRAME / COMPONENT / INSTANCE (auto-layout containers)
layoutMode:              node.layoutMode,               // NONE | HORIZONTAL | VERTICAL
layoutWrap:              node.layoutWrap,               // NO_WRAP | WRAP
primaryAxisSizingMode:   node.primaryAxisSizingMode,    // FIXED | AUTO
counterAxisSizingMode:   node.counterAxisSizingMode,    // FIXED | AUTO
primaryAxisAlignItems:   node.primaryAxisAlignItems,    // MIN | CENTER | MAX | SPACE_BETWEEN
counterAxisAlignItems:   node.counterAxisAlignItems,    // MIN | CENTER | MAX | BASELINE
paddingLeft:             node.paddingLeft,
paddingRight:            node.paddingRight,
paddingTop:              node.paddingTop,
paddingBottom:           node.paddingBottom,
itemSpacing:             node.itemSpacing,              // may be figma.mixed when wrapping
counterAxisSpacing:      node.counterAxisSpacing,
layoutPositioning:       node.layoutPositioning,        // AUTO | ABSOLUTE
itemReverseZIndex:       node.itemReverseZIndex,
strokesIncludedInLayout: node.strokesIncludedInLayout,
clipsContent:            node.clipsContent,

// On each CHILD of an auto-layout container
layoutAlign:             child.layoutAlign,             // MIN | CENTER | MAX | STRETCH | INHERIT
layoutGrow:              child.layoutGrow,              // 0 | 1
layoutPositioning:       child.layoutPositioning,
```

**Rule:** emit auto-layout container props only when `layoutMode !== 'NONE'`. Emit child props only when the parent actually has auto-layout. This matches REST's omission behaviour.

#### 7.3.7 Components & instances

```typescript
// COMPONENT node
{ ...core, componentPropertyDefinitions: node.componentPropertyDefinitions }

// INSTANCE node
{
  ...core,
  componentId: node.mainComponent?.id,     // ← REST requires this on instances
  isExposedInstance: node.isExposedInstance,
  exposedInstances: node.exposedInstances?.length ? node.exposedInstances : undefined,
  componentProperties: node.componentProperties,
  overrides: node.overrides?.length ? node.overrides : undefined,
}

// COMPONENT_SET node
{ ...core, componentPropertyDefinitions: node.componentPropertyDefinitions }
```

Cross-page resolution:

```typescript
let main = instance.mainComponent;
if (!main) {
  try { main = await instance.getMainComponentAsync(); } catch { main = null; }
}
```

Collect every resolved main component into the top-level `components` map keyed by node id — REST puts them there, not inline.

#### 7.3.8 TEXT nodes — `characterStyleOverrides` + `styleOverrideTable`

This is the hardest mapping in the whole project and the one most likely to be wrong. Read it twice.

**What REST returns:**

```jsonc
{
  "type": "TEXT",
  "characters": "Hello World",
  "style": { "fontFamily": "Inter", "fontWeight": 400, "fontSize": 14, "textAlignHorizontal": "LEFT", … },
  "characterStyleOverrides": [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
  "styleOverrideTable": {
    "1": { "fontFamily": "Inter", "fontWeight": 700, "fontSize": 14 }
  },
  "styles": { "text": "<styleId>" },
  "lineTypes": ["NONE"],
  "lineIndentations": [0]
}
```

Semantics:
- `style` = the **default** (index `0`) TypeStyle for the whole node.
- `characterStyleOverrides` = one integer **per character**, same length as `characters`.
- `0` means "use `style`". Any `n > 0` means "look up `styleOverrideTable[n]`".
- `styleOverrideTable` keys are stringified integers; values are **partial** TypeStyle objects containing only the differing properties.
- Table entries are **deduplicated** — identical override styles share one id.

**Implementation:**

```typescript
const TEXT_STYLE_FIELDS = [
  'fontName', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight',
  'textDecoration', 'textCase', 'fills', 'hyperlink',
  'opentypeFlags', 'paragraphSpacing', 'paragraphIndent',
  'listOptions', 'textStyleId',
] as const;

function mapSegmentToRESTStyle(seg: StyledTextSegment): Record<string, unknown> {
  return omitUndefined({
    fontFamily:        seg.fontName?.family,
    fontPostScriptName: seg.fontName?.style,
    fontWeight:        seg.fontWeight,
    fontSize:          seg.fontSize,
    textAlignHorizontal: seg.textAlignHorizontal,
    textAlignVertical:   seg.textAlignVertical,
    letterSpacing:     normalizeSpacing(seg.letterSpacing),   // {value, unit:'PIXELS'|'PERCENT'}
    lineHeight:        normalizeLineHeight(seg.lineHeight),   // {value, unit} | 'AUTO'
    textDecoration:    seg.textDecoration,                    // NONE | STRIKETHROUGH | UNDERLINE
    textCase:          seg.textCase,                          // ORIGINAL | UPPER | LOWER | TITLE | SMALL_CAPS
    italic:            seg.fontName?.style?.toLowerCase().includes('italic') || undefined,
    fills:             seg.fills?.map(mapPaint).filter(Boolean),
    hyperlink:         seg.hyperlink ?? undefined,
    opentypeFlags:     seg.opentypeFlags ?? undefined,
    paragraphSpacing:  seg.paragraphSpacing ?? undefined,
    paragraphIndent:   seg.paragraphIndent ?? undefined,
  });
}

function normalizeSpacing(s: LetterSpacing | undefined) {
  if (!s) return undefined;
  return s.unit === 'AUTO' ? { value: 0, unit: 'AUTO' } : { value: s.value, unit: s.unit };
}

function normalizeLineHeight(l: LineHeight | undefined) {
  if (!l) return undefined;
  return l.unit === 'AUTO' ? { value: 0, unit: 'AUTO' } : { value: l.value, unit: l.unit };
}

/** Cheap structural deep-equal — plugin sandbox has NO dependencies, write your own. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a as object), bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

function mapTextNodeToREST(node: TextNode) {
  // Font loading is NOT required for reading segments, but guard anyway —
  // getStyledTextSegments can throw on unloaded/corrupt text.
  const segments = node.getStyledTextSegments([...TEXT_STYLE_FIELDS]);
  const characters = node.characters;

  const characterStyleOverrides: number[] = new Array(characters.length).fill(0);
  const styleOverrideTable: Record<string, Record<string, unknown>> = {};
  let nextOverrideId = 1;

  if (segments.length === 0) {
    return { characters, style: {}, characterStyleOverrides: [], styleOverrideTable: {} };
  }

  const defaultStyle = mapSegmentToRESTStyle(segments[0]);

  for (const seg of segments) {
    const segStyle = mapSegmentToRESTStyle(seg);

    if (deepEqual(segStyle, defaultStyle)) {
      // 0 = inherit default. Array is already zero-filled.
      continue;
    }

    // Dedup: reuse an existing table entry if the style is identical.
    let id = Object.keys(styleOverrideTable).find(
      k => deepEqual(styleOverrideTable[k], segStyle)
    );
    if (!id) {
      id = String(nextOverrideId++);
      styleOverrideTable[id] = segStyle;
    }

    for (let i = seg.start; i < seg.end && i < characters.length; i++) {
      characterStyleOverrides[i] = Number(id);
    }
  }

  return omitUndefined({
    characters,
    style: defaultStyle,
    characterStyleOverrides,
    styleOverrideTable,
    styles: node.styles && Object.keys(node.styles).length ? node.styles : undefined,
    lineTypes: node.lineTypes,
    lineIndentations: node.lineIndentations,
    layoutVersion: node.layoutVersion,
  });
}
```

**Edge cases you must handle (write tests for each):**

| Case | Expected behaviour |
|---|---|
| Empty text (`characters === ""`) | `characterStyleOverrides: []`, `styleOverrideTable: {}`, no crash |
| Single uniform style | All zeros, empty `styleOverrideTable` |
| Override identical to default | Must stay `0` — do **not** allocate a table entry |
| Three segments, two with identical styles | Must produce **one** table entry, reused |
| Segment `end` beyond `characters.length` | Clamp; never write out of bounds |
| Emoji / surrogate pairs / combining marks | `characters.length` counts UTF-16 units. REST does the same. Do not "fix" it — match REST, and note it in a comment. |
| Mixed `fontSize` across the node | Goes through `mapMixed`, not into the segment path |
| `node.styles.text` bound to a library style | Include in `styles` map |

---

### 7.4 SVG export (our extension, not REST parity)

Keep it, but move it out of the REST-shaped body into the namespaced extension:

```typescript
async function exportSvg(node: SceneNode): Promise<string | undefined> {
  try {
    const bytes = await node.exportAsync({ format: 'SVG', constraint: { type: 'SCALE', value: 1 } });
    // Plugin sandbox has no TextDecoder. Base64-encode here, decode in the bridge.
    return figma.base64Encode(bytes);   // bridge does Buffer.from(b64,'base64').toString('utf8')
  } catch {
    return undefined;   // export can fail on unsupported nodes — never throw upward
  }
}

// Emitted as:
_figmaAgent: { svgBase64: '…', extractedAt: '…', pluginVersion: '…', source: 'plugin' }
```

**Never** decode UTF-8 by hand with `String.fromCharCode` on large payloads — it is O(n²) in some engines and corrupts multibyte sequences. Base64 → bridge-side `Buffer` is correct and fast.

---

### 7.5 Payload transport guardrails

- `postMessage` has practical size limits and large payloads can stall the UI iframe.
- **Rule:** one command = one frame subtree. Never `postMessage` an entire document in one shot.
- If a single frame serializes above ~2 MB, chunk it: send `{ partIndex, partCount, chunk }` and reassemble in the bridge.
- Add a node-count cap per command (e.g. 20 000 nodes) and return a structured error above it rather than hanging.

---

### 7.6 Phase B checklist

- [ ] All hex color conversion removed; floats 0–1 everywhere
- [ ] `mapMixed` applied to every mixable property (grep for bare reads)
- [ ] `omitUndefined` used on every emitted object
- [ ] `POLYGON → REGULAR_POLYGON` mapped
- [ ] Pages serialize as `CANVAS`; root as `DOCUMENT` id `0:0`
- [ ] `characterStyleOverrides` + `styleOverrideTable` implemented with dedup
- [ ] All 8 text edge cases from §7.3.8 covered
- [ ] Iterative (non-recursive) traversal
- [ ] `documentAccess` / `loadAllPagesAsync` handled
- [ ] SVG moved to `_figmaAgent.*`, base64-encoded
- [ ] Per-frame chunking + node cap
- [ ] Unknown node types pass through with core + children
- [ ] `npm run check` passes

---

## 8. Phase C — Bridge v3: REST-compatible routes *(the meat, part 2)*

**File:** `figma-bridge/bridge-server.ts`
**Goal:** turn the Express server into a drop-in local replacement for `api.figma.com`.

### 8.1 Security fixes (do these first)

The current server binds all interfaces. That is a real exposure on shared networks.

```typescript
const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';  // NEVER '0.0.0.0', never 'localhost'
const PORT = Number(process.env.BRIDGE_PORT ?? 3002);
```

**Bind explicitly:**

```typescript
server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
});
```

> Use the numeric literal `127.0.0.1`, not `'localhost'`. `localhost` can resolve to `::1` or a routable address depending on `/etc/hosts` and DNS order. Numeric binding is unambiguous.

**Host-header validation (blocks DNS rebinding):**

```typescript
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host || !ALLOWED_HOSTS.has(host)) {
    console.warn(`[security] rejected request, Host: ${host ?? '<none>'}`);
    return res.status(403).type('text/plain').send('Invalid Host header');
  }
  next();
});
```

**CORS — important nuance:** the plugin UI runs in a Figma iframe whose `Origin` is `null`. If you lock CORS to a strict allowlist you will break the plugin→bridge direction. Correct posture:

- Allow `Origin: null` (Figma plugin iframe) and `http://localhost:*` / `http://127.0.0.1:*`.
- Rely on **Host-header validation + loopback binding** as the primary defense, not CORS.
- Never reflect arbitrary origins with `Access-Control-Allow-Credentials: true`.

**Optional shared secret:** `--secret <path>` reads a file; when present, require `X-Figma-Agent-Secret` on mutating/command-queue routes. Read-only `/v1/*` GETs stay open so drop-in clients work. Default: off.

### 8.2 Authentication pass-through

SDK clients and agents send `Authorization: Bearer <token>`. Rejecting it breaks drop-in compatibility. **Accept any bearer token and ignore it.**

```typescript
app.use((req, _res, next) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    // Accepted and intentionally not validated: this is a local, loopback-only bridge.
    req.log?.debug('bearer token accepted (ignored)');
  }
  next();
});
```

Also accept `X-Figma-Token` for parity with REST clients that use header auth.

### 8.3 Route table

| Method | Path | Source | Notes |
|---|---|---|---|
| `GET` | `/v1/files/:key` | disk store, stitched | Full REST envelope (§7.1). `?depth=N` and `?ids=…` supported. `?fresh=1` forces a re-pull via the command queue. |
| `GET` | `/v1/files/:key/nodes` | disk store | `?ids=1:2,1:3`. Returns `{ nodes: { [id]: { document, components, componentSets, schemaVersion, styles, name } }, err: null }`. |
| `GET` | `/v1/images/:key` | plugin `exportAsync` | `?ids=…&format=png\|svg\|jpg\|pdf&scale=N`. Returns `{ images: { [id]: url }, err: null }` pointing at `http://127.0.0.1:3002/assets/<id>.<ext>`. Serve from an on-disk asset cache. |
| `GET` | `/v1/me` | static | `{ id, handle, email }`. Trivial, but clients call it during init and fail loudly without it. |
| `GET` | `/v1/files/:key/components` | disk store | Published-component parity; best-effort from local `components` map. |
| `GET` | `/v1/files/:key/styles` | disk store | Same. |
| `GET` | `/v1/files/:key/versions` | disk store | Our own snapshot history (superset — REST returns server versions). |
| — | existing `/api/*` | unchanged | **Keep them.** v2 agents and the MCP tools depend on them. v3 is additive. |

### 8.4 File key handling

Use the real Figma file key so routes and cache keys match what an agent would use against `api.figma.com`.

```typescript
// plugin side
const fileKey = figma.fileKey;   // string | undefined
```

`figma.fileKey` can be `undefined` (offline, local-only files, older API versions). Handle it:

```typescript
const effectiveKey = figma.fileKey ?? `local-${figma.root.id}-${hash(figma.root.name)}`;
```

Index the disk store by **both** the real key (when known) and a stable fallback, and accept either in `:key`. Store `fileKey` in every `frames/<id>.json` so stitching can group frames correctly.

### 8.5 Stitching the envelope

```typescript
function buildFileEnvelope(fileKey: string, opts: { depth?: number; ids?: string[] }) {
  const frames = diskStore.getFramesForFile(fileKey);
  const pages  = diskStore.getPagesForFile(fileKey);

  const canvasChildren = opts.ids
    ? frames.filter(f => opts.ids!.includes(f.id)).map(f => f.document)
    : frames.map(f => f.document);

  return {
    name: diskStore.getFileName(fileKey) ?? 'Figma Agent Local File',
    lastModified: new Date(Math.max(0, ...frames.map(f => f.extractedAt ?? 0))).toISOString(),
    version: `local-${fileKey}`,
    role: 'owner',
    editorType: 'figma',
    schemaVersion: 0,
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: pages.map(p => ({
        id: p.id,
        name: p.name,
        type: 'CANVAS',
        backgroundColor: p.backgroundColor,
        prototypeFlowStartingPoints: [],
        children: canvasChildren.filter(c => c._pageId === p.id),
      })),
    },
    components:    diskStore.getComponents(fileKey),
    componentSets: diskStore.getComponentSets(fileKey),
    styles:        diskStore.getStyles(fileKey),
    _figmaAgent: { source: 'plugin', frameCount: frames.length, generatedAt: new Date().toISOString() },
  };
}
```

Apply `?depth=N` by pruning children past depth N **after** stitching (REST prunes server-side; we prune in the bridge — same observable result).

### 8.6 Transport: keep long-polling

**Do not replace the command queue with WebSockets or SSE.** This is deliberate:

- Polling is self-healing when the plugin window closes and reopens.
- Command latency tolerance is seconds, not milliseconds.
- Long-poll (server holds `next-command` up to ~10s, plugin polls ~1.5s, 20s command timeout) gives near-instant dispatch without connection lifecycle bugs.

Keep the existing queue implementation intact. Only change the **response shapes** to the v3 REST envelope.

### 8.7 Large documents

Per-frame command fallback instead of one giant `postMessage`:

1. Agent requests `/v1/files/:key?fresh=1`.
2. Bridge queues `page-index` → plugin returns the frame id/name/type list.
3. Bridge queues `frame <id>` for each missing/stale frame, **sequentially or with concurrency ≤ 3**.
4. Each frame persists to `frames/<id>.json` as it lands.
5. Bridge stitches and responds.

This means partial progress survives a plugin reload — a big robustness win over monolithic extraction.

### 8.8 Phase C checklist

- [ ] Bound to `127.0.0.1`, not all interfaces
- [ ] Host-header allowlist middleware in place
- [ ] CORS allows `null` origin + loopback; never `*` with credentials
- [ ] `Authorization: Bearer …` and `X-Figma-Token` accepted and ignored
- [ ] `/v1/me` implemented
- [ ] `/v1/files/:key` with envelope, `?depth`, `?ids`, `?fresh=1`
- [ ] `/v1/files/:key/nodes?ids=` with `nodes[id].document` nesting + `err: null`
- [ ] `/v1/images/:key` with local asset URLs + on-disk cache
- [ ] `/v1/files/:key/components` + `/styles`
- [ ] Existing `/api/*` and MCP tools untouched and still working
- [ ] `figma.fileKey` used; `undefined` handled with stable fallback
- [ ] Long-polling queue preserved (no WebSockets/SSE)
- [ ] Per-frame fallback extraction with concurrency cap
- [ ] Structured JSON logging: route, duration ms, cache hit/miss, frame ids, errors
- [ ] `npm run check` passes

---

## 9. Phase D — Golden-diff verification

**Goal:** prove parity, don't assume it.

### 9.1 Procedure

1. Pick 3–5 representative frames: a simple card, a complex auto-layout form, a text-heavy screen with mixed styles, a vector/icon frame, a component instance with overrides.
2. For each, fetch from **both** sources:
   - `GET https://api.figma.com/v1/files/:key/nodes?ids=<id>` (human's REST token, sparingly)
   - `GET http://127.0.0.1:3002/v1/files/:key/nodes?ids=<id>` (ours)
3. **Normalize** both trees, then deep-compare.
4. Iterate until identical modulo documented, intentional differences.

### 9.2 Rate-limit discipline

- Use `?depth=2` on full-file fetches to shrink payloads and avoid timeouts.
- **One** REST call per frame per iteration. Never loop.
- Cache every successful REST response to `golden/<frameId>.json` and diff against the cache on subsequent runs.
- On `429`: stop, do a docs-first pass (read the OpenAPI spec instead of calling), retry when the window resets.
- If the token is exhausted: generate expected fixtures from the **OpenAPI spec** (`figma/rest-api-spec`) and diff against those instead.

### 9.3 Normalizer rules

Write `tools/normalize.ts`. It must:

- Strip `_figmaAgent` and any other `_`-prefixed extension fields
- Sort all object keys alphabetically (recursively)
- Round all floats to 4 decimals (transform/anti-aliasing jitter)
- Strip volatile fields: `lastModified`, `version`, `thumbnailUrl`, `extractedAt`
- Normalize `characterStyleOverrides` ids by **canonicalizing the override table**: renumber entries in first-appearance order, since dedup may assign different ids than the server
- Normalize empty objects `{}` vs absent keys → treat as absent (matches Rule B2)
- Output canonical JSON (`JSON.stringify(obj, null, 2)`)

### 9.4 Output

`docs/golden-diff-report.md` containing, per frame: pass/fail, the exact diff, and a classification of each difference as:

- **BUG** — we must fix it
- **INTENTIONAL SUPERSET** — documented extension
- **REST QUIRK** — server behaviour we deliberately differ from, with rationale

Run `npm run check` and the diff in CI if you add one.

---

## 10. Phase E — Repo polish for open source

- Rename branding to **Figma Agent** throughout (README, docs, package name, plugin UI)
- Add MIT `LICENSE`
- README rewrite for the public repo: what it is, why (rate limits), quickstart, architecture diagram, REST-parity table, known deviations
- Figma Community listing copy + screenshots
- `CONTRIBUTING.md`, issue templates
- Scrub: absolute local paths, the human's file keys, any token references, the legacy `Agent Plugin/` mentions
- Ensure `frames/` and any `golden/` fixtures with real design data are gitignored or replaced with synthetic fixtures

---

## 11. Deliberate design decisions (do not relitigate without cause)

1. **Writes are deferred.** The official REST API is read-only for file content, so writes are an *extension*, not parity. When added (v4+): explicit pull commands (`create-node`, `set-fill`, `set-text`), **one command = one Figma undo step**, and a plugin-UI toggle "Allow write commands" defaulting to **OFF** (human-gated).
2. **Authentication:** accept any `Authorization: Bearer …` header and ignore it. SDK clients send one; rejecting breaks drop-in compatibility.
3. **Security model:** bind to `127.0.0.1` explicitly, validate `Host`, optional `--secret <path>` shared-secret file. No remote access by construction.
4. **No CDN, no cloud.** Fully local. No tokens required for our own usage.
5. **Transport is long-polling**, not WebSockets/SSE — self-healing across plugin reloads, and latency tolerance is seconds.
6. **v3 is additive.** Existing `/api/*` routes and MCP tools stay working. Do not remove or rename them.

---

## 12. Anti-patterns (never do these)

- ❌ Scraping Figma's web UI or reusing browser cookies to impersonate a session
- ❌ Impersonating the `api.figma.com` hostname, or anything that presents our bridge as Figma's official service
- ❌ Retrying in a loop against the real API, or any logic intended to evade rate limits or plan gates
- ❌ Emitting `null` for absent properties (breaks `in` checks — Rule B2)
- ❌ Reading mixable properties without `mapMixed` (silently loses data — Rule B3)
- ❌ Recursive tree walking (stack overflow on deep documents)
- ❌ One giant `postMessage` for a whole document
- ❌ Replacing the polling queue with WebSockets/SSE
- ❌ Touching port 3001 or `Agent Plugin/`
- ❌ Spawning/killing the bridge process from AI tooling
- ❌ Logging tokens, secrets, or full design payloads at info level
- ❌ Hand-rolled UTF-8 decoding via `String.fromCharCode` on export bytes
- ❌ Running `npm run publish` without human approval

---

## 13. Execution protocol for the AI coding agent

**Step 1 — Acknowledge.** State explicitly that you understand: port 3001 and `Agent Plugin/` are sacred, dev is port 3002, plugin edits live only in `figma-bridge/plugin/`, and humans run shared processes.

**Step 2 — Read before writing.** Read, in order:
1. `figma-bridge/plugin/code.ts` — understand the v2 serializer
2. `figma-bridge/bridge-server.ts` — understand the queue, disk store, and MCP layer
3. `figma-bridge/plugin/manifest.json` and `ui.html`
4. `docs/agent_coding_instructions.md`

Report back what you found before proposing changes.

**Step 3 — Propose, don't rewrite blindly.** Deliver concrete, modular diffs or scoped file rewrites. For large files, propose one function/section at a time. Always explain *why* each change matches a numbered rule in this document.

**Step 4 — Typecheck constantly.** `npm run check` after every change. Never leave the tree red. Never silence a type error with `any` to make it pass — fix the type or add a justified `@ts-expect-error` with a comment.

**Step 5 — Test.** Write unit tests for pure functions (`omitUndefined`, `deepEqual`, `mapMixed`, `mapPaint`, `mapTextNodeToREST`, `buildFileEnvelope`, the normalizer). Cover all 8 text edge cases in §7.3.8.

**Step 6 — Ask, never assume.** `npm run publish` and any Figma Desktop action require human approval. If you need the dev plugin created (Phase A), stop and ask.

**Step 7 — Document deviations.** Every place where we intentionally differ from `api.figma.com` goes in `docs/rest-parity-deviations.md` with a one-line rationale.

### Suggested work order

1. §8.1 security fixes (small, high value, unblocks nothing else)
2. §7.2 serialization contract helpers: `omitUndefined`, `mapMixed`, `deepEqual`
3. §7.3.2 color mapping (biggest visible v2→v3 change)
4. §7.3.4–7.3.7 geometry, effects, auto-layout, components
5. §7.3.8 TEXT node overrides (hardest — do it with the helpers already in place)
6. §7.1 envelope + §8.5 stitching
7. §8.3 routes
8. §9 golden diff
9. §10 polish

---

## 14. Definition of Done

v3 is complete when **all** of these hold:

- [ ] `npm run check` passes with zero errors
- [ ] All unit tests pass, including the 8 text edge cases
- [ ] `GET http://127.0.0.1:3002/v1/files/:key` returns a schema-valid REST envelope
- [ ] `GET …/v1/files/:key/nodes?ids=<id>` returns the `nodes[id].document` shape with `err: null`
- [ ] `GET …/v1/me` returns a user object
- [ ] `GET …/v1/images/:key?ids=<id>&format=svg` returns a working local URL
- [ ] A stock Figma REST SDK client, pointed at `http://127.0.0.1:3002` with a dummy bearer token, can read a file and a node **without modification**
- [ ] Golden diff shows zero unexplained differences on all 5 test frames
- [ ] `docs/rest-parity-deviations.md` lists every intentional difference
- [ ] Existing `/api/*` routes and all 4 MCP tools still work unchanged
- [ ] Server binds `127.0.0.1` only; Host-header validation rejects forged hosts
- [ ] Port 3001 and `Agent Plugin/` were never touched (confirm in your final report)

---

## 15. Appendix — Quick reference tables

### 15.1 REST envelope field ownership

| Field | Produced by | Notes |
|---|---|---|
| `name`, `lastModified`, `version`, `role`, `editorType` | bridge | Best-effort local values |
| `schemaVersion: 0` | bridge | Constant |
| `document` (`DOCUMENT` → `CANVAS[]` → nodes) | plugin serializes, bridge stitches | Plugin emits pages + frames; bridge assembles |
| `components`, `componentSets`, `styles` | plugin collects, bridge aggregates | Keyed by node id / style id at the **top level**, not inline |
| `_figmaAgent` | both | Our namespaced extension |

### 15.2 Invariant core (every node)

```
id · name · type · absoluteBoundingBox · visible · children
```

### 15.3 Property-name mapping cheat sheet

| Concept | Plugin API | REST API |
|---|---|---|
| Page node | `PageNode`, `type: 'PAGE'` | `type: 'CANVAS'` |
| Document root | `figma.root`, `type: 'DOCUMENT'` | `type: 'DOCUMENT'`, id `0:0` |
| Polygon | `type: 'POLYGON'` | `type: 'REGULAR_POLYGON'` |
| Mixed value | `figma.mixed` (symbol) | `"figma::mixed"` (string) |
| Color | `{r,g,b}` floats + separate `opacity` | `{r,g,b,a}` floats + `paint.opacity` |
| Text runs | `getStyledTextSegments()` | `characterStyleOverrides` + `styleOverrideTable` |
| Corner radii | `cornerRadius` / `topLeftRadius` … | `cornerRadius` / `rectangleCornerRadii[4]` |
| Stroke weight | `strokeWeight` / per-side | `strokeWeight` / `individualStrokeWeights` *(verify via golden diff)* |
| Auto-layout | `layoutMode`, `itemSpacing`, … | same names |
| Child layout | `layoutAlign`, `layoutGrow` | same names |
| Instance source | `mainComponent` / `getMainComponentAsync()` | `componentId` |
| SVG | `exportAsync({format:'SVG'})` | *not available* — our extension |

### 15.4 Useful references

- Figma REST API: <https://www.figma.com/developers/api>
- **OpenAPI spec + generated TS types (authoritative — use this over prose docs):** <https://github.com/figma/rest-api-spec> (`dist/api_types.ts`)
- REST node types: <https://developers.figma.com/docs/rest-api/file-node-types/>
- REST file endpoints: <https://developers.figma.com/docs/rest-api/file-endpoints/>
- Components & styles endpoints: <https://developers.figma.com/docs/rest-api/component-types/>
- Plugin docs: <https://www.figma.com/plugin-docs/>
- Plugin API reference: <https://developers.figma.com/docs/plugins/api/api-reference/>
- Node types (plugin): <https://developers.figma.com/docs/plugins/api/nodes/>
- `ExportMixin`: <https://www.figma.com/plugin-docs/api/ExportMixin/>
- `figma.clientStorage`: <https://www.figma.com/plugin-docs/api/figma.clientStorage/>
- Variables API: <https://www.figma.com/plugin-docs/api/figma.variables/>
- Styles API: <https://www.figma.com/plugin-docs/api/figma.styles/>
- RGBA color type: <https://developers.figma.com/docs/plugins/api/RGB/>

> **Tip:** the OpenAPI spec in `figma/rest-api-spec` is the single source of truth for field names, optionality, and types. When prose docs and the spec disagree, trust the spec — and note the discrepancy in `docs/rest-parity-deviations.md`.

---

## 16. First message to send back

When you pick up this task, respond with:

1. Confirmation you understand the operating rules in §5 (name port 3001 and `Agent Plugin/` explicitly).
2. Which phase you are starting with.
3. A summary of what you found after reading the four files in §13 Step 2.
4. Your proposed first diff — small, reviewable, and typechecked.

**Then wait for approval before continuing.**