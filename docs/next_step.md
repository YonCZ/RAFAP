# RAFAP — Next Steps: Findings & Solutions

**Audience:** the AI coding agent executing the next rounds.
**Read first:** `agent.md` (operating rules — port 3001 and `Agent Plugin/` are sacred; dev on 3002; plugin edits only via `figma-bridge/plugin/` + human-approved `npm run publish`), `docs/rest-parity-deviations.md` (the difference contract), `report.md` (the 2,354-path census).
**Spec references in this folder (authoritative — trust them over prose docs):**

| File | What it is |
|---|---|
| `.spec/api_types.ts` | TypeScript types generated from the official OpenAPI spec (`figma/rest-api-spec` v0.44.0) |
| `.spec/openapi.yaml` | The full OpenAPI specification — endpoints, query-param semantics, required fields, response shapes |

**Counting convention:** a "path" is one differing leaf value after normalization (`tools/normalize.ts`), document trees only. Current state: **2,354 paths, 5 root causes, 0 unclassified** (report.md §3).

**Expected outcome if all rounds land:** ~2,336 paths closed, ~18 documented as fundamental (rotation history 4, zeroed-radii history 14). Byte parity ≥ 99.2%, semantic parity ~100%.

---

## Summary of all findings

| ID | Finding | Group | Paths | Fixable | Round |
|---|---|---|---:|---|---|
| A1 | `pruneDepth` off-by-two on `/v1/files/:key` | harness | — | yes | 0 |
| A2 | Canvas/envelope level never golden-diffed; `prototypeDevice` missing | harness | unknown | yes | 0 |
| A3 | Error shape `{status,error,message}` ≠ REST `{status,err}` | harness | — | yes | 0 |
| A4 | `/v1/me` missing required `img_url` | harness | — | yes | 0 |
| A5 | Nodes-response wrapper parity (`thumbnailUrl`, entry `name`) | harness | — | verify | 0 |
| A6 | `normalize.ts` promises re-pad of `characterStyleOverrides`, doesn't do it | harness | — | yes | 0 |
| A7 | `componentPropertyDefinitions` silently stripped by normalizer | harness | — | document | 0 |
| B1 | Instance `overrides` arrays not emitted | G5 | 146 | yes | 1 |
| B2 | `fillOverrideTable` not emitted | G5 | 130 | yes | 1 |
| B3 | Inherited constraints (`MIXED`) + style bindings (`""`) on instance children | G5 | 26+3 | yes | 1 |
| C1 | Intrinsic `lineHeightPx` estimate (incl. ~20 fixed-height omissions) | G2 | ~455 | yes (table) | 2 |
| C2 | No font-metrics source for fonts outside corpus | G2 | — | yes (probe) | 2 |
| C3 | `lineHeightPercent`/`lineHeightUnit` gaps | G2 | 80 | yes (fit) | 2 |
| C4 | `fontPostScriptName` always null | G2 | 38 | yes (fit) | 2 |
| D1–D3 | Library (remote) style ids use local markers | G1 | 643 | yes (harvest) | 4 |
| D4 | Library-frame prototype transitions | G1 | 3 | maybe | 4 |
| E1 | Base-style selection (`segments[0]` vs REST's unknown base) | G4 | ~310 | fit or accept | 3 |
| E2 | No semantic-parity layer in the diff harness | G4 | 317 | yes | 3 |
| F1 | `layoutVersion` never emitted | G3 | 492 | mine → flag-gate | 5 |
| F2 | `isFixed`/`scrollBehavior: FIXED` | G3 | 6 | experiment | 5 |
| F3 | `rotation: 0` history, zeroed radii history | G3 | 18 | no — accept | 5 |
| G1 | `textStyleId`/`hyperlink` not requested from `getStyledTextSegments` | probe | 2+ | probe | 6 |
| H1–H9 | New spec-0.44.0 surfaces not mapped (GRID, min/max, PATTERN, progressive blur, …) | frontier | corpus-dependent | mine first | 6 |
| I1 | No generic corpus rule-learning harness | tooling | — | build | 0 |
| I2 | Report has no auto scorecard | tooling | — | build | 0 |

Priority logic (report.md §3): the top three mechanisms — library style ids (643), `layoutVersion` (492), `lineHeightPx` (455) — are **67% of the entire diff**; `layoutVersion` alone is 21%. But ordering below is by *solvability × harness trust*: Round 0 first so every later round is measured correctly.

---

## Round 0 — Harness & surface fixes (make all later rounds trustworthy)

> **STATUS: ✅ completed 2026-10-16.** All items (A1–A7, I1, I2) landed;
> `npm run check` green, 41/41 tests pass. Results:
> - A1 fixed (off-by-two + canvas pruning); unit-tested at depth 1/2/3.
> - A2 file mode shipped (`--mode file`); **first run surfaced a new gap**:
>   the components/componentSets map — REST emits real 40-hex publish
>   `key`s and `remote: true` for library components (and real keys for
>   local ones, e.g. `238:75` → `5be0efce…`). Plugin-side
>   `ComponentNode.key` should close most of it — fold into Round 4
>   (harvest) or do as a standalone.
> - A3 landed — empirically confirmed by a real 429
>   (`{"err": "Rate limit exceeded", "status": 429}`).
> - A4 landed (`img_url: ""`).
> - A5 **spec-derived, pending one measurement** — the verification call
>   was 429-rate-limited; wrapper + entry shape follow spec 0.44.0
>   (entries carry no `name`; top-level has name/role/editorType/
>   thumbnailUrl/version/err). One API call settles it when the window
>   resets.
> - A6 landed (re-pad implemented + tested).
> - A7 documented (deviations #29–#36).
> - I1 shipped (`tools/rule-learn.ts`); first probe **closed F1**:
>   layoutVersion is genuinely edit-history (440×5, 51×3, 1×4; best rule
>   89.4% < 99% bar) — deviation #7 final.
> - I2 shipped (`--mode scorecard`). Official numbers: **2,367 paths,
>   97.498% byte parity**, all classified into the 5 root causes, zero
>   residue (G1 649 / G2 573 / G3 516 / G4 327 / G5 302). Total moved
>   from 2,354 because the A6 re-pad turns array-length diffs into value
>   diffs.

### A1. Fix `pruneDepth` off-by-two on `/v1/files/:key`

**Finding.** `.spec/openapi.yaml` → `paths./v1/files/{file_key}.get.parameters.depth`: *"setting this to 1 returns only Pages, setting it to 2 returns Pages and all top level objects on each page."* Depth counts from the DOCUMENT root: pages = depth 1, top-level objects = depth 2, their children = depth 3. `buildFileEnvelope` (`lib/stitch.ts`) calls `pruneDepth(stored.document, opts.depth)` where `stored.document` is already a depth-2 frame — so `depth=2` still shows two extra levels, and canvases are never pruned at all.

Note the asymmetry: `.spec/openapi.yaml` → `paths./v1/files/{file_key}/nodes.get.parameters.depth` says depth on the **nodes** endpoint *"will be counted starting from the desired node"* — there `pruneDepth(f.document, depth)` in `buildNodesResponse` is **already correct**. Only the files route is wrong.

**Solution.**
1. In `buildFileEnvelope`: `const pruned = opts.depth !== undefined ? pruneDepth(stored.document, Math.max(0, opts.depth - 2)) : stored.document;`
2. Canvas level: when `opts.depth !== undefined && opts.depth <= 1`, emit each CANVAS with `children: []` (REST depth=1 returns pages only).
3. Add unit tests in a new/stitch test file: depth 1/2/3 expectations on a synthetic 3-level tree.

**Files:** `lib/stitch.ts`, tests.
**Acceptance:** `GET /v1/files/:key?depth=2` output structurally matches the cached corpus file at depth 2 (verified by Round 0's new file-level diff, A2).

### A2. File-level golden-diff mode + canvas fields

**Finding.** `tools/golden-diff.ts` only diffs `nodes[id].document`. Envelope- and canvas-level fields are never compared — a blind spot hiding at least one real gap: `CanvasNode` in `.spec/api_types.ts` **requires** `prototypeDevice: PrototypeDevice` (`type: 'NONE'|'PRESET'|'CUSTOM'|'PRESENTATION'`, `size?`, `presetIdentifier?`, `rotation: 'NONE'|'CCW_90'`), and `buildFileEnvelope` never emits it. Optional canvas fields per spec: `prototypeBackgrounds?: RGBA[]`, `measurements?: Measurement[]`.

**Solution.**
1. Add `--mode file` to `tools/golden-diff.ts`: fetch bridge `GET /v1/files/:localKey` (optionally `?depth=N`), load cached `golden/file-<KEY>.rest.json` (already on disk — **zero API calls**), normalize both, `diffTrees`, write the same report format.
2. Run it once; fix what surfaces. Known first fix: emit `prototypeDevice` on every CANVAS. The plugin cannot read prototype-device settings, so: corpus-check the real value for this file (likely `{type:'NONE', rotation:'NONE'}`); emit that constant and add a deviations-doc entry; generalize later if a plugin API appears.
3. Keep per-node mode as the default; file mode is additive.

**Files:** `tools/golden-diff.ts`, `lib/stitch.ts`, deviations doc.
**Acceptance:** file-level diff runs; envelope + canvas differences enumerated; `prototypeDevice` resolved (fix or documented).

### A3. Error payload shape

**Finding.** `.spec/api_types.ts` → `ErrorResponsePayloadWithErrMessage = { status: number; err: string }`; `.spec/openapi.yaml` wires exactly this shape to 400/403/404/429/500 on all `/v1/files/*` and `/v1/images/*` endpoints. Bridge `restError()` emits `{status, error: true, message}` (deviation #5).

**Solution.** Split error emitters: `/v1/*` routes use `{ status, err: message }`; legacy `/api/*` keeps the current shape. One-line change in `bridge-server.ts` plus a second helper. Update deviation #5 to "legacy /api routes only" or retire it.

**Files:** `bridge-server.ts`, deviations doc.
**Acceptance:** a 404 from `/v1/files/:key/nodes` returns the spec shape; unit/contract test added.

### A4. `/v1/me` completeness

**Finding.** `.spec/api_types.ts` → `GetMeResponse = User & { email }`; `User` **requires** `id`, `handle`, `img_url`. Bridge omits `img_url`.

**Solution.** `res.json({ id: "figma-agent-local", handle: "figma-agent", img_url: "", email: "local@figma-agent" })`. Trivial.

**Files:** `bridge-server.ts`.
**Acceptance:** response validates against `GetMeResponse`.

### A5. Nodes-response wrapper parity

**Finding.** `.spec/api_types.ts` → `GetFileNodesResponse`: top-level **requires** `thumbnailUrl: string`; each `nodes[id]` entry carries `document, components, componentSets, schemaVersion, styles` — **no `name`**. `buildNodesResponse` adds `name` per entry and omits `thumbnailUrl`.

**Solution.** Verify against the cached corpus first (the real `/nodes` responses under `golden/`): if REST has no entry-level `name`, remove it (or document); add `thumbnailUrl: ""` at the top level (no local thumbnail source exists — deviations entry). Extend the A2 file-mode harness with a wrapper check so this stays covered.

**Files:** `lib/stitch.ts`, `tools/golden-diff.ts`, deviations doc.
**Acceptance:** wrapper matches corpus byte-for-byte (minus documented `thumbnailUrl`).

### A6. Implement the promised `characterStyleOverrides` re-pad

**Finding.** `tools/normalize.ts` header: *"re-pads characterStyleOverrides to the character count"* — the code only renumbers `styleOverrideTable` ids; no padding exists. Harmless today (both sides trim trailing zeros identically), but it will distort Round 3's G4 work, where base-style differences change override extents.

**Solution.** In `normalize()`, when a node has `characters` + `characterStyleOverrides`: pad the array with zeros to `characters.length` on both sides before diffing (REST semantics per `.spec/api_types.ts` `TypePropertiesTrait`: *"If the array is shorter than the total number of characters, the characters beyond the array's length also use the default style"*). Then array lengths are never themselves a diff.

**Files:** `tools/normalize.ts` (+ test).
**Acceptance:** unit test: differently-trimmed-but-equivalent arrays normalize equal.

### A7. Document the `componentPropertyDefinitions` suppression

**Finding.** `normalize()` strips `componentPropertyDefinitions` ("volatile across publish cycles"). Legit policy, but invisible — "identical" on component frames currently says nothing about their property definitions.

**Solution.** One entry in `docs/rest-parity-deviations.md` (Transport/Normalization section): what is stripped, why, and that component-property parity is not being asserted. Optionally add a `--strict` flag to the harness that keeps it.

**Files:** deviations doc, optionally `tools/golden-diff.ts`.

### I1. Build `tools/rule-learn.ts` (the corpus rule-fitter)

**Finding.** Rounds 1–5 all share one activity: *fit a candidate rule against cached ground truth, zero API calls.* Doing it ad hoc per round wastes effort and invites inconsistency.

**Solution.** Generic harness:

```text
npx tsx tools/rule-learn.ts <probe> [--cohort <filter>] [--json]
  1. load golden/file-<KEY>.rest.json (REST truth) + stored frames (ours)
  2. walk paired nodes (ids correspond 1:1 — verified in report.md §2)
  3. for the target property: emit rows (nodeId, nodeType, context…, restValue, ourValue)
  4. test registered candidate rules; print coverage % + first N counterexamples
```

Design: probes are small registered functions (`layoutVersion`, `baseStyleRule`, `overrideVocabulary`, `fillOverrideSemantics`, `lineHeightPercent`, `psNameRule`); each returns candidate predictions; the harness scores them. Rows exportable as JSON for manual inspection. No network, ever.

**Files:** `tools/rule-learn.ts`.
**Acceptance:** runs the `layoutVersion` probe end-to-end and prints a coverage table (used immediately in F1).

### I2. Auto scorecard in the report

**Solution.** Extend `tools/golden-diff.ts` to append a scorecard table to `docs/golden-diff-report.md`: total paths, per-root-cause residue (using the classifier from report.md §3), byte parity %, semantic parity % (once E2 lands), run timestamp. Makes round-over-round progress mechanical.

---

## Round 1 — G5: instance overrides (302 paths — the biggest solvable gap)

> **STATUS: ✅ completed 2026-10-16.** B1, B3, and the components-map fix
> landed; B2 closed as underivable. `npm run check` green, 55/55 tests.
> **Scorecard: 2,335 paths / 97.692% byte parity** (from 2,367 / 97.498%;
> G5: 302 → 257). Measured outcomes:
> - **B1 `overrides` emitted on every instance** (self first, descendants
>   in document order, `overriddenFields` alphabetically sorted — all
>   corpus-measured). Entry arrays match REST **99% for local-main
>   instances (96/97) and 100% for empty ones (77/77)**.
> - **The remote-main ceiling (deviation #37):** REST `overrides` are
>   *stored user-edit records*, not live diffs. Library drift after
>   insertion (renamed mains, edited subtrees, absorbed overrides) is
>   invisible to the plugin API — remote-main arrays match only 1/49.
>   This is a semantic limit, not a detector bug: the plugin exposes no
>   override records.
> - **Auto-scale rule (measured):** descendants that only scaled with
>   their owning instance's resize (ratio within 1e-3) are not overrides
>   — verified on 248:593 (child 24×13.33 vs main 18×10 at 32/24).
>   A descendant's cascade factor is its *nearest* instance ancestor's
>   doc/main ratio (that ratio already composes outer scales).
> - **B3 landed:** instance children inherit `constraints` and style
>   bindings from their main correspondent when they report none.
> - **Transitions:** legacy `transition*` props are gone from the plugin
>   API — detected via modern `reactions` diff, firing the legacy
>   field group. The one corpus case still misses (stored record, live
>   reactions now equal — drift bucket of #37).
> - **B2 `fillOverrideTable` closed as underivable (deviation #38):**
>   all 130 corpus values are `{"1": null}` (5 have 3 slots); presence
>   is uncorrelated with `vectorNetwork` regions (53 with-table report
>   0 regions, 21 without-table report 1), segments, fills, or strokes.
>   No rule clears the 99% bar (same discipline as `layoutVersion`/F1).
> - **Components map fixed:** real 40-hex publish keys (`comp.key`),
>   `remote` always on components / only `true` on sets,
>   `documentationLinks` on every file-level component (remote included,
>   `[]` when none — re-measured on the v2 file fixture, correcting the
>   Round 0 note). File-mode components/componentSets diffs: **0**.
> - Tooling: `tools/restart-plugin.sh` verification fixed (the old check
>   passed with the plugin closed — POST queueing returns 200 instantly);
>   now single-click-run when closed, close/reopen only when reloading.
>   Dev probe: `/api/dev/probe` (node facts, vectorNetwork, instance+main
>   subtree dumps).

Spec anchors: `.spec/api_types.ts` → `Overrides = { id: string; overriddenFields: string[] }`; `InstanceNode` — `overrides` is in the **required** list alongside `type` and `componentId`; `HasGeometryTrait.fillOverrideTable?: { [key: string]: PaintOverride | null }`; `PaintOverride = { fills?: Paint[]; inheritFillStyleId?: string }`.

### B1. `overrides` arrays (146 paths)

**Mechanism — correspondence.** Instance child ids encode the main child: `I<instanceId>;<mainChildId>`, chaining `;` per nesting depth. Strip **only the outer** `I<instanceId>;` prefix → the remainder is a valid id inside the main component's subtree (this works recursively through nested instances because inner prefixes survive the strip).

**Mechanism — main-subtree index.** `serializeNode`'s INSTANCE branch already resolves `main` (`mainComponent` with `getMainComponentAsync` fallback). Add, scoped to one `extractTree` run:

```ts
const mainIndexCache = new Map<string /* main.id */, Map<string /* childId */, SceneNode>>();
function getMainIndex(main: ComponentNode): Map<string, SceneNode> { /* iterative walk, id→node */ }
```

One walk per unique main component, shared by all its instances. Use a **lightweight diff walker** (raw plugin nodes), not the REST serializer — the diff only needs comparable properties.

**Mechanism — detectors → REST field names.** For each instance child with a main counterpart, run detectors and collect differing REST field names:

| Detector (plugin-side comparison) | Candidate REST field name |
|---|---|
| `name` differs | `name` (confirmed by report example) |
| `characters` differs | `characters` |
| fills differ (incl. image fills) | `fills` (confirmed by report example `["strokes"]` analog) |
| strokes differ | `strokes` |
| effects differ | `effects` |
| corner radii differ | `cornerRadius` / `rectangleCornerRadii` |
| opacity differs | `opacity` |
| visible differs | `visible` |
| text style binding differs | verify name via corpus |

**Do not guess the final vocabulary** — learn it: for every instance in the cached corpus that has `overrides`, compute plugin-side diffs and emit a confusion matrix (which detector fires ↔ which REST string appears). `tools/rule-learn.ts` probe `overrideVocabulary`.

**Emission rules.**
1. `overrides` is **required** per spec → emit on every INSTANCE. **Verify first** against the corpus whether REST emits `overrides: []` on instances with no overrides or omits the key (spec says required, but measure). Implement whichever the corpus shows.
2. Include the instance root itself as an entry when it has direct overrides (report example: `{ "id": "147:350", "overriddenFields": ["name"] }`).
3. Inherited overrides are **not** included (spec: *"Inherited overrides are not included"*).

**Files:** `plugin/code.ts` (INSTANCE branch + diff walker + cache), `plugin/lib/rest-mapping.ts` (pure diff helpers + vocabulary table — keeps it unit-testable), `tests/rest-mapping.test.ts`.
**Acceptance:** 146 paths → 0; empty-overrides emission matches corpus; unit tests for correspondence (flat, nested-instance, missing-main cases).

### B2. `fillOverrideTable` (130 paths)

**Finding.** Spec type is `PaintOverride | null` — `null` entries are spec-legal, matching the corpus observation `{"1": null}` (report §3 G5 example). The spec comment says the table pairs with `overrideID` on paths under `geometry=paths`, but the corpus shows the table emitted on instance children **without** `geometry=paths` — so emission is unconditional for instances with fill overrides.

**Solution.** Corpus-fit before coding (`rule-learn.ts` probe `fillOverrideSemantics`): for each corpus node carrying `fillOverrideTable`, dump `(table, instance fills, main fills)` and derive the keying rule (hypothesis: keys are fill indices; value = override paint metadata for image-fill swaps, `null` when the override has no resolvable image data). Then implement inside the B1 instance-child diff path (same correspondence machinery), emitting on the *child* node as REST does.

**Files:** same as B1.
**Acceptance:** 130 paths → 0 or residual classified.

### B3. Inherited constraints + style bindings on instance children (26 + 3 paths)

**Finding.** Plugin returns `figma.mixed` for constraints and `""` for style bindings on instance children (deviation #11). REST shows the **main component's** values (report example: `SCALE/SCALE` on `I180:323;126:7894`).

**Solution.** Inside the same correspondence pass:
```ts
function resolveChildProperty(child, mainChild, prop) {
  const v = child[prop];
  if (v === figma.mixed || v === "" || v === undefined) {
    const mv = mainChild?.[prop];
    if (mv !== figma.mixed && mv !== undefined) return mv;
  }
  return v;
}
```
Apply to `constraints` (then through `mapConstraints`; keep the existing auto-layout `SCALE/SCALE` fallback when no main child resolves) and to the five `*StyleId` bindings. This retires deviation #11.

**Files:** `plugin/code.ts`.
**Acceptance:** the 26 constraint paths + 3 binding nodes clean; golden diff confirms.

---

## Round 2 — G2: font metrics (573 paths)

### C1. Corpus-bootstrap multiplier table (bridge-side post-processing)

**Finding.** REST computes `lineHeightPx` for AUTO line heights from real font metrics (e.g. `17.9004`); the plugin estimates `height ÷ lineCount` (`18`). ~455 paths, plus ~20 fixed-height texts where RAFAP omits rather than lies (deviation #19) — those are still AUTO-unit texts, so a metrics table fixes them too.

**Solution — step 1, zero plugin changes.** Script over `golden/file-<KEY>.rest.json`: for every TEXT node's `style` and every `styleOverrideTable` entry with `lineHeightUnit: 'INTRINSIC_%'`, record `(fontFamily, fontStyle) → multiplier = lineHeightPx / fontSize`. Dedupe per family+style; emit `store/font-metrics.json`:

```jsonc
{ "Inter/Semi Bold": 1.19336, "Avenir/Roman": 1.35, … }
```

**Step 2 — bridge-side rewriter.** In `bridge-server.ts` at persist time (`persistResult`) — not in the plugin — walk each stored frame's TEXT nodes and rewrite `lineHeightPx` (and the A2-normalized round value) in `style` **and every `styleOverrideTable` entry** using the table. Key insight: `lineHeightPx` is a pure function of (font, size), so the plugin output stays untouched and the fix iterates in seconds against cached frames with no `npm run publish`.

**Verification:** replay against the corpus — the table must reproduce REST's px values to 4 decimals for all corpus fonts. Any miss reveals a font needing C2.

**Files:** new `tools/build-font-metrics.ts`, `bridge-server.ts`, `store/font-metrics.json`.
**Acceptance:** ~455 paths → 0 for corpus fonts; deviation #19 retired.

### C2. Runtime font probing (generalizes beyond the corpus)

**Solution.** New pull command `probe-fonts` (add to `createCommand` valid types + `code.ts` handler):

```ts
async function probeFont(font: FontName): Promise<number> {
  await figma.loadFontAsync(font);
  const t = figma.createText();
  t.fontName = font; t.fontSize = 100;
  t.lineHeight = { unit: "AUTO" };
  t.characters = "Ag\nAg\nAg\nAg\nAg";      // 5 lines, ascenders+descenders
  const px = t.height / 5;                   // intrinsic at size 100
  t.remove();                                // same command = one undo step
  return px / 100;                           // multiplier
}
```

Guardrails: verify linearity with a second size before accepting; results POST to a new bridge endpoint persisting into `store/font-metrics.json` (merge with C1's table); human-triggered only.

**Files:** `plugin/code.ts`, `bridge-server.ts`.
**Acceptance:** probing a font absent from the corpus produces a multiplier that fixes that font's texts in the next golden diff.

### C3. `lineHeightPercent` / `lineHeightUnit` (80 paths)

**Finding.** `.spec/api_types.ts` → `TypeStyle`: `lineHeightUnit: 'PIXELS' | 'FONT_SIZE_%' | 'INTRINSIC_%'`; `lineHeightPercent` (deprecated but still emitted); `lineHeightPercentFontSize` *"Only returned when lineHeightPercent (deprecated) is not 100"*. `mapLineHeight` (`rest-mapping.ts`) already handles the three units but omits `lineHeightPercent` for PIXELS (deviation #18, 73 paths) because it needs the intrinsic value — which C1 now provides.

**Solution.** Extend `mapLineHeight(lh, fontSize, intrinsicLineHeightPx)` (intrinsic already plumbed through `StyleSource`):
- PIXELS + intrinsic known → add `lineHeightPercent = round(px / intrinsic × 100, 4)`.
- AUTO + intrinsic known → keep `INTRINSIC_%` / `lineHeightPercent: 100`; fit whether REST also emits a different percent (corpus check, 80 samples).
- Fit both formulas with `rule-learn.ts` probe `lineHeightPercent` before coding; 80 samples is enough to nail it.

**Files:** `plugin/lib/rest-mapping.ts` (+ tests).
**Acceptance:** 80 paths → 0; deviation #18 retired.

### C4. `fontPostScriptName` (38 paths)

**Finding.** `.spec/api_types.ts` → `BaseTypeStyle.fontPostScriptName?: string | null` — null is spec-legal and REST emits null overwhelmingly; 38 corpus paths carry real values (e.g. `Avenir-Roman`). `buildTypeStyle` hardcodes `null`; the unused helper `fontPostScriptName(family, style)` already composes `Family-Style`.

**Solution.** Corpus-fit the 38 samples: which `(family, style)` pairs got real names, and the aliasing (`Regular`/`Book` → `Roman`, spaces stripped). Implement a small lookup/convention in `rest-mapping.ts`: emit the composed name only for fitted pairs; keep `null` otherwise (matches REST's majority behavior).

**Files:** `plugin/lib/rest-mapping.ts` (+ tests).
**Acceptance:** 38 paths → 0 on corpus fonts.

> **STATUS: ✅ completed 2026-10-17.** C1, C3 and C4 landed — all bridge-side,
> via one rewriter; C2 (runtime font probing) deferred as optional
> generalization. `npm run check` green, 69/69 tests.
> **Scorecard: 1,774 paths / 98.246% byte parity** (from 2,335 / 97.692%;
> G2: 573 → 12). Measured outcomes:
> - **C1 multipliers are FAMILY-level, not family+style** (measured: 906
>   corpus samples, 4 families, worst-case fit error ~1e-6 — Inter is
>   1.21022725 for Regular/Semi Bold/Bold/Extra Bold alike). REST emits raw
>   float64 doubles, not rounded values; the golden-diff normalizer rounds
>   to 4 decimals, so a <1e-5 fit is exact after normalization.
> - **All three fixes live in one bridge-side rewriter** (`lib/font-metrics.ts`,
>   applied at persist time, table in gitignored `store/font-metrics.json`):
>   INTRINSIC `lineHeightPx` rewrite (fixes the estimate *and* deviation
>   #19's omission on fixed-height boxes), PIXELS `lineHeightPercent`
>   (= px ÷ intrinsic × 100, validated exactly on 146 samples), and
>   `fontPostScriptName` (corpus table of the 5 combos REST names — the
>   rule is `Family-Style` but REST reports null for Inter except
>   Inter/Medium, so presence is tabulated, not derived). Deviations #13,
>   #17, #18, #19 retired.
> - **C3/C4 went bridge-side instead of plugin-side** (the plan sketched
>   `rest-mapping.ts` changes): the multiplier table already lives
>   bridge-side per C1's key insight — lineHeightPx is a pure function of
>   (font, size) — so percent and PS names reuse it without a publish cycle.
>   The rewriter's SOT `fontPostScriptName` branch (name-or-null when
>   `fontFamily` is in the delta, FONT_KEYS group — 34/34 corpus entries)
>   is correct but cannot fire yet: our SOT entries omit the font group
>   whenever the segment matches our chosen base (#20 family).
> - **G2 residue = 12 paths, all #20/#37-family, none font metrics:**
>   frame `180:304` (8) is the base-vs-SOT swap (REST picked the INTRINSIC
>   segment as base, we pick `segments[0]`), frame `180:338` (4) is REST
>   emitting a *stored* SOT entry whose values equal the base — a live
>   diff cannot see it (same ceiling as #37). Both fold into Round 3's
>   base-style work or the stored-record deviation.
> - **Deferred: C2 runtime font probing** — corpus bootstrap covers all
>   DevBoard fonts; the `probe-fonts` command is pure generalization for
>   unseen fonts and stays unplanned until a real file needs it.

---

## Round 3 — G4: base-style text model (317 paths)

### E1. Corpus-fit the base-selection rule (~310 paths)

**Finding.** REST stores a node base style plus per-range deltas, and the base sometimes matches **no** segment (report example: node `180:316` — REST's base is the blue "Register now" segment; RAFAP uses `segments[0]`, the gray one). `buildTextOverrides` sets `defaultFull = segments[0].style`. One root cause fans out into 212 `characterStyleOverrides` index shifts + 95 `styleOverrideTable` deltas + 3 node-level `fills` swaps.

**Solution.** Test candidate rules against **every multi-segment text** in the cached corpus (`rule-learn.ts` probe `baseStyleRule`):
1. segment containing the **last character** ← the report example points here
2. last segment
3. segment matching the node's `textStyleId` binding
4. majority-length segment
5. segment with the highest font weight

If one rule scores 100% (or ≥99% with inspectable outliers), implement it in `buildTextOverrides` replacing the `segments[0]` baseline (the mixed-fills logic in `serializeText` then follows automatically since it reuses the default segment's fills). If the corpus splits between rules, the base is history-dependent → accept byte residue and rely on E2.

**Files:** `plugin/lib/rest-mapping.ts` (+ tests mirroring the fitted rule).
**Acceptance:** up to 310 byte paths closed; deviation #20 updated or retired.

### E2. Semantic canonicalization layer (do regardless of E1)

**Finding.** Both encodings reconstruct identical rendered text — the difference is representational. The harness should say so.

**Solution.** Add to `tools/normalize.ts` a canonical text-model pass: from `(characters, style, characterStyleOverrides, styleOverrideTable)` rebuild a per-character resolved-style map; re-encode canonically (base = style at char 0, override ids numbered by first appearance, fills included in deltas); diff the canonical forms. `golden-diff.ts` then reports **two numbers**: byte parity and semantic parity.

**Files:** `tools/normalize.ts`, `tools/golden-diff.ts`.
**Acceptance:** G4 contributes 0 semantic paths even when byte paths remain.

> **STATUS: ✅ completed 2026-10-17.** E1 closed as underivable with
> decisive evidence; E2 implemented — the harness now reports byte parity
> **and** semantic parity. `npm run check` green, 77/77 tests.
> **Scorecard: 1,774 byte / 1,435 semantic paths — byte parity 98.246%,
> semantic parity 98.582%** (G4: 340 byte → 13 semantic; G2: 12 → 0).
> Measured outcomes:
> - **E1: REST's base style is the stored typing style** (the editor's
>   cursor/insertion style — fourth stored-record manifestation, #37
>   family). All 10 multi-segment corpus texts examined: 4 bases match no
>   live segment (Semi Bold typing style, never typed; no `textStyleId`
>   binding), 3 match `segments[0]`, 3 match another segment (separator
>   spaces ×2, style-bound segment ×1). No candidate rule reaches the
>   bar; closed as underivable, deviation #20 rewritten.
> - **E2 canonicalization lives in `tools/normalize.ts`**
>   (`canonicalizeTextModel`): resolve per-char styles, drop
>   plugin-invisible `inherit*StyleId` and non-applicable lineHeight
>   fields, pin node-level `textAutoResize` (REST range records carry
>   per-range values for it), re-encode with base = resolved char-0.
>   Unreferenced stored table entries vanish. `golden-diff.ts` prints
>   both numbers; the scorecard table gained a Semantic column.
> - **G4's 13 semantic residue paths:** 11 `exportSettings` on fixture
>   roots — probe-verified the live plugin reports the full default
>   setting byte-identical to controls, while the Oct-15 fixtures (file
>   envelope included) lack it → **suspected corpus staleness**, verify
>   with a live re-fetch at the next API window (same window as the
>   pending deviation #33 measurement; a 429 stopped today's attempt).
>   The other 2 are #37-family override-id shifts.
> - **Probe extended:** `rawExportSettings` in `/api/dev/probe` node facts
>   (published to the dev plugin).

---

## Round 4 — G1: library harvest (646 paths)

### D1–D3. Harvest workflow + consumer-side resolution (643 paths)

**Finding.** A plugin is file-scoped: ids inside a defining library file are unreadable from the consumer file (deviation #10). But **inside the library file itself**, those styles are local — `enumerateLocalStyles` (`code.ts`) already captures `key → nodeId` for every local style. The 40-hex `key` matches REST exactly from both sides; that's the join.

**Solution — harvest side.** New command `harvest-library` (or fold into `page-index` when the operator runs it inside a library file): plugin emits `{ fileKey, name, styles: { "<40-hex key>": { nodeId, name, description, styleType } } }`; bridge persists `store/libraries/<hash>.json` and merges on re-harvest.

**Solution — consumer side.** In `serializeNode`'s style-binding loop, where `st.remote === true` currently keeps the marker id:

```ts
if ((st as any).remote === true) {
  const lib = libraryMap.get(st.key);          // loaded from store/libraries/
  if (lib) {
    styles[lib.nodeId] = { key: st.key, name: lib.name, description: lib.description,
                           remote: true, styleType: lib.styleType };
    styleBindings[field] = lib.nodeId;          // REST's library node id
    continue;
  }
  unresolved.push({ key: st.key, usedBy: node.id });
}
```

Unresolved keys accumulate to `store/unresolved-library-styles.json` — a self-diagnosis report telling the operator exactly which libraries to open and harvest next. `lib/stitch.ts` aggregation already merges per-frame `styles` maps, so harvested definitions flow into the file-level map with no extra work.

**Solution — routes.** `/v1/files/:key/styles` and the envelope pick up library entries automatically via aggregation; no route changes expected (verify).

**Files:** `plugin/code.ts`, `bridge-server.ts` (store + load), `lib/stitch.ts` (verify), deviations doc (#10 → retired per harvested library).
**Acceptance:** 643 paths → 0 for each harvested library; unresolved report empty after the operator harvests all referenced libraries.

> **STATUS: ✅ completed 2026-10-17 — G1 649 → 6 paths.**
> **Scorecard: 1,131 byte / 792 semantic paths — byte parity 98.882%,
> semantic parity 99.217%** (from 1,774/1,435, 98.246%/98.582%).
> G1: 649 → 6 (D4 residue); unresolved report **empty**; the file
> envelope's `styles` map is **byte-identical to REST (42/42)**.
> `npm run check` green, 91/91 tests; plugin published + dev bridge
> restarted. Resolution path changed mid-round — the decisive findings:
> - **Current Figma reports local styles with empty id markers**
>   (`"S:<40hex>,"` — probe-verified on two files via the new
>   `?styles=1` probe mode, sync + async getters, legacy *and*
>   dynamic-page document access; node `*StyleId` properties still
>   return real markers). Consequences: (a) the planned operator
>   harvest-of-a-library-file **cannot work** — the plugin cannot see
>   local style node ids, period; (b) DevBoard's "1 local style" was an
>   **enumeration collapse bug** (every local style keyed the map under
>   `""`, last write wins) — the file still has its 19.
> - **Rest-bootstrap join (the resolution, and the "easy as real API"
>   answer):** a REST file envelope's `styles` map is itself the complete
>   key→nodeId join table. `tools/bootstrap-library-styles.ts` mines it
>   from a saved envelope (zero API calls — the Oct-15 fixture
>   bootstrapped DevBoard); the bridge **auto-bootstraps on fresh pull**
>   when the token + `store/file-key-aliases.json` alias exist (one
>   cached call per file, 429/offline-safe skip). Same one-time-bootstrap
>   philosophy as `store/font-metrics.json`. The rewrite at persist time
>   (`lib/library-harvest.ts`) re-keys `styles` map entries — remote
>   **and** local — and renames `node.styles` bindings; consumer
>   metadata is kept (REST reads the same cached copy).
> - **Plugin fixes:** enumeration keys placeholder-suffix styles by their
>   full id (no collapse — 84 distinct styles appeared in a test file
>   where 1 showed before); `styleType` vocabulary mapped (`PAINT` →
>   REST's `FILL`, `restStyleType`). Deviations #39/#40 record both.
> - **Hardening:** placeholder ids are rejected by the join table at
>   write **and** load time (a poisoned-index incident during
>   development — a pre-guard harvest overrode the bootstrap — proved
>   both guards necessary).
> - **Remaining 6 paths = D4:** one prototype transition
>   (`transitionNodeID` → `10:1098`, library-side frame) on frame
>   180:324; deviation #16. Optional closure: node-level transition LUT
>   mined from the same rest-bootstrap envelope.

### D4. Library prototype transitions (3 paths)

**Solution (optional, cheap).** If the operator harvests the library's full page-index/frames, destination frame ids (`transitionNodeID`) become membership-checkable; emit the transition fields when the destination resolves. If not harvested → keep deviation #16 wording. Low priority: 3 paths.

---

## Round 5 — G3: history metadata (516 paths)

> **STATUS: 🚧 in progress 2026-10-17.** Pre-work (G1 → **0 paths**, byte
> parity 98.888%, semantic 99.223%):
> - **D4 closed (deviation #16 retired):** `transitionNodeID` is derived in
>   the plugin from the first NODE action's `destinationId` — probe-verified
>   that the plugin reports the library-side node id *directly* (cross-file
>   included), so no join is needed. `transitionDuration`/`transitionEasing`
>   are server-side state (probed: legacy reads and `action.transition` are
>   all null while REST reports 300/EASE_OUT) — injected by the bridge from
>   the rest-bootstrap **transition table** (`bootstrapTransitionsFromDocument`,
>   per-file; node ids are file-scoped so tables never merge globally; the
>   auto-bootstrap now fetches the full envelope instead of `?depth=1`).
> - **Deviation #11 style-binding half retired (corrected diagnosis):** the
>   "inherited instance-child bindings" were actually **MIXED rich text** —
>   REST reports the **last styled segment's** binding (corpus 3/3 via
>   `getStyledTextSegments`). Measured in the same pass: REST emits only
>   stored per-node `node.styles` — no main-inheritance (the mc-inheritance
>   in `binding()` was removed after it introduced 7 false positives).
> - **`mainCorrespondent` hardened:** structural fallback (parent-chain +
>   child-index walk) for plain-id descendants, defensive `mainProp` reads.
>   Constraints inheritance (B3) unchanged in effect (G5 257 → 257).
> - File envelope: 1,660 byte / 808 semantic diffs (was 1,666/835).
> - `npm run check` green, 95/95 tests (4 new transition-table tests);
>   plugin 3.3.0 published; rest-bootstrap re-mined (42 style ids + 1
>   transition).
> Next: F1 (`layoutVersion` corpus mine), F2 (`scrollBehavior` prototype
> walk), F3 (confirm #14/#15 as final).

### F1. `layoutVersion` corpus mine (492 paths — 21% of the whole diff)

**Finding.** `.spec/api_types.ts` → `TypePropertiesTrait.layoutVersion?: number` — *"Internal property, preserved for backward compatibility. Avoid using this value."* The plugin exposes nothing equivalent (deviation #7). But it may be boringly deterministic (e.g. constant per node type in modern files) — worth one analysis before declaring it fundamental.

**Solution.** `rule-learn.ts` probe `layoutVersion`: tabulate presence/value by `node.type` and by properties (auto-layout? TEXT?) over the corpus. Outcomes:
- **≥99% covered by a rule** → emit it in `serializeNode` behind a config flag (`emitLearnedHistoryFields: true`, default off), with a deviations-doc entry stating it is corpus-fitted and may not generalize to other files.
- **Scattered per node** → genuinely edit-history; document and close the question.

Either outcome is a win: 492 paths resolved or conclusively classified.

**Files:** `tools/rule-learn.ts`, possibly `plugin/code.ts` + flag plumbing, deviations doc.

### F2. `isFixed` / `scrollBehavior` discovery experiment (6 paths)

**Finding.** `.spec/api_types.ts` → `IsLayerTrait`: `scrollBehavior: 'SCROLLS' | 'FIXED' | 'STICKY_SCROLLS'` plus deprecated `isFixed?: boolean` (default false). `code.ts` hardcodes `"SCROLLS"` with the comment *"The plugin has no API to read scrollBehavior"* — but current plugin typings do expose `FrameNode.scrollBehavior` (`'SCROLLS' | 'STICKY' | 'STICKY_SCROLLS'`); the comment may be outdated. Note the vocab gap: REST has no bare `STICKY`; plugin `STICKY` maps to REST `STICKY_SCROLLS`; `FIXED`/`isFixed` may be prototype-pinned state with no plugin surface.

> **❗ Verified disproven (Round 0):** the installed `@figma/plugin-typings` exposes **no** `scrollBehavior` on any node — the review's premise was outdated typings. The hardcoded `"SCROLLS"` stands; run the prototype-walk experiment only if cheap, expecting the "not readable" outcome.

**Solution.** A 30-minute experiment on the 6 corpus nodes: `figma.getNodeByIdAsync(id)`, enumerate readable property names (prototype walk), read `scrollBehavior` / any `isFixed`-like field, compare to REST values. Outcomes: readable → replace the hardcoded `"SCROLLS"` with the mapped read (+ `isFixed` if discoverable), retire part/all of deviation #12; not readable → deviation #12 stands with the experiment recorded.

**Files:** throwaway probe script → possibly `plugin/code.ts`.

### F3. Accept the truly-gone 18 paths

`rotation: 0` history (4, deviation #14) and zeroed-radii history (14, deviation #15): no plugin surface, no derivation. Action: none — confirm both deviations-doc entries are final and let the Round 0 scorecard show them as the documented floor.

---

## Round 6 — Probes & spec-0.44.0 frontier

### G1. Segment field probes (deviation #21 + hyperlink)

**Solution.** One experimental plugin run adding fields to the `getStyledTextSegments` request in `serializeText`:
- `"textStyleId"` — if exposed, emit `inheritTextStyleId` / `inheritFillStyleId` in override deltas (deviation #21, 2 entries) and sharpen B1's text-override detector.
- `"hyperlink"` — `.spec/api_types.ts` `BaseTypeStyle.hyperlink?: Hyperlink` (`{type:'URL'|'NODE', url?, nodeID?}`); if exposed, map through `buildTypeStyle`.

Cost: one publish cycle. If a field isn't exposed, the deviations entries stand.

### H. New REST surfaces (mine the corpus before building any of these)

Spec 0.44.0 surfaces RAFAP doesn't map yet. **Rule: mine `golden/file-<KEY>.rest.json` first; implement only what the corpus contains; otherwise document "not present in reference corpus".** None affect the current 2,354-path census.

| ID | Surface | Spec anchor (`.spec/api_types.ts`) | Mapping note |
|---|---|---|---|
| H1 | GRID layout: `layoutMode: 'GRID'`, `gridRowCount/gridColumnCount/gridRowGap/gridColumnGap/gridColumnsSizing/gridRowsSizing`, child `gridChild*Align/grid*Span/grid*AnchorIndex` | `HasLayoutTrait`, `HasFramePropertiesTrait` | The auto-layout block in `serializeNode` already fires for `GRID` (`!== "NONE"`) but emits none of the grid fields |
| H2 | `minWidth/maxWidth/minHeight/maxHeight` | `HasLayoutTrait` | Auto-layout frames + children |
| H3 | `counterAxisAlignContent: 'AUTO'\|'SPACE_BETWEEN'` | `HasFramePropertiesTrait` | WRAP frames; emit alongside existing `counterAxisSpacing` |
| H4 | `PATTERN` paint (`sourceNodeId, tileType, scalingFactor, spacing, horizontal/verticalAlignment`) | `PatternPaint` | `mapPaint` default branch passes `type` through but drops fields |
| H5 | `gifRef` on image paints | `ImagePaint` | One field in the IMAGE branch of `mapPaint` |
| H6 | Progressive blur (`blurType: 'PROGRESSIVE'`, `startRadius`, `startOffset`, `endOffset`) | `ProgressiveBlurEffect` | `mapEffects` blur branch ignores `blurType` today |
| H7 | Noise/texture subfields (`noiseType` MONOTONE/MULTITONE/DUOTONE, `density`, `noiseSize`, `secondaryColor`, `opacity`, `clipToShape`) | `NoiseEffect`, `TextureEffect` | Generic passthrough mostly survives; structured mapping is safer |
| H8 | `devStatus`, `explicitVariableModes` | `DevStatusTrait`, `IsLayerTrait` | Direct plugin reads if exposed |
| H9 | Text: `textTruncation`/`maxLines`, `listSpacing`, `semanticWeight`/`semanticItalic`, `isOverrideOverTextStyle` | `TypeStyle` | `textTruncation` supersedes the deprecated `TRUNCATE` value of `textAutoResize` |
| H10 | `TEXT_PATH` node type | `TextPathNode` | Rule B4 passthrough already covers it; explicit mapping only if corpus contains one |

---

## Execution protocol (unchanged, binding)

1. Port 3001 / `Agent Plugin/` untouched. Dev on 3002.
2. Plugin edits only in `figma-bridge/plugin/`; ship via human-approved `npm run publish`; human reopens the plugin.
3. `npm run check` green after every change (both tsconfigs).
4. Every new mapping rule gets a vitest case in `tests/rest-mapping.test.ts`.
5. Every intentional difference gets a `docs/rest-parity-deviations.md` entry; anything in a golden diff that is **not** in that doc is a bug.
6. REST calls: never more than one per run; the corpus is cached — Rounds 0–6 above require **zero** new `api.figma.com` calls.
7. Rounds are ordered; don't start a round before the previous one's acceptance criteria are met and recorded in the scorecard (I2).

## Definition of done (project-level)

- [ ] Scorecard shows ≤ 18 residual byte paths, all matched to deviations-doc entries
- [ ] Semantic parity 100% (E2 layer)
- [ ] File-level diff mode green at depth 1/2/full
- [ ] `overrides`/`fillOverrideTable` emitted per spec on instances
- [ ] Font-metrics table covers every font in the corpus; probe command covers the rest
- [ ] Library harvest closes remote style ids for all referenced libraries
- [ ] Deviations doc: every entry either retired or marked fundamental with the experiment that proved it