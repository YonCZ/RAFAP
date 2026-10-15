# RAFAP — REST Parity Report

**RAFAP (Rest API Figma Agent Plugin)** is a local drop-in replacement for
the Figma REST API: a Figma plugin + loopback bridge that serves the file you
have open in Figma through `GET /v1/files/:key`-shaped responses, with no
rate limits, no tokens, and no cloud round-trips.

This report documents the architecture, every change made during the
parity work, measured performance against the real API, known gaps, and
future work.

---

## 1. What this is

```
Figma desktop app ── plugin (long-poll) ──> bridge (127.0.0.1:3001)
                                                │
REST clients / AI agents ── GET /v1/... ────────┘
```

- **Plugin** (`plugin/code.ts`): walks the live document, serializes every
  node into REST-shaped JSON (`plugin/lib/rest-mapping.ts` holds the pure
  mapping rules), and answers bridge commands (frame pulls, page index).
- **Bridge** (`bridge-server.ts`): Express app exposing `/v1/*` plus an
  agent-command queue; caches extractions in `store/` keyed by local file
  key; loopback-only.
- **Store** (`store/local-<key>/`): per-frame JSON payloads, `pages.json`,
  `meta.json`. `GET /v1/files/:key/nodes` auto-pulls live when the plugin is
  connected, otherwise serves the cache.
- **Golden-diff harness** (`tools/golden-diff.ts`, `tools/normalize.ts`):
  fetches the same node subtree from the real REST API and from the bridge,
  normalizes both, and diffs the document trees. This was the engine of the
  whole parity effort.

The reference corpus: a real file ("DevBoard", 2 pages, 32 top-level frames,
2,361 nodes, ~2.4 MB of REST JSON), snapshotted **once** from
`api.figma.com` and cached permanently under `golden/` (gitignored — real
design data). All 32 frames are diffed per-frame against that snapshot.

## 2. The parity rewrite — every change

The original serializer produced "reasonable plugin-shaped JSON". The REST
API's actual output follows dozens of undocumented emission rules. All of
them below were **measured** against real payloads — never guessed from the
OpenAPI spec (whose `optional` flags are wrong about half of these).

### Round 1 — measured emission rules (3,387 diffs → analyzed)

- `visible` only when `false`; `blendMode`/`opacity` omitted when default.
- `absoluteRenderBounds`, `fills`, `strokes`, `effects`, `interactions`,
  `scrollBehavior` on **every** node (`[]` / `"SCROLLS"` defaults).
- `strokeWeight` default `1`, `strokeAlign: "INSIDE"`,
  `complexStrokeProperties: {strokeType: "BASIC"}` everywhere (except
  BOOLEAN_OPERATION, which REST leaves it off).
- Non-uniform per-side stroke weights → `individualStrokeWeights` + max as
  the scalar (never both partially).
- Constraints: plugin MIN/MAX/STRETCH → REST LEFT/RIGHT/LEFT_RIGHT mapping.
- Zero paddings, `MIN` alignments, `0` itemSpacing, non-FIXED sizing modes
  omitted.
- `layoutAlign`/`layoutGrow`/`layoutSizing*` only on auto-layout children
  (plus `layoutSizing` on auto-layout frames with non-AL parents).
- Frames emit `background`, derived `backgroundColor` (first visible SOLID
  fill), real `clipsContent`.
- Text style: `fontPostScriptName: null`, `letterSpacing: 0` default, never
  `fills` in `style`.
- Override-table (mixed-segment texts) deltas: fills included; the four
  font-identity keys travel together as a group.
- `exportSettings` → `{format, constraint: {type: "SCALE", value: 1},
  suffix: ""}` (constraint even for SVG).
- `cornerSmoothing` only alongside radii; aspect lock → `preserveRatio` +
  `targetAspectRatio`.
- Style bindings from `*StyleId` properties (empty string = unbound).
- `componentId` for instances resolved across pages (fixed a throw).

### Round 2 — style bindings & layout gating (561 → 442 structural diffs)

- Empty-string guard on all `*StyleId` reads; style metadata resolution via
  `figma.getStyleByIdAsync`.
- Layout-field gating per parent auto-layout state.
- `backgroundColor` ignores invisible fills.
- `exportSettings` shape, `cornerSmoothing` radii rule, `itemSpacing` 0
  omitted, `preserveRatio` from aspect lock.

### Round 3 — remote styles & misc (442 → 263 on the reference frame)

