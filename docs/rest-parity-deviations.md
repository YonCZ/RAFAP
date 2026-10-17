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
| 7 | `layoutVersion` never emitted | ~492 paths | The plugin API exposes no layout version counter. Purely informational in REST. |
| 8 | Instance `overrides` arrays not emitted | ~146 | The plugin has no override table for instance children. |
| 9 | `fillOverrideTable` not emitted | ~130 | Not exposed by the plugin API. |
| 10 | ~~**Remote style ids**: for library (remote) styles, `node.styles` values and `styles` map keys use the local marker suffix (e.g. `209:80`) instead of the library file's node id (e.g. `10:875`)~~ **Retired (Round 4):** rest-bootstrap join re-keys both to the library node id at persist time | ~~649~~ 6 | The plugin cannot see ids inside the defining library file — but a REST file envelope's `styles` map **is** the key→nodeId join table. One cached call per file (or a saved envelope fixture) mines it; frames are rewritten on persist (`lib/library-harvest.ts`). The bridge auto-bootstraps on fresh pull when the token + `store/file-key-aliases.json` are present (429/offline-safe). Residue: D4 prototype transitions (see *Library style ids* below). |
| 11 | Inherited properties on instance children omitted — style bindings (plugin returns `""`) and `SCALE`/`SCALE` constraints (plugin returns the MIXED sentinel) | 3 nodes + 26 paths | Would require resolving the main component's corresponding child node (the `;`-suffix in instance child ids encodes the original node id). Future work. |
| 12 | `scrollBehavior` always `"SCROLLS"`; `isFixed` never emitted | 3 nodes | The plugin API has no pinned-frame detection. |
| 13 | ~~`fontPostScriptName` always `null`~~ **Retired (Round 2):** bridge-side corpus table emits the 5 (family, style) combos REST names | ~~38~~ 0 | The rule is `Family-Style` (spaces stripped), but REST only has server-side names for some combos — Inter is null except `Inter/Medium` in the corpus. Presence is tabulated in `store/font-metrics.json` (build: `tools/build-font-metrics.ts`), not derived. On `styleOverrideTable` entries REST emits it (name or null) exactly when `fontFamily` is in the delta (34/34 corpus entries). |
| 14 | `rotation` omitted when `0` — REST emits `rotation: 0` on nodes that once had rotation (history) | 4 nodes | The plugin cannot distinguish "never rotated" from "rotated back to 0". |
| 15 | Zeroed `rectangleCornerRadii: [0,0,0,0]` + `cornerSmoothing: 0` not emitted for nodes with radius *history* but zero radius (6 VECTOR + 1 GROUP) | 7 nodes / 14 paths | History is not visible. `VectorNode` exposes **no** corner properties in the plugin API (`cornerRadius`/`cornerSmoothing` are undefined at runtime), so even the mask heuristic cannot fire for vectors; GROUP radius history is likewise invisible. |
| 16 | Frame-level `transitionDuration`/`transitionEasing`/`transitionNodeID` not derived from `NODE` actions | 1 node | REST derives these from a remote (library) destination frame the plugin cannot read. `interactions` themselves match REST exactly. |

## Text

