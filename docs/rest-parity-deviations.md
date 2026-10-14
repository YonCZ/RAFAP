# REST parity deviations

Every intentional difference between Figma Agent's `/v1/*` output and
api.figma.com, with rationale (agent.md §13 Step 7). The golden diff
(`npm run golden-diff`) is the enforcement mechanism — items here should
match its report classifications. Anything NOT in this list that shows up
in a golden diff is a **BUG**.

## Structural

| # | Deviation | Rationale |
|---|---|---|
| 0 | The `:key` is a **locally derived file key** (`local-<hash of page ids>`), not the real Figma file key | `figma.fileKey` requires `enablePrivatePluginApi` — private organization plugins only. Local keys are stable per file and unique across files. Discover the current key via a `page-index` pull or `GET /api/page-index`. |
| 1 | `name` is `"Figma Agent Local File"` | The plugin API cannot read the file's title (no such access). Agents can identify files by the real file key. |
| 2 | `lastModified` = max `_figmaAgent.extractedAt` of stored frames | No server; we timestamp at extraction time. |
| 3 | `version` = `local-<fileKey>` | No server-side version hashes. |
| 4 | `components`/`componentSets` maps keyed by node id, with `key` = node id, `documentationLinks: []`, `remote: false` | Publish keys don't exist for unpublished/local components. The shape matches; the key namespace is node ids. |
| 5 | error responses are `{ status, error: true, message }` | Simplified from REST's i18n-shaped errors. Clients check `status`/`error` fields, which match. |
| 6 | `/v1/files/:key/components` and `/styles` return best-effort `meta.components`/`meta.styles` from stored frames | REST's published-component endpoints hit team libraries we cannot see locally. |

## Per-node

| # | Deviation | Rationale |
|---|---|---|
| 7 | `rotation`, `absoluteRenderBounds`, SVG markup live under `_figmaAgent` | REST only exposes these via `geometry=paths` (and cannot do SVG at all). Keeping the REST surface clean makes the golden diff trivial. |
| 8 | `relativeTransform` not emitted | REST only emits it with `geometry=paths`; we don't support that query yet. |
| 9 | `strokeWeight` is `"figma::mixed"` + `individualStrokeWeights: {top,right,bottom,left}` when per-side | REST's own convention for mixed values; exact pairing to be confirmed by golden diff. |
| 10 | `blendMode` omitted when `NORMAL`, `opacity` omitted when `1` | Matches REST's omission behaviour (Rule B2). |
| 11 | `visible` always emitted on the invariant core | REST marks it optional; we emit it for structure stability. Golden diff will tell if REST omits it when true — then we adjust. |
| 12 | `absoluteBoundingBox` values are raw floats (not rounded) | REST emits floats; the normalizer rounds to 4 decimals for comparison. |
| 13 | Prototype fields (`reactions`, `transitionDuration`, …) not yet extracted | Planned for a later pass; reads don't need them for layout parity. |

## Text

| # | Deviation | Rationale |
|---|---|---|
| 14 | `styleOverrideTable` entries are **deltas** against the default `style` (partial TypeStyles) | REST emits partial TypeStyle objects; we emit only differing keys. Semantically equivalent for consumers. Golden diff settles the exact field set. |
| 15 | `lineHeight` AUTO → `lineHeightUnit: "INTRINSIC_%"`, `lineHeightPercent: 100` | REST's representation of "auto" line height. |
| 16 | `letterSpacing` PERCENT → px (`fontSize * value / 100`) | REST exposes a plain px number; the plugin API has percent units. |
| 17 | `fontPostScriptName` composed as `<family><style>` (spaces stripped) | The plugin API doesn't expose the real PostScript name; this matches the common naming. |

## Paints / effects

| # | Deviation | Rationale |
|---|---|---|
| 18 | image `scaleMode` `CROP` → `STRETCH` | Same Figma UI mode, different names in plugin vs REST API. |
| 19 | gradient `gradientHandlePositions` derived from `gradientTransform` | The plugin API exposes the 2×3 matrix; REST exposes three handles. handle0 = translation, handle1 = x-direction end, handle2 = y-direction end. Golden diff validates. |
| 20 | `NOISE`/`TEXTURE`/unknown effect types pass through with `type` + `visible` + known fields | Nothing silently dropped (Rule B4). |

## Transport

| # | Deviation | Rationale |
|---|---|---|
| 21 | Authorization headers accepted but never validated | Loopback-only bridge; rejecting SDK bearer tokens breaks drop-in use. |
| 22 | No rate limits at all | That's the point. |
