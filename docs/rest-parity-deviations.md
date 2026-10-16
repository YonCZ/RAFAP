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
| 10 | **Remote style ids**: for library (remote) styles, `node.styles` values and `styles` map keys use the local marker suffix (e.g. `209:80`) instead of the library file's node id (e.g. `10:875`) | ~590 | The plugin cannot see ids inside the defining library file. The `key` field (40-hex hash) in the styles metadata **does match REST exactly**, so consumers can correlate bindings ↔ styles by key. Local styles are byte-exact. |
| 11 | Inherited properties on instance children omitted — style bindings (plugin returns `""`) and `SCALE`/`SCALE` constraints (plugin returns the MIXED sentinel) | 3 nodes + 26 paths | Would require resolving the main component's corresponding child node (the `;`-suffix in instance child ids encodes the original node id). Future work. |
| 12 | `scrollBehavior` always `"SCROLLS"`; `isFixed` never emitted | 3 nodes | The plugin API has no pinned-frame detection. |
| 13 | `fontPostScriptName` always `null` | ~38 | The plugin cannot produce real PostScript names (e.g. `SFProText-Semibold`). |
| 14 | `rotation` omitted when `0` — REST emits `rotation: 0` on nodes that once had rotation (history) | 4 nodes | The plugin cannot distinguish "never rotated" from "rotated back to 0". |
| 15 | Zeroed `rectangleCornerRadii: [0,0,0,0]` + `cornerSmoothing: 0` not emitted for nodes with radius *history* but zero radius (6 VECTOR + 1 GROUP) | 7 nodes / 14 paths | History is not visible. `VectorNode` exposes **no** corner properties in the plugin API (`cornerRadius`/`cornerSmoothing` are undefined at runtime), so even the mask heuristic cannot fire for vectors; GROUP radius history is likewise invisible. |
| 16 | Frame-level `transitionDuration`/`transitionEasing`/`transitionNodeID` not derived from `NODE` actions | 1 node | REST derives these from a remote (library) destination frame the plugin cannot read. `interactions` themselves match REST exactly. |

## Text

| # | Deviation | Impact | Rationale |
|---|---|---|---|
| 17 | Intrinsic `lineHeightPx` is an **estimate** (`node height ÷ line count`, rounded) | ~435 | REST computes it from font metrics (e.g. `17.9004` vs our `18`). The plugin exposes neither the metrics nor the resolved value. Functionally equivalent within a fraction of a pixel. |
| 18 | `lineHeightPercent` not emitted for `PIXELS`-unit texts | ~73 | REST emits a derived percent alongside the px value; the plugin has only the px value. |
| 19 | Fixed-height intrinsic texts emit no `lineHeightPx` | ~20 | The height ÷ lines estimate is wrong for fixed-height boxes, so we omit rather than lie. |
| 20 | Default-style baseline: REST stores a node **base style** plus per-range diffs, and the base sometimes matches *no* segment. We use `segments[0]` as the default and diff everything else against it. Also manifests in `fills`: mixed-fill texts get the default segment's paint as the node-level `fills` (matches REST on 7/8 measured nodes; on the eighth, REST's base is the *other* segment, so node-level `fills` and the override-table entry swap). | ~280 paths | The plugin exposes only resolved per-segment styles. The reconstruction is information-equivalent (every segment's full style is derivable both ways), but not byte-identical. |
| 21 | `styleOverrideTable` entries lack `inheritFillStyleId`/`inheritTextStyleId` | 2 entries | Per-range style ids are not exposed via `getStyledTextSegments`. |
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

## Closed questions (experiments recorded)

- **`layoutVersion` (deviation #7) is genuinely edit-history.** Corpus mine (`tools/rule-learn.ts layoutVersion`, 492 nodes): 440×5, 51×3, 1×4. The 3s cluster in 4 frames on page 2 — but those same frames also carry 5s, and the value is TEXT-only there while other TEXTs are 5. No type/frame/depth rule reaches the ≥99% bar (best: constant 5 at 89.4%). Not emitted; documented as fundamental.
- **REST `overrides` are stored records, not live diffs (Round 1).** Decisive evidence: instance `180:310` is 327×48 against a 295×71 main, yet REST reports **no** size override (the library resized the component after insertion; the instance keeps its insertion-era size); nested instance `I180:310;143:1324` carries main-relative ids from an older main version while the live main's subtree uses new ids (`143:…` vs `10:9xx` eras). Both are invisible to the plugin API — see deviation #37.
- **`fillOverrideTable` is not vector-network region slots (Round 1).** Hypothesis tested with a live probe of all 130 table-carrying vectors plus 40 controls: `vectorNetwork.regions > 0` misclassifies 74 of 170 (53 false negatives, 21 false positives), and the 5 three-slot vectors report exactly 2 regions. See deviation #38.