- Remote style metadata (`key`, `name`, `remote`, `styleType` via
  `BaseStyle.type`, not `styleType`).
- `componentProperties` only when non-empty.
- `preserveRatio` suppressed inside auto-layout parents (the layout drives
  sizing there).
- `boundVariables` stripped from layout grids (REST grids carry none).

### Round 4 — masks, groups, nulls (4,267 → 3,117 across all 32 frames)

- `absoluteRenderBounds` emitted as `null` when not rendered (REST emits
  the key with null — our sanitizer had been stripping it).
- `isMask: true` + `maskType` on mask nodes.
- `booleanOperation` on BOOLEAN_OPERATION nodes.
- `locked: true` when locked.
- GROUP nodes carry `background`/`backgroundColor`/`clipsContent`.
- `textAutoResize` omitted when `NONE`.
- `arcData` on arc'd ellipses.
- `componentPropertyReferences` on nodes inside components.
- IMAGE paints: `filters` omitted when all-default, `rotation` when 0.
- `resetVideoPosition: false` stripped from interaction actions.
- Constraint fallbacks for plugin gaps: GROUP → LEFT/TOP, auto-layout child
  → SCALE/SCALE.
- VECTOR masks with smoothing set but no radius → REST's zeroed
  `rectangleCornerRadii: [0,0,0,0]` + `cornerSmoothing: 0`.

### Round 5 — style ids, plural keys, imageHash (final)

- **Style id resolution**: plugin style ids are `S:<hash>,<nodeId>` — the
  suffix is the file-local node id REST emits for local styles. Bindings and
  the file-level `styles` map now use it. (Remote/library styles keep the
  local marker id — see deviations.)
- **Local style enumeration**: REST's file-level `styles` map lists *every*
  local style, used or not — now enumerated via
  `getLocal{Paint,Text,Effect,Grid}StylesAsync`.
- **Plural style keys**: REST emits `fills`/`strokes` alongside
  `fill`/`stroke` (same value) on FRAME/COMPONENT/INSTANCE nodes — measured
  with zero counterexamples across 315 styled nodes.
- **`imageRef`**: the plugin API renamed it to `imageHash` — same 40-hex
  value REST emits; now mapped through.
- BOOLEAN_OPERATION: constraints now emitted (fallback applies), but
  `layoutSizing*` never (REST omits both there — round 4 had this backwards).
- COMPONENT_SET carries the frame-like `background` set.
- Shadow `spread` only emitted when non-zero (REST never emits zeros).

### Rounds 6–8 — final verification fixes

- **`backgroundColor.a` folds paint `opacity`** (round 6): plugin solid
  paints carry no color alpha — alpha lives in `paint.opacity`; REST keeps
  `opacity` separate in `fills` but multiplies it into `backgroundColor.a`.
- **Non-uniform strokes: scalar `strokeWeight` = 1** (round 7): measured
  41/41 non-uniform nodes in REST carry the constant `1` as the scalar (a
  placeholder), not the max side — the previous max rule only coincided on
  36 of them. `individualStrokeWeights` themselves are byte-exact.
- **Mixed-fill texts** (round 8): the node-level `fills` is the default
  segment's paint instead of the `figma::mixed` sentinel (matches REST on
  7/8 such nodes; the last one is the text-baseline deviation).
- **Dev-loop automation**: `tools/restart-plugin.sh` closes and re-runs the
  dev plugin via AppleScript (Figma won't re-run an already-open plugin from
  the menu — it must be closed with Escape first). Publish → restart →
  fresh pull became a single unattended command.

### Test suite

32 unit tests (`tests/rest-mapping.test.ts`) covering the pure mapping
rules: constraints mapping, the line-height trio, font-group delta rule,
fills deltas, paint edge cases. `npm run check` gates both tsconfigs.

## 3. How it performs against the real API

### Structural fidelity

- **Document tree: exact match.** Node ids, types, ordering, children
  counts — identical across all 32 frames (verified by id-set and path
  comparison). No missing or extra nodes anywhere in a 2,361-node file.

### Golden-diff progression (all 32 frames, document trees)

| Stage | Differing paths (normalized) |
|---|---|
| Initial serializer | 3,387 on a single frame — effectively every node wrong |
| After round 2 | 442 (reference frame) |
| After round 4 | 3,117 across all 32 frames |
| After round 5 | 2,381 |
| After rounds 6–8 (final) | **2,355 — every one a documented deviation** |

