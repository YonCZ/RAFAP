# REST parity deviations

Every intentional difference between RAFAP's `/v1/*` output and
api.figma.com, with rationale. The golden diff (`npx tsx tools/golden-diff.ts`)
is the enforcement mechanism — anything NOT in this list that shows up in a
golden diff is a **BUG**.

Each per-node item notes the measured impact on the DevBoard reference file
(2,361 nodes, 32 top-level frames) — the count of differing diff paths.

## Structural

| # | Deviation | Rationale |
|---|---|---|
| 0 | The `:key` is a **locally derived file key** (`local-<djb2 of sorted page ids>`), not the real Figma file key | `figma.fileKey` requires `enablePrivatePluginApi` — private organization plugins only. Local keys are stable per file and unique across files. Discover via `page-index` or `GET /api/page-index`. |
| 1 | `name` is `"Figma Agent Local File"` | The plugin API cannot read the file's title. Agents can identify files by the real file key. |
| 2 | `lastModified` = max `_figmaAgent.extractedAt` of stored frames | No server; we timestamp at extraction time. |
| 3 | `version` = `local-<fileKey>` | No server-side version hashes. |
| 4 | `components`/`componentSets` maps keyed by node id, with `key` = node id, `documentationLinks: []`, `remote: false` | Publish keys don't exist for unpublished/local components. The shape matches; the key namespace is node ids. |
| 5 | `/v1/*` error responses are `{ status, err }` — matching REST (empirically confirmed via a real 429). The legacy `/api/*` agent routes keep their own `{ error: "…" }` shapes. | Spec `ErrorResponsePayloadWithErrMessage`; measured from a live `{"err": "Rate limit exceeded", "status": 429}`. |
| 6 | `/v1/files/:key/components` and `/styles` return best-effort maps from stored frames | REST's published-component endpoints hit team libraries we cannot see locally. |

## Per-node