| # | Deviation | Impact | Rationale |
|---|---|---|---|
| 17 | ~~Intrinsic `lineHeightPx` is an **estimate**~~ **Retired (Round 2):** rewritten from a corpus-fitted per-family multiplier table | ~~435~~ 0 | `lineHeightPx` for AUTO heights is a pure per-family multiplier × fontSize (906 samples, 4 families, worst-case fit error ~1e-6). The bridge rewrites it at persist time (`lib/font-metrics.ts`, table in gitignored `store/font-metrics.json`). REST emits raw float64 doubles; the golden-diff normalizer rounds to 4 decimals, so a <1e-5 fit is byte-exact after normalization. |
| 18 | ~~`lineHeightPercent` not emitted for `PIXELS`-unit texts~~ **Retired (Round 2):** computed as px ÷ intrinsic × 100 | ~~73~~ 0 | Validated exactly on 146 corpus samples using the multiplier table from #17. Emitted bridge-side at persist time. |
| 19 | ~~Fixed-height intrinsic texts emit no `lineHeightPx`~~ **Retired (Round 2):** the multiplier table makes it derivable | ~~20~~ 0 | Line height is a property of the style, not the box; REST always emits `lineHeightPx` for INTRINSIC regardless of auto-resize, and the rewriter now does too. |
| 20 | Default-style baseline (Round 3, evidence-complete): REST's node base style is the **stored typing style** — the editor's cursor/insertion style — not necessarily any live segment. Measured on all 10 multi-segment corpus texts: 3 match `segments[0]` (our choice), 3 match another segment (the separator space in two nodes, the style-bound "Register now" segment in one), and 4 match **no live segment** (a Semi Bold typing style set with the cursor placed but never typed — every character keeps its own record). Per-range records can also carry node-level fields (`textAutoResize`) with values differing from the node. | ~310 byte paths, **0 semantic** | The typing style is pure editor state — invisible to the plugin API. Both encodings reconstruct identical per-character styles, which the harness proves: the E2 semantic canonicalization (Round 3) re-encodes both sides with base = resolved char-0 style and diffs that (G4: 340 byte → 13 semantic paths, of which 11 are suspected fixture staleness — see below — and 2 are #37-family override ids). |
| 21 | `styleOverrideTable` entries lack `inheritFillStyleId`/`inheritTextStyleId` | 4 paths | Per-range style ids are not exposed via `getStyledTextSegments`. Excluded from the semantic-parity measure (dropped by the E2 canonicalizer) — the byte diff still tracks them. |
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
| 33 | `/v1/files/:key/nodes` wrapper fields (`name`, `role`, `editorType`, `version`, `thumbnailUrl`, `err`) and the removal of entry-level `name` are **spec-derived** (0.44.0), pending one live measurement | The cached per-frame fixtures were extracted from the whole-file snapshot, not real `/nodes` responses; a rate-limited attempt (429) prevented verification. One API call settles it when the window resets. |
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
- The plugin output is untouched: the rewriter runs at persist time only,
  so unknown fonts (absent from the table) keep the plugin's estimate or
  omission — the fallback behavior of the retired deviations.
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

**G2/G4 semantic residue after E2: 15 paths** (G2 12 → 0, G4 340 → 13):

- 11 `exportSettings` paths on node-mode fixture roots: the live plugin
  reports a full default export setting (`PNG`, `SCALE 1`, empty suffix —
  probe-verified byte-identical to nodes where REST serializes it) while
  the Oct-15 fixtures lack it, **including in the file-envelope fixture**.
  Suspected corpus staleness (the reference file was edited after the
  fixtures were fetched — the plugin session re-pulled everything Oct 17).
  Verify at the next API window with a live re-fetch; if confirmed, refresh
  the whole golden corpus. The probe now carries `rawExportSettings`.
- 2 instance-`overrides` id shifts (frame 237:221): remote-main drift, the
  #37 family.

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
- **Residue — 6 paths (D4):** one prototype transition
  (`transitionDuration`/`Easing`/`NodeID` → `10:1098`, a library-side
  frame) on frame 180:324; deviation #16. Optional closure: a node-level
  transition LUT mined from the same rest-bootstrap envelope.

## Closed questions (experiments recorded)

- **REST's text base style is the stored typing style (Round 3, E1).** All 10 multi-segment corpus texts examined: REST's slot 0 is used by no character on 4 nodes (a Semi Bold typing style — set with the cursor placed, never typed — every character keeps its own record; no `textStyleId` binding on those nodes), equals `segments[0]` on 3, and equals another live segment on 3 (the separator space on two, the style-bound segment on one). Candidate rules (first/last/longest/last-character/textStyleId-binding) score at best 3/10 — no rule reaches the bar, and the winning interpretation (cursor style) is editor state the plugin API cannot see. Closed as underivable; documented in deviation #20, measured by E2.
- **`layoutVersion` (deviation #7) is genuinely edit-history.** Corpus mine (`tools/rule-learn.ts layoutVersion`, 492 nodes): 440×5, 51×3, 1×4. The 3s cluster in 4 frames on page 2 — but those same frames also carry 5s, and the value is TEXT-only there while other TEXTs are 5. No type/frame/depth rule reaches the ≥99% bar (best: constant 5 at 89.4%). Not emitted; documented as fundamental.
- **REST `overrides` are stored records, not live diffs (Round 1).** Decisive evidence: instance `180:310` is 327×48 against a 295×71 main, yet REST reports **no** size override (the library resized the component after insertion; the instance keeps its insertion-era size); nested instance `I180:310;143:1324` carries main-relative ids from an older main version while the live main's subtree uses new ids (`143:…` vs `10:9xx` eras). Both are invisible to the plugin API — see deviation #37.
- **`fillOverrideTable` is not vector-network region slots (Round 1).** Hypothesis tested with a live probe of all 130 table-carrying vectors plus 40 controls: `vectorNetwork.regions > 0` misclassifies 74 of 170 (53 false negatives, 21 false positives), and the 5 three-slot vectors report exactly 2 regions. See deviation #38.