Two frames (175:1274, 188:1443) are byte-identical after normalization.
The final 2,355 paths classify exhaustively (a path-walking classifier,
not eyeballing) into the deviation families below — zero unclassified
residue.

### Speed & limits

| | Real REST API | RAFAP |
|---|---|---|
| Full file (~2.4 MB, 2,361 nodes) | one request, seconds, **counts against quota** | ~7 s fresh extraction, **~0 ms cached** |
| Single frame (~180 KB) | re-downloads whole file server-side | 0.25–1.3 s live pull, ~0 ms cached |
| Rate limit | X req/min per token | none — it's your machine |
| Auth | token required | none (loopback) |
| Requires | file published/accessible to token | file **open in Figma** for fresh pulls |
| SVG per node | not available in file payloads | `_figmaAgent.svgBase64` on every shape |

The real API was called **twice** in this entire effort (initial snapshot +
verification that the file hadn't drifted); the golden fixtures are cached
permanently, so regression testing is free.

### Where it beats the API

- No rate limits, no tokens, no egress — everything stays on your machine.
- Live data: pulls reflect the file *as currently open*, including unsaved
  edits (REST serves the last saved version).
- Inline SVG exports per node (REST file payloads can't do this at all).
- `?fresh=1` cache bypass.

## 4. Where it lacks (documented deviations)

Full list with rationale in `docs/rest-parity-deviations.md`. The ones with
measurable impact on the reference file:

1. **`layoutVersion`** — never emitted (492 paths). The plugin API has no
   layout version counter.
2. **Remote style ids** (643 paths) — for library styles, `node.styles`
   values and map keys are local marker ids instead of the library file's
   node ids. The 40-hex `key` matches REST exactly, so bindings ↔ styles are
   still correlatable; local styles are byte-exact.
3. **Instance `overrides`** (146) and **`fillOverrideTable`** (130) — not
   exposed by the plugin API at all.
4. **Intrinsic `lineHeightPx` is an estimate** (455) — height ÷ line count,
   rounded; REST computes from font metrics (17.9004 vs 18). Includes ~20
   fixed-height texts where we omit rather than lie.
5. **`lineHeightPercent` for PIXELS-unit texts** (~74).
6. **Text default-style baseline** (~281) — REST stores a base style +
   per-range diffs where the base sometimes matches no segment; we use
   segment[0]. Information-equivalent, not byte-identical; includes the
   mixed-fill texts where the node-level `fills` swaps with its override
   entry.
7. **`fontPostScriptName` always null** (38) — not derivable from the
   plugin.
8. Small-count items: inherited instance-child `SCALE`/`SCALE` constraints
   (26), radius history (14, 7 nodes), pinned frames (6), rotation history
   (4), frame-level `transition*` from remote destinations (3), inherited
   instance-child style bindings (3), per-range `inherit*StyleId` (2).

## 5. What needs more work

- **Instance override tables** (`overrides`, `fillOverrideTable`) — the
  biggest remaining gap; would need diffing an instance against its main
  component node-by-node (feasible: the plugin exposes both sides).
- **Inherited style bindings on instance children** — resolve via the main
  component's corresponding child (the `;`-suffix in instance child ids
  encodes the original node id).
- **Text metrics** — an intrinsic line-height table for common fonts would
  fix the ~500 line-height paths; alternatively document the estimate
  forever (values are within a fraction of a pixel).
- **Writes (v4+)** — the read surface is done; creating/updating nodes via
  the bridge is the natural next phase.
- **`geometry=paths`** — `relativeTransform` and vector path data.
- **Remote style ids** — fundamentally unavailable; could optionally let the
  operator supply a library-file mapping.
- **Open-source hardening** (this push): MIT license, README, in-repo plugin
  build (`npm run build:plugin`), secret scrub verified, golden/store
  gitignored.

## 6. Verification method (reproducible)

```bash
# one-time: cache the real API snapshot (token in ~/.figma-token)
curl -H "X-Figma-Token: $(cat ~/.figma-token)" \
  https://api.figma.com/v1/files/<KEY> -o golden/file-<KEY>.rest.json

# pull every frame fresh through the bridge, then:
npx tsx tools/golden-diff.ts "248:563" --file-key <KEY> --local-key local-<hash>

# after editing plugin code, redeploy without leaving the terminal:
npm run publish && tools/restart-plugin.sh 3002
```

The normalizer rounds floats to 4 decimals, strips `figma::mixed` sentinels,
and compares document trees only (component/style maps informally).