| # | Deviation | Impact | Rationale |
|---|---|---|---|
| 7 | `layoutVersion` never emitted | 492 paths (440× `5`, 51× `3`, 1× `4`) | **Round 5 F1 mine (closed as fundamental for the value):** presence is TEXT-only (492/523 TEXT nodes; the 31 absent are all `strokeWeight: 0.0` instance texts — presence is derivable) but the **value is edit history**: a full corpus splitter search (every node key, every style key, type/parent/depth/id-form/char-length) found no feature separating `3` from `5` — the `3` cluster is the login-form labels + library-side instance texts (untouched since their creation era). Modal value `5` fits only 89.4% (440/492), below the ≥99% bar — no rule, no emission. Purely informational in REST (spec: "Avoid using this value"). |
| 8 | Instance `overrides` arrays not emitted | ~146 | The plugin has no override table for instance children. |
| 9 | `fillOverrideTable` not emitted | ~130 | Not exposed by the plugin API. |
| 10 | ~~**Remote style ids**: for library (remote) styles, `node.styles` values and `styles` map keys use the local marker suffix (e.g. `209:80`) instead of the library file's node id (e.g. `10:875`)~~ **Retired (Round 4):** rest-bootstrap join re-keys both to the library node id at persist time | ~~649~~ 6 | The plugin cannot see ids inside the defining library file — but a REST file envelope's `styles` map **is** the key→nodeId join table. One cached call per file (or a saved envelope fixture) mines it; frames are rewritten on persist (`lib/library-harvest.ts`). The bridge auto-bootstraps on fresh pull when the token + `store/file-key-aliases.json` are present (429/offline-safe). Residue: D4 prototype transitions (see *Library style ids* below). |
| 11 | ~~Inherited properties on instance children omitted — style bindings (plugin returns `""`) and `SCALE`/`SCALE` constraints (plugin returns the MIXED sentinel)~~ **style-binding half retired (Round 5 — corrected diagnosis):** the 3 nodes were MIXED *rich text*, not instance inheritance — REST reports the **last styled segment's** binding for those (`getStyledTextSegments`, corpus 3/3: "Not a member? Register now" reports the trailing link segment's fill+text). REST emits only stored per-node bindings elsewhere — no main-inheritance for `node.styles` (measured: instance selves/children with main-side bindings emit nothing). The `SCALE`/`SCALE` constraints half remains | 26 paths (constraints only) | Would require resolving the main component's corresponding child node (the `;`-suffix in instance child ids encodes the original node id). Future work. |
| 12 | `scrollBehavior` always `"SCROLLS"`; `isFixed` never emitted | 3 nodes / 6 paths | The plugin API has no pinned-frame detection. **Round 5 F2 runtime probe (closed):** `node.scrollBehavior` and `node.isFixed` read as `null` on the three pinned "iOS / Status Bar" instances (REST: `isFixed: true`, `scrollBehavior: FIXED`), and a prototype-chain walk finds no scroll/fixed property — the only related surface is `numberOfFixedChildren`, a parent-side aggregate that cannot identify *which* child is pinned. |
| 13 | ~~`fontPostScriptName` always `null`~~ **Retired (Round 2):** bridge-side corpus table emits the 5 (family, style) combos REST names | ~~38~~ 0 | The rule is `Family-Style` (spaces stripped), but REST only has server-side names for some combos — Inter is null except `Inter/Medium` in the corpus. Presence is tabulated in `store/font-metrics.json` (build: `tools/build-font-metrics.ts`), not derived. On `styleOverrideTable` entries REST emits it (name or null) exactly when `fontFamily` is in the delta (34/34 corpus entries). |
| 14 | `rotation` omitted when `0` — REST emits `rotation: 0` on nodes that once had rotation (history) | 4 nodes | The plugin cannot distinguish "never rotated" from "rotated back to 0". |
| 15 | Zeroed `rectangleCornerRadii: [0,0,0,0]` + `cornerSmoothing: 0` not emitted for nodes with radius *history* but zero radius (6 VECTOR + 1 GROUP) | 7 nodes / 14 paths | History is not visible. `VectorNode` exposes **no** corner properties in the plugin API (`cornerRadius`/`cornerSmoothing` are undefined at runtime), so even the mask heuristic cannot fire for vectors; GROUP radius history is likewise invisible. |
| 16 | ~~Frame-level `transitionDuration`/`transitionEasing`/`transitionNodeID` not derived from `NODE` actions~~ **Retired (Round 5):** `transitionNodeID` is derived in the plugin from the first NODE action's `destinationId` (probed: the plugin reports the library-side node id directly, cross-file included); `transitionDuration`/`transitionEasing` are injected by the bridge from the rest-bootstrap transition table (server-side state — probed: legacy reads and `action.transition` are all null while REST reports 300/EASE_OUT) | ~~6~~ 0 | REST derives these from a remote (library) destination frame. `interactions` themselves match REST exactly. |

## Text

| # | Deviation | Impact | Rationale |
|---|---|---|---|
| 17 | ~~Intrinsic `lineHeightPx` is an **estimate**~~ **Retired (Round 2):** rewritten from a corpus-fitted per-family multiplier table | ~~435~~ 0 | `lineHeightPx` for AUTO heights is a pure per-family multiplier × fontSize (906 samples, 4 families, worst-case fit error ~1e-6). The bridge rewrites it at persist time (`lib/font-metrics.ts`, table in gitignored `store/font-metrics.json`). REST emits raw float64 doubles; the golden-diff normalizer rounds to 4 decimals, so a <1e-5 fit is byte-exact after normalization. |
| 18 | ~~`lineHeightPercent` not emitted for `PIXELS`-unit texts~~ **Retired (Round 2):** computed as px ÷ intrinsic × 100 | ~~73~~ 0 | Validated exactly on 146 corpus samples using the multiplier table from #17. Emitted bridge-side at persist time. |
| 19 | ~~Fixed-height intrinsic texts emit no `lineHeightPx`~~ **Retired (Round 2):** the multiplier table makes it derivable | ~~20~~ 0 | Line height is a property of the style, not the box; REST always emits `lineHeightPx` for INTRINSIC regardless of auto-resize, and the rewriter now does too. |
| 20 | Default-style baseline (Round 3, evidence-complete): REST's node base style is the **stored typing style** — the editor's cursor/insertion style — not necessarily any live segment. Measured on all 10 multi-segment corpus texts: 3 match `segments[0]` (our choice), 3 match another segment (the separator space in two nodes, the style-bound "Register now" segment in one), and 4 match **no live segment** (a Semi Bold typing style set with the cursor placed but never typed — every character keeps its own record). Per-range records can also carry node-level fields (`textAutoResize`) with values differing from the node. | ~310 byte paths, **0 semantic** | The typing style is pure editor state — invisible to the plugin API. Both encodings reconstruct identical per-character styles, which the harness proves: the E2 semantic canonicalization (Round 3) re-encodes both sides with base = resolved char-0 style and diffs that (G4: 340 byte → 13 → **2** semantic paths — 11 were Round-6-confirmed fixture staleness, closed by the corpus refresh; the 2 remaining are #37-family override ids). |
| 21 | ~~`styleOverrideTable` entries lack `inheritFillStyleId`/`inheritTextStyleId`~~ **Retired (Round 6):** the "not exposed" premise was wrong — `getStyledTextSegments(["fillStyleId","textStyleId"])` returns the per-range bound style ids (probed; the typings' claim was false). The plugin now emits `inheritFillStyleId`/`inheritTextStyleId` on the table entry styling that range (absolute per range — the node-level default never carries them: 0 corpus nodes have inherit on `style`), registers the range-bound styles in the file `styles` map, and the bridge join renames marker → library node id at persist time (same join as `node.styles`, corpus 2/2 nodes: 10:955/10:956, 10:877/10:947). `hyperlink` is also an exposed segment field (null when unset) — no corpus hyperlinks, no mapping | ~~4~~ 0 residual (byte residue folds into #20's entry-key renumbering: G4 340→338 byte, envelope 1660→1658) | The E2 canonicalizer still scrubs inherit from the *semantic* model: REST never surfaces the **default** range's binding, so when the two sides pick different default ranges (#20 typing style) the canonical bases cannot agree on inherit values — the comparison would measure the base-choice deviation, not the bindings. Byte parity tracks the fields fully. |
| 22 | `letterSpacing` PERCENT converted to px (`fontSize × value ÷ 100`) | — | REST exposes a plain px number; the plugin API has percent units. |

## Paints / effects

| # | Deviation | Rationale |
|---|---|---|
| 23 | image `scaleMode` `CROP` → `STRETCH` | Same Figma UI mode, different names in plugin vs REST API. |
| 24 | gradient `gradientHandlePositions` derived from `gradientTransform` | The plugin exposes the 2×3 matrix; REST exposes three handles (translation, x-end, y-end). Validated by golden diff. |
| 25 | `NOISE`/`TEXTURE`/unknown effect types pass through with `type` + `visible` + known fields | Nothing silently dropped. |

## Transport

| # | Deviation | Rationale |
|---|---|---|
| 26 | Authorization headers accepted but never validated | Loopback-only bridge; rejecting SDK bearer tokens breaks drop-in use. |
| 27 | No rate limits, no pagination, no `error` i18n payloads | That's the point — this is a local, single-user service. |
| 28 | Long-polling transport (plugin ⇄ bridge), not the REST socket model | The plugin sandbox can only poll; irrelevant to REST clients. |

## Extensions beyond REST (supersets, clearly namespaced)

- `_figmaAgent.svgBase64` on shape nodes (REST cannot export SVG in file payloads).
- `_figmaAgent.extractedAt` per frame (extraction timestamp).

## Envelope & wrapper (Round 0)

| # | Deviation | Rationale |
|---|---|---|
| 29 | Canvas `prototypeDevice` always `{ type: "NONE", rotation: "NONE" }` | The plugin cannot read prototype/device settings. The corpus's first page actually carries an iPhone preset — an honest 1-path residue. |
| 30 | Canvas `prototypeBackgrounds` omitted | Unreadable from the plugin; optional per spec. |
| 31 | `thumbnailUrl` = `""` on file/nodes responses; `img_url` = `""` on `/v1/me` | No local thumbnail/avatar source exists. |
| 32 | `linkAccess` always `"inherit"` | No server-side access model; REST's default value. |
| 33 | ~~`/v1/files/:key/nodes` wrapper fields (`name`, `role`, `editorType`, `version`, `thumbnailUrl`, `err`) … pending one live measurement~~ **Resolved (Round 6, live-measured 2026-10-17):** one real `/nodes` response settles the shape — wrapper = `name`, `role`, `lastModified`, `editorType`, `version`, `thumbnailUrl`, `linkAccess`; entries = `componentSets`, `components`, `document`, `schemaVersion`, `styles` (no entry-level `name` — our spec-derived removal was correct). Actions taken from the measurement: dropped our non-spec `err: null` from success wrappers (`err` belongs to error payloads and `/images`), added `linkAccess: "inherit"` (plugin-invisible; the file-envelope constant, same rationale as `buildFileEnvelope`). Wrapper scalar *values* (name/version/thumbnailUrl/lastModified) remain local-file stand-ins — the local file has no real key, thumbnail or version. |
| 34 | `?depth=N` on `/v1/files/:key` counts from the DOCUMENT root (pages = 1, top-level objects = 2); depth ≤ 1 returns pages only | Matches the OpenAPI `depth` parameter semantics (fixed an off-by-two). The `/nodes` endpoint counts from the requested node — as before. |

## Normalization policy (harness)

| # | Deviation | Rationale |
|---|---|---|
| 35 | The golden-diff normalizer strips `componentPropertyDefinitions` | Volatile across publish cycles; component-property parity is therefore **not asserted** by "identical" verdicts. |
| 36 | `characterStyleOverrides` arrays are re-padded to the character count with 0s before diffing | REST trims trailing zeros; "characters beyond the array's length use the default style", so padding is semantics-preserving and array length never diffs by itself. |

## Instance model (Round 1)

| # | Deviation | Rationale |
|---|---|---|
| 37 | INSTANCE `overrides` are emitted by **live-diffing each instance against its main component**; REST reports Figma's **stored user-edit records**. Exact where the main hasn't drifted (local mains: 96/97 arrays match, 77/77 empty arrays match), but remote (library) mains drift after insertion — renamed mains fire false `name`, edited/updated mains leave stale subtree ids that break correspondence (missing entries), and overrides absorbed by library updates disappear (REST fires, live values now match). Remote-main arrays match 1/49. | The plugin API exposes no override records; a live diff is the only derivable semantics. Suppression rules were measured and rejected: REST genuinely fires `name` (×16) and self `width`/`height` (×33) on remote-main instances, so remote-only suppression loses more true positives than it removes noise. |
| 38 | `fillOverrideTable` is never emitted | The emission rule is underivable: all 130 corpus values are `{"1": null}` (5 vectors have 3 slots); presence is uncorrelated with `vectorNetwork` regions (53 with-table vectors report 0 regions, 21 without-table report 1), segment/vertex counts, fills, strokes, or any REST-visible feature (probed all 130 + 40 controls). Same discipline as `layoutVersion` (F1): no rule without a ≥99% corpus fit. ~130 paths of residue. |

## Library style ids (Round 4)

| # | Deviation | Rationale |
|---|---|---|
| 39 | Local style ids: current Figma reports **every local style** to plugins as `"S:<40-hex key>,"` — an **empty node-id suffix** (probe-verified via the `?styles=1` probe on two files, sync + async getters, legacy and dynamic-page document access). REST keys the file-level `styles` map by real node ids (e.g. `67:659`). Node *StyleId properties still return real markers, so bound styles are unaffected — only the enumeration. | The plugin API cannot see local style node ids, period. The enumeration keys placeholder-suffix entries by their full id (no collapse); the rest-bootstrap join (#10) re-keys them to REST's ids at persist time. Without a bootstrap table, a file's local styles appear under `S:<key>,` placeholder keys — a visible, self-describing degradation. |
| 40 | Bridge `styleType` vocabulary: plugin `BaseStyle.type` says `PAINT` where REST style metadata says `FILL` (TEXT/EFFECT/GRID agree) | Mapped via `restStyleType` in the plugin (Round 4). |

## Text metrics (Round 2)

Deviations #13, #17, #18 and #19 are retired by one bridge-side rewriter
(`lib/font-metrics.ts`, applied at persist time). REST computes these fields
from real font metrics the plugin API does not expose; all three are pure
per-family functions of the emitted style, corpus-fitted into
`store/font-metrics.json` (gitignored — corpus-derived data) by
`tools/build-font-metrics.ts`:

| Field | Rule (corpus-validated) | Samples |
|---|---|---|
| INTRINSIC `lineHeightPx` | per-family multiplier × fontSize | 906 / 4 families, ≤1e-6 error |
| PIXELS `lineHeightPercent` | lineHeightPx ÷ (multiplier × fontSize) × 100 | 146, exact |
| `fontPostScriptName` | `Family-Style` (spaces stripped), but only for combos REST names — null for Inter except Inter/Medium; on `styleOverrideTable` entries present exactly when `fontFamily` is in the delta (34/34) | 1046 |

Notes:

- The multiplier is **family-level**, not family+style — Inter is
  1.21022725 for Regular/Semi Bold/Bold/Extra Bold alike.
- REST emits **raw float64 doubles** (e.g. `36.30681610107422`), not
  rounded values; byte parity is measured after the golden-diff normalizer
  rounds to 4 decimals, so any fit within 1e-5 is exact there.
- **R7.1 — the exact emission model, verified 16/16 on golden:** REST
  computes `lineHeightPx = float32(fontSize × float32(m_true))` where
  `m_true = (ascender + descender + lineGap) / unitsPerEm` is a rational
  with denominator ≤ 16384 (Inter = 3408/2816 → 213/176, SF Pro Text =
  2444/2048). Corpus "fit" multipliers are double-precision
  approximations of `float32(m_true)` — at most 1 ulp off.
- **R7.1 — `probe-fonts` (human-triggered) closes unseen families:** the
  plugin samples AUTO line heights at large font sizes (cap discovery up
  to 100000, two bands, ~600 samples/style) and the bridge snaps the
  multiplier window to the smallest-denominator rational that validates
  every sample one-sidedly (`e = linePx − m·size ∈ [−0.5, +1.5]` — Figma's
  layout box picks up strictly-upward +1 px anomalies at large sizes).
  When the window is narrower than `1/d̂²`, the snap is provably the true
  rational and the family is listed in `exactRationalFamilies`; the
  rewriter then emits `Math.fround(size × Math.fround(m))` —
  **bit-identical to REST** (acceptance: Inter probe → exactly 213/176,
  10/10 golden REST values reproduced bit-exactly; Space Grotesk probe →
  exactly 1276/1000, a never-seen family, 150/150 text nodes in the
  second-file pull bit-exact). Corpus (fit) entries keep the plain double
  product — fround-ing them could break existing 1e-6-parity.
- The plugin output is untouched: the rewriter runs at persist time only,
  so unknown fonts (absent from the table) keep the plugin's estimate or
  omission — the fallback behavior of the retired deviations (now the
  documented degradation mode, see "Degradation modes" below).
- **G2 residue = 12 paths, none font metrics.** Frame `180:304` (8) is the
  #20 base-vs-SOT swap (REST picked the INTRINSIC segment as the node's
  base style; we pick `segments[0]`). Frame `180:338` (4) is REST emitting
  a *stored* SOT entry whose values equal the base — invisible to a live
  diff (the #37 stored-record ceiling, SOT variant). Both belong to
  Round 3's base-style model, not to font metrics.

## Text model semantics (Round 3)

The base-style question (deviation #20) is settled as **stored typing
style** — the fourth manifestation of the stored-record ceiling (#37):
REST `overrides`, redundant `styleOverrideTable` entries, stored node-level
`fills` literals, and now the text base style + per-range records that
carry node-level fields (`textAutoResize`) with range-specific values.

**E2 semantic canonicalization** (`tools/normalize.ts` —
`canonicalizeTextModel`/`semanticize`): both encodings are re-encoded
identically — resolve each character's full style (base ⊕ node fills ⊕
slot delta), drop plugin-invisible fields (`inherit*StyleId`, #21), drop
lineHeight fields not applicable to the unit (the delta model leaks a
phantom `lineHeightPercentFontSize` onto INTRINSIC segments), keep
`textAutoResize` at node level, then re-encode with base = resolved char-0
style and slots numbered by first appearance. Unreferenced table entries
(stored records no character uses) carry no rendered information and
vanish. `golden-diff.ts` reports **byte parity and semantic parity** as
separate numbers; the scorecard table shows both per root cause.

**G2/G4 semantic residue after E2: 2 paths** (G2 12 → 0; G4 340 → 13 → **2** after the Round 6 corpus refresh — the 11 exportSettings were fixture staleness, confirmed live and closed):

- 11 `exportSettings` paths on node-mode fixture roots — **closed (Round 6):** confirmed corpus staleness, not a deviation. The reference file was edited after the fixture fetch (version `2410344…` → `2411068…`, Oct-16 edit) and that edit added export settings to 11 top-level frames. The API window (2026-10-17) allowed one real `/nodes` re-fetch before a 429 (stopped per §9.2); the remaining 10 fixtures were assembled from the same-epoch full-file response — document subtrees verbatim from REST, wrapper replicated from the real `/nodes` response, entry maps sliced referenced-only (not compared by the harness). Corpus refreshed: the 11 paths closed on both sides; ours was already emitting the probe-verified full default setting (`PNG`, `SCALE 1`, empty suffix). The file-envelope fixture was refreshed from the same live fetch.
- 2 instance-`overrides` id shifts (frame 237:221): remote-main drift, the #37 family.


## Library style ids (Round 4 — resolved via rest-bootstrap)

Deviation #10 closed by the rest-bootstrap join; **G1 649 → 6 paths**, the
unresolved report is empty, and the file envelope's `styles` map is
byte-identical to REST (42/42 entries).

- **Join:** the 40-hex publish `key` is identical from both sides. A REST
  file envelope's `styles` map is itself the complete key→nodeId table
  (map key = library node id, field key = publish key). One cached call per
  file — `store/libraries/bootstrap_<realKey>.json`, mined by
  `tools/bootstrap-library-styles.ts` from a saved envelope, or fetched
  live by the bridge on fresh pull (token + `store/file-key-aliases.json`
  alias; skipped on 429/offline; same one-time-bootstrap philosophy as
  `store/font-metrics.json`). Frames are rewritten at persist time
  (`lib/library-harvest.ts`, after the font-metrics rewriter): `styles`
  map entries re-key to the join-table node id — remote **and** local —
  `node.styles` binding values follow, consumer-side metadata is kept
  (REST reads the same cached copy).
- **Plugin harvest (fallback, now known-limited):** running the plugin
  inside a library file and pulling `page-index` persists
  `store/libraries/<fileKey>.json`. Probe-verified limitation (#39):
  current Figma reports local styles with **empty id markers**, so a
  harvest cannot actually see node ids — the rest-bootstrap is the
  reliable path. Guards skip placeholder ids at write **and** load time
  (a poisoned-index incident during development hardened both).
- **Unresolved report:** `store/<fileKey>/unresolved-library-styles.json`
  (key, name, usedBy node ids) rebuilds on every frame save — the
  operator to-do list of libraries still needing a bootstrap.
- **The "1 local style" mystery** was an enumeration collapse bug, not
  file history: all local styles keyed the map under `""`, the last one
  winning. Fixed (full-id keying); DevBoard's 19 local styles reappeared
  and all joined to their REST ids (`67:659` etc.).
- **Residue — 6 paths (D4): CLOSED (Round 5).** One prototype transition
  (`transitionDuration`/`Easing`/`NodeID` → `10:1098`, a library-side
  frame) on frame 180:324; deviation #16. Closed by: plugin derives
  `transitionNodeID` from the first NODE action's `destinationId`
  (probe-verified: the plugin reports the library node id directly,
  cross-file included — no join needed); `transitionDuration`/
  `transitionEasing` are server-side state (probed: legacy reads and
  `action.transition` all null) injected by the bridge from the
  rest-bootstrap **transition table** (`bootstrapTransitionsFromDocument`,
  per-file — node ids are file-scoped, never merged globally).

## Degradation modes (Round 7)

RAFAP is honest about what it cannot see; every capability that depends on
data the plugin API does not expose degrades along an explicit ladder.
These are **contracts, pinned by tests** (`tests/font-metrics.test.ts`,
"degradation ladder"; `tests/library-harvest.test.ts`, unresolved markers).

**INTRINSIC `lineHeightPx`** (per family):

1. **Probe-snapped (exact rational)** — `exactRationalFamilies` entry:
   bit-exact float32 emulation of REST (`fround(size × fround(m))`).
2. **Corpus (fit) multiplier** — plain double product, ≤1 ulp of REST's
   float32 result (byte parity at the normalizer's 4-decimal rounding).
3. **Unseen, unprobed family** — the plugin's best-effort estimate passes
   through: `rendered height ÷ line count` for auto-height texts (exact for
   single-line texts — Figma's own layout produced it — wrong for wrapped
   multi-line texts, where the plugin can only count explicit newlines),
   and **omitted** for fixed-height texts (deviation #19's residual).

Run `probe-fonts` (see README) to move a family from tier 3 to tier 1.

**`fontPostScriptName`** (per family × style): the plugin API exposes no
PostScript names, so the corpus table is the only source. Probed families
(R7.4 measurement: Space Grotesk) get exact `lineHeightPx` but REST's PS
names (`SpaceGrotesk-Medium`, …) stay `null` — REST's own naming is not
derivable (the corpus has Inter emitting `null` for Inter/Regular but a
name for Inter/Medium), so guessing would be a coin flip.

**Remote (library) style ids** (per file):

1. **Rest-bootstrapped** (token + alias, one cached 429-safe REST call):
   byte-identical library node ids.
2. **Token-free / no alias:** ids stay local markers — the 40-hex publish
   `key` still matches REST exactly, so bindings ↔ styles remain
   correlatable, just not byte-identical. The unresolved report
   (`store/<fileKey>/unresolved-library-styles.json`) lists what is
   missing.

The token-free "open the library file and harvest" alternative is **not an
open option** — Round 4 probe-verified current Figma reports local styles
with empty-id markers in every file, via every accessor.

**No font-metrics store at all:** rewriting is disabled; everything is
tier 3. A malformed store parses to null (never garbage) and is ignored.

## Token stance (Round 7 — decision record)

RAFAP is **token-free by default**: pull, all parity work, and every tool
except the style-id bootstrap work with zero credentials. An optional
`FIGMA_TOKEN` (or `~/.figma-token`) upgrades remote style ids to
byte-exact library node ids via one cached, 429-safe REST call per file
(never retried on 429 — §9.2 discipline). This is a **decision, not a
TODO**: the token-free alternative was probe-verified impossible (empty
id markers, above), so the trade-off is final unless Figma changes the
plugin API.

## Second-file acceptance (Round 7 — R7.4)

The round's gate: a never-seen file (the Positivus community template,
3,593 nodes / 35 frames / 3 pages, Space Grotesk + remote styles) pulled
and diffed against one full-file REST snapshot. Result: **every residue
path maps to a known class** — no new systemic class. Per-file parity:
95.4% byte / 96.5% semantic at the normalizer's rounding (lower than the
corpus's 98.901/99.234 because the file is far heavier in instances, the
G5 stored-record class). Findings, in the order they surfaced:

- **Stale library index (fixed):** a rest-bootstrap written after bridge
  startup (hand-seeded, or by an earlier run) was invisible to the
  in-memory join index — remote style ids stayed `S:` markers.
  `refreshLibraryIndexIfStale()` now reloads the index (and clears the
  per-file transition tables) whenever a harvest/bootstrap file newer
  than the index appears. After the fix: 0 unresolved markers, G1
  dropped 375 → 13 paths.
- **Harness phantom diffs (fixed):** `normalize()` maps empty objects to
  undefined (`{} ≡ absent`), so a key like `styleOverrideTable` present
  as `{}` on BOTH sides compared as missing-in-rest. `diffTrees` now
  reports a side as missing only when the other side has a value.
  (Corpus scorecard unchanged — the corpus had no both-empty cases;
  the second file lost 233 phantom paths.)
- **Zero-valued image filter keys (fixed, plugin 3.7.0):** REST omits
  zero-valued keys inside `fills[].filters` (measured 6/6 on adjusted
  image fills: `{saturation: -1}` alone, never `{saturation: -1,
  contrast: 0, …}`). The plugin had the keep-if-any-nonzero rule but
  emitted all seven keys; it now drops zero-valued entries.
- **Inherited lineHeight on mixed-size ranges (fixed):** REST
  `styleOverrideTable` entries that inherit the base's INTRINSIC line
  height but carry their own fontSize materialize the full group
  (unit + percent + px = range size × multiplier) — measured on the
  team-card texts (base 18px "p", name range 20px "h4"). The plugin
  cannot see server-side font metrics, so the bridge's rewriter adds
  the group at persist time. Corpus shape (same-size ranges) confirmed
  the negative case: no lineHeight keys when px is equal.
- **Base-style choice is stored edit history (documented):** REST's
  node-level `style` on mixed-style texts picks a base range that
  follows the document's edit history, not a live-derivable rule —
  measured across both files: REST base == LAST segment's identity in
  8/9 identity-mixed nodes, == FIRST in others (the corpus's
  "Didn't get your code? Send a new Code" is first-based; "Didn't
  receive any code? Send again" and Positivus's team cards are
  last-based). 89% < the 99% rule bar → unfixable from live data; the
  semantic layer's per-character canonicalization (re-basing on
  char 0) already absorbs it for everything except the lineHeight
  group above, which is now emitted exactly.
- **New known omissions (documented):** `strokeMiterAngle` (REST-only,
  15 paths — server-derived miter geometry, absent from the plugin
  API; not present in the corpus) and `inheritFillStyleId`/
  `inheritTextStyleId` gaps on style-bound SOT entries (26 paths —
  partially covered since Round 6; the second file's style-bound
  ranges expose the uncovered shapes).

## Closed questions (experiments recorded)

- **REST's text base style is the stored typing style (Round 3, E1).** All 10 multi-segment corpus texts examined: REST's slot 0 is used by no character on 4 nodes (a Semi Bold typing style — set with the cursor placed, never typed — every character keeps its own record; no `textStyleId` binding on those nodes), equals `segments[0]` on 3, and equals another live segment on 3 (the separator space on two, the style-bound segment on one). Candidate rules (first/last/longest/last-character/textStyleId-binding) score at best 3/10 — no rule reaches the bar, and the winning interpretation (cursor style) is editor state the plugin API cannot see. Closed as underivable; documented in deviation #20, measured by E2.
- **`layoutVersion` (deviation #7) is genuinely edit-history.** Corpus mine (`tools/rule-learn.ts layoutVersion`, 492 nodes): 440×5, 51×3, 1×4. The 3s cluster in 4 frames on page 2 — but those same frames also carry 5s, and the value is TEXT-only there while other TEXTs are 5. No type/frame/depth rule reaches the ≥99% bar (best: constant 5 at 89.4%). Not emitted; documented as fundamental.
- **REST `overrides` are stored records, not live diffs (Round 1).** Decisive evidence: instance `180:310` is 327×48 against a 295×71 main, yet REST reports **no** size override (the library resized the component after insertion; the instance keeps its insertion-era size); nested instance `I180:310;143:1324` carries main-relative ids from an older main version while the live main's subtree uses new ids (`143:…` vs `10:9xx` eras). Both are invisible to the plugin API — see deviation #37.
- **`fillOverrideTable` is not vector-network region slots (Round 1).** Hypothesis tested with a live probe of all 130 table-carrying vectors plus 40 controls: `vectorNetwork.regions > 0` misclassifies 74 of 170 (53 false negatives, 21 false positives), and the 5 three-slot vectors report exactly 2 regions. See deviation #38.
