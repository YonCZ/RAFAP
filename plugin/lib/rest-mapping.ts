/**
 * Pure REST-mapping helpers — Figma Plugin API values → Figma REST API
 * shapes (per figma/rest-api-spec, see .spec/api_types.ts).
 *
 * Shared by the plugin sandbox (bundled by esbuild into code.js) and the
 * Node test suite (vitest). This module must stay PURE:
 *
 *   · no `figma.*` runtime access — callers convert the `figma.mixed`
 *     symbol to the MIXED sentinel string before calling in
 *   · types come from @figma/plugin-typings as ambient globals, pulled in
 *     by the reference below so any project compiling this file sees them
 *
 * Serialization contract (agent.md §7.2):
 *   B1 invariant core · B2 never emit null/undefined/zero placeholders ·
 *   B3 "figma::mixed" sentinel · B4 unknown types pass through ·
 *   B5 our extensions live under _figmaAgent, never shadow REST fields.
 */
/// <reference types="@figma/plugin-typings" />

/** REST's exact sentinel for values that vary across a node's contents. */
export const MIXED = "figma::mixed";
export type Mixed = typeof MIXED;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Strip every key whose value is `undefined` or `null` (Rule B2: never
 * emit null — REST omits absent properties instead).
 */
export function omitEmpty<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Cheap structural deep-equal — no dependencies (plugin sandbox has none). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// ---------------------------------------------------------------------------
// Colors & paints — floats 0–1, never hex
// ---------------------------------------------------------------------------

export interface RestRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function mapColor(c: { r: number; g: number; b: number }, a = 1): RestRGBA {
  return { r: c.r, g: c.g, b: c.b, a };
}

/**
 * Map one plugin Paint to the REST paint shape.
 * Input must already be free of `figma.mixed` symbols.
 */
export function mapPaint(paint: Paint): Record<string, unknown> {
  const p = paint as unknown as Record<string, unknown>;
  const base = omitEmpty({
    visible: p.visible === false ? false : undefined, // REST emits visible only when false
    opacity: typeof p.opacity === "number" && p.opacity !== 1 ? p.opacity : undefined,
    blendMode: (p.blendMode as string) ?? "NORMAL",
    // variable bindings ride along on the paint (e.g. {color: VariableAlias})
    boundVariables: p.boundVariables && Object.keys(p.boundVariables as object).length
      ? p.boundVariables
      : undefined,
  });

  switch (paint.type) {
    case "SOLID":
      return {
        ...base,
        type: "SOLID",
        color: mapColor(paint.color),
      };

    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND": {
      // The plugin API exposes gradientTransform (a 2×3 matrix mapping
      // gradient space → normalized object space), while REST exposes three
      // handle positions. Derive them: handle0 = translation, handle1 = end
      // of the x direction, handle2 = end of the y direction.
      const gt = (paint as unknown as { gradientTransform?: number[][] }).gradientTransform;
      const handles = gt
        ? [
            { x: gt[0][2], y: gt[1][2] },
            { x: gt[0][0] + gt[0][2], y: gt[1][0] + gt[1][2] },
            { x: gt[0][1] + gt[0][2], y: gt[1][1] + gt[1][2] },
          ]
        : [];
      return {
        ...base,
        type: paint.type,
        gradientHandlePositions: handles,
        gradientStops: (paint.gradientStops ?? []).map((s) => {
          const sv = s as unknown as Record<string, unknown>;
          return omitEmpty({
            position: s.position,
            color: mapColor(s.color, s.color.a ?? 1),
            boundVariables:
              sv.boundVariables && Object.keys(sv.boundVariables as object).length
                ? sv.boundVariables
                : undefined,
          });
        }),
      };
    }

    case "IMAGE": {
      const img = paint as unknown as {
        scaleMode?: string;
        imageRef?: string | null;
        imageHash?: string | null;
        imageTransform?: unknown;
        scalingFactor?: number;
        rotation?: number;
        filters?: Record<string, number>;
      };
      // Plugin "CROP" is REST "STRETCH" (same UI mode, different names).
      const scaleMode = img.scaleMode === "CROP" ? "STRETCH" : img.scaleMode;
      // REST omits filters when they are all defaults and rotation when 0.
      // The plugin renamed imageRef → imageHash (same 40-hex value).
      const filters =
        img.filters && Object.values(img.filters).some((v) => v !== 0 && v !== undefined)
          ? img.filters
          : undefined;
      return omitEmpty({
        ...base,
        type: "IMAGE",
        scaleMode,
        imageRef: img.imageHash ?? img.imageRef ?? undefined,
        imageTransform: scaleMode === "STRETCH" ? img.imageTransform : undefined,
        scalingFactor: scaleMode === "TILE" ? img.scalingFactor : undefined,
        rotation: typeof img.rotation === "number" && img.rotation !== 0 ? img.rotation : undefined,
        filters,
      });
    }

    // VIDEO, EMOJI, STICKER, future types — pass the type through so
    // nothing is silently lost (Rule B4).
    default:
      return { ...base, type: String(p.type) };
  }
}

/** Map an array of paints, or the mixed sentinel untouched. */
export function mapPaints(paints: readonly Paint[]): Record<string, unknown>[] {
  return paints.map(mapPaint);
}

// ---------------------------------------------------------------------------
// Effects — shadows, blurs, noise, texture (nothing silently dropped)
// ---------------------------------------------------------------------------

export function mapEffects(effects: readonly Effect[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of effects) {
    const eff = e as unknown as Record<string, unknown>;
    switch (e.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW": {
        const color = (eff.color as { r: number; g: number; b: number; a?: number }) ?? { r: 0, g: 0, b: 0, a: 1 };
        const shadow = omitEmpty({
          type: e.type,
          color: mapColor(color, color.a ?? 1),
          blendMode: (eff.blendMode as string) ?? "NORMAL",
          offset: eff.offset ? { x: (eff.offset as any).x, y: (eff.offset as any).y } : { x: 0, y: 0 },
          radius: eff.radius as number,
          visible: eff.visible !== false,
          showShadowBehindNode: eff.showShadowBehindNode === true,
        });
        // REST emits spread only when set (zero-spread shadows omit it — measured)
        if (typeof eff.spread === "number" && eff.spread !== 0) shadow.spread = eff.spread;
        out.push(shadow);
        break;
      }
      case "LAYER_BLUR":
      case "BACKGROUND_BLUR":
        out.push(omitEmpty({ type: e.type, visible: eff.visible !== false, radius: eff.radius as number }));
        break;
      // NOISE, TEXTURE, future effect types — pass through known fields.
      default:
        out.push(omitEmpty({ type: String(eff.type), visible: eff.visible !== false, ...eff }));
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constraints — plugin enums differ from REST (measured from real payloads)
// ---------------------------------------------------------------------------

/**
 * Plugin layout constraints use MIN/CENTER/MAX/STRETCH; REST uses the
 * user-facing LEFT/RIGHT/LEFT_RIGHT (and TOP/BOTTOM/TOP_BOTTOM) names.
 */
const CONSTRAINT_HORIZONTAL: Record<string, string> = {
  MIN: "LEFT",
  CENTER: "CENTER",
  MAX: "RIGHT",
  STRETCH: "LEFT_RIGHT",
  SCALE: "SCALE",
};
const CONSTRAINT_VERTICAL: Record<string, string> = {
  MIN: "TOP",
  CENTER: "CENTER",
  MAX: "BOTTOM",
  STRETCH: "TOP_BOTTOM",
  SCALE: "SCALE",
};

export function mapConstraints(c: { horizontal?: string; vertical?: string }): {
  horizontal?: string;
  vertical?: string;
} {
  return {
    horizontal: CONSTRAINT_HORIZONTAL[c.horizontal ?? ""] ?? c.horizontal,
    vertical: CONSTRAINT_VERTICAL[c.vertical ?? ""] ?? c.vertical,
  };
}

// ---------------------------------------------------------------------------
// TypeStyle (text) — REST TypeStyle from plugin values
// ---------------------------------------------------------------------------

/**
 * Source for a TypeStyle: either a styled-text segment or a node's
 * aggregate properties (already de-mixed by the caller).
 */
export interface StyleSource {
  fontFamily?: string;
  fontStyle?: string; // "Regular", "Semi Bold", …
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: LetterSpacing;
  lineHeight?: LineHeight;
  textDecoration?: "NONE" | "STRIKETHROUGH" | "UNDERLINE";
  textCase?: string;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  fills?: readonly Paint[];
  /**
   * REST emits lineHeightPx even for intrinsic (AUTO) line heights — it
   * computes real font metrics server-side. The plugin cannot read font
   * metrics; the caller estimates it (node height ÷ rendered line count)
   * and passes it here. Only used when the unit is AUTO.
   */
  intrinsicLineHeightPx?: number;
  /**
   * Per-segment styles carry fills (REST's styleOverrideTable deltas keep
   * them); the published default `style` never has fills.
   */
  includeFills?: boolean;
}

/** "Inter" + "Semi Bold" → "Inter-SemiBold" */
export function fontPostScriptName(family: string, style: string): string {
  return `${family.replace(/\s+/g, "")}-${style.replace(/\s+/g, "")}`;
}

/** REST letterSpacing is a plain px number. PERCENT → % of fontSize. */
export function mapLetterSpacing(ls: LetterSpacing | undefined, fontSize: number | undefined): number | undefined {
  if (!ls) return undefined;
  if (ls.unit === "PIXELS") return ls.value;
  if (ls.unit === "PERCENT" && typeof fontSize === "number") {
    return Math.round((ls.value / 100) * fontSize * 100) / 100;
  }
  return undefined;
}

/**
 * REST line height — always three fields (measured from real payloads):
 *   PIXELS    → lineHeightPx + lineHeightPercentFontSize (px ÷ fontSize × 100)
 *   PERCENT   → lineHeightUnit FONT_SIZE_% + lineHeightPercentFontSize
 *   AUTO      → lineHeightUnit INTRINSIC_% + lineHeightPercent 100
 *               (+ lineHeightPx = the font's intrinsic metric)
 *
 * REST additionally emits lineHeightPercent for PIXELS (px ÷ intrinsic —
 * needs server-side font metrics) which we cannot compute; omitted, see
 * docs/rest-parity-deviations.md.
 */
export function mapLineHeight(
  lh: LineHeight | undefined,
  fontSize?: number,
  intrinsicLineHeightPx?: number,
): Record<string, unknown> {
  if (!lh) return {};
  if (lh.unit === "PIXELS") {
    const out: Record<string, unknown> = { lineHeightPx: lh.value, lineHeightUnit: "PIXELS" };
    if (typeof fontSize === "number" && fontSize > 0) {
      out.lineHeightPercentFontSize = (lh.value / fontSize) * 100;
    }
    return out;
  }
  if (lh.unit === "PERCENT") {
    return { lineHeightUnit: "FONT_SIZE_%", lineHeightPercentFontSize: lh.value };
  }
  // AUTO — intrinsic
  const out: Record<string, unknown> = { lineHeightUnit: "INTRINSIC_%", lineHeightPercent: 100 };
  if (typeof intrinsicLineHeightPx === "number" && intrinsicLineHeightPx > 0) {
    out.lineHeightPx = intrinsicLineHeightPx;
  }
  return out;
}

/** Build a REST TypeStyle object from a de-mixed style source. */
export function buildTypeStyle(s: StyleSource): Record<string, unknown> {
  const out = omitEmpty({
    fontFamily: s.fontFamily,
    fontStyle: s.fontStyle,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    textAlignHorizontal: s.textAlignHorizontal,
    textAlignVertical: s.textAlignVertical,
    // REST always emits letterSpacing — 0.0 when unset.
    letterSpacing: mapLetterSpacing(s.letterSpacing, s.fontSize) ?? 0,
    ...mapLineHeight(s.lineHeight, s.fontSize, s.intrinsicLineHeightPx),
    // conditional text props — REST omits the defaults
    textCase: s.textCase && s.textCase !== "ORIGINAL" ? s.textCase : undefined,
    textDecoration: s.textDecoration && s.textDecoration !== "NONE" ? s.textDecoration : undefined,
    paragraphSpacing: s.paragraphSpacing ? s.paragraphSpacing : undefined,
    paragraphIndent: s.paragraphIndent ? s.paragraphIndent : undefined,
    fills: s.includeFills && s.fills ? mapPaints(s.fills) : undefined,
  });
  // REST emits fontPostScriptName on every style, null in the overwhelming
  // majority of cases (the resolution rule is server-side and not exposed
  // to plugins — see docs/rest-parity-deviations.md). fontFamily/style/weight
  // carry the full information.
  out.fontPostScriptName = null;
  return out;
}

// ---------------------------------------------------------------------------
// Instance-child ↔ main-component correspondence (Round 1 — overrides)
// ---------------------------------------------------------------------------

/**
 * Strip the owning-instance prefix from an instance descendant's id.
 *
 * Document ids of instance descendants are `I<topInstanceId>;<rel>` where
 * <rel> is the node's id within the main component's subtree. Segments
 * chain ONLY through nested instances (plain levels add nothing), and a
 * nested instance's own descendants prefix with the nested instance's full
 * id — so try the `I`-prefixed form first, then the bare form (measured
 * from the REST corpus).
 */
export function mainRelativeId(instanceId: string, nodeId: string): string | null {
  const withI = `I${instanceId};`;
  if (nodeId.startsWith(withI)) return nodeId.slice(withI.length);
  const bare = `${instanceId};`;
  if (nodeId.startsWith(bare)) return nodeId.slice(bare.length);
  return null;
}

/**
 * Normalize a plugin-reported id from INSIDE a main component's subtree to
 * the flat main-relative form. Children of nested instances carry an inner
 * `I` when walked from the main (`I6:1803;267:5340`) which document-space
 * ids do not (`6:1803;267:5340`).
 */
export function flatMainKey(walkedId: string): string {
  return walkedId.replace(/^I/, "").replace(/;I/g, ";");
}

/** Normalize a *StyleId value for comparison: "S:…" kept, ""/mixed → "". */
export function styleIdValue(v: unknown): string {
  return typeof v === "string" && v ? v : "";
}

/** Paint arrays equal? — raw JSON compare; mixed sentinels equal only to themselves. */
export function paintsEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "symbol" || typeof b === "symbol") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

const RADIUS_KEYS = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] as const;
const PADDING_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

const layoutModeActive = (n: Record<string, unknown>): boolean => {
  const m = n.layoutMode;
  return typeof m === "string" && m !== "NONE";
};

/**
 * Does a size difference exactly match the owning instance's resize ratio?
 * A descendant that only scaled with its parent's resize is NOT a stored
 * override (measured: 248:593 resized 32/24; its child 24×13.33 vs main
 * 18×10 carries the same 1.3333× ratio — REST lists no override for it).
 */
function scaleExplains(cv: unknown, mv: unknown, s: number): boolean {
  if (typeof cv !== "number" || typeof mv !== "number" || mv === 0) return false;
  return Math.abs(cv / mv - s) <= 1e-3;
}

/**
 * Detect which REST `overriddenFields` differ between an instance-side
 * node and its main-component correspondent. Both arguments are live
 * plugin nodes (duck-typed; pure function otherwise).
 *
 * `scale` — the resize ratio of the node's nearest enclosing instance
 * (doc dims ÷ its main's dims). Descendant size diffs explained by that
 * ratio are inherited scaling, not overrides, and are suppressed.
 *
 * The vocabulary is corpus-measured (see report/next_step Round 1):
 * inheritFillStyleId, height, width, name, strokes, fills,
 * targetAspectRatio, clipsContent, primaryAxisSizingMode, corner radii,
 * paddings, transitions, the text-style family, and `text` for characters.
 */
export function detectOverrideFields(
  c: Record<string, unknown>,
  m: Record<string, unknown>,
  scale?: { x: number; y: number },
): string[] {
  const f: string[] = [];
  const isText = c.type === "TEXT" && m.type === "TEXT";

  if (c.name !== m.name) f.push("name");
  if (c.width !== m.width && !(scale && scaleExplains(c.width, m.width, scale.x))) f.push("width");
  if (c.height !== m.height && !(scale && scaleExplains(c.height, m.height, scale.y))) f.push("height");
  if (!isText && !paintsEqual(c.fills, m.fills)) f.push("fills");
  if (!paintsEqual(c.strokes, m.strokes)) f.push("strokes");
  if (styleIdValue(c.fillStyleId) !== styleIdValue(m.fillStyleId)) f.push("inheritFillStyleId");
  if (styleIdValue(c.textStyleId) !== styleIdValue(m.textStyleId)) f.push("inheritTextStyleId");

  // corner radii — uniform cornerRadius on frames, per-corner on rectangles
  if (
    typeof c.cornerRadius === "number" &&
    typeof m.cornerRadius === "number" &&
    c.cornerRadius !== m.cornerRadius
  ) {
    f.push("cornerRadius");
  }
  for (const p of RADIUS_KEYS) {
    if (typeof c[p] === "number" && typeof m[p] === "number" && c[p] !== m[p]) f.push(p);
  }

  if (
    typeof c.clipsContent === "boolean" &&
    typeof m.clipsContent === "boolean" &&
    c.clipsContent !== m.clipsContent
  ) {
    f.push("clipsContent");
  }
  if (JSON.stringify(c.targetAspectRatio ?? null) !== JSON.stringify(m.targetAspectRatio ?? null)) {
    f.push("targetAspectRatio");
  }

  // auto-layout container overrides — only meaningful when both lay out
  if (layoutModeActive(c) && layoutModeActive(m)) {
    if (c.primaryAxisSizingMode !== m.primaryAxisSizingMode) f.push("primaryAxisSizingMode");
    if (c.counterAxisSizingMode !== m.counterAxisSizingMode) f.push("counterAxisSizingMode");
    if (c.primaryAxisAlignItems !== m.primaryAxisAlignItems) f.push("primaryAxisAlignItems");
    if (c.counterAxisAlignItems !== m.counterAxisAlignItems) f.push("counterAxisAlignItems");
    for (const p of PADDING_KEYS) {
      if (typeof c[p] === "number" && typeof m[p] === "number" && c[p] !== m[p]) f.push(p);
    }
    if (
      typeof c.itemSpacing === "number" &&
      typeof m.itemSpacing === "number" &&
      c.itemSpacing !== m.itemSpacing
    ) {
      f.push("itemSpacing");
    }
  }

  // prototype transition overrides. The legacy transition* properties are
  // gone from the plugin API — compare the modern `reactions` instead and
  // fire REST's legacy field group when they differ (measured: 180:335,
  // an instance with an added tap-navigate reaction, lists
  // transitionDuration/Easing/NodeID).
  if (
    JSON.stringify(c.reactions ?? null) !== JSON.stringify(m.reactions ?? null) ||
    c.transitionDuration !== m.transitionDuration ||
    c.transitionEasing !== m.transitionEasing ||
    c.transitionNodeID !== m.transitionNodeID
  ) {
    f.push("transitionDuration", "transitionEasing", "transitionNodeID");
  }

  // TEXT — characters + per-field style deltas (via styled segments)
  if (isText) {
    if (c.characters !== m.characters) f.push("text");
    f.push(...textStyleDiff(c as any, m as any));
  }
  // REST emits overriddenFields in alphabetical order (measured).
  return [...new Set(f)].sort();
}

/**
 * Text-style override fields. Compares the set of per-segment styled values
 * (so boundary shifts don't false-fire) and emits REST field names; font
 * identity travels as a group (fontFamily + fontPostScriptName + fontSize +
 * fontWeight) mirroring the FONT_KEYS rule in styleDelta.
 */
function textStyleDiff(c: any, m: any): string[] {
  const FIELDS = ["fontName", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "fills"] as const;
  const collect = (t: any): Record<string, string> => {
    const summary: Record<string, string> = {};
    try {
      const segs = t.getStyledTextSegments([
        "fontName",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "lineHeight",
        "fills",
      ]) as any[];
      for (const field of FIELDS) {
        summary[field] = JSON.stringify(
          [...new Set(segs.map((s) => JSON.stringify(s[field] ?? null)))].sort(),
        );
      }
    } catch {
      /* fonts unavailable — no comparable summary */
    }
    return summary;
  };
  const cs = collect(c);
  const ms = collect(m);
  if (!Object.keys(cs).length || !Object.keys(ms).length) return [];

  const out: string[] = [];
  const differs = (k: string) => cs[k] !== undefined && ms[k] !== undefined && cs[k] !== ms[k];
  const fontChanged = differs("fontName") || differs("fontSize") || differs("fontWeight");
  if (fontChanged) out.push("fontFamily", "fontPostScriptName", "fontSize", "fontWeight");
  // italic flips with the font style name (plugin encodes it in fontStyle)
  const italic = (t: any): string => {
    try {
      const segs = t.getStyledTextSegments(["fontName"]) as any[];
      return JSON.stringify([...new Set(segs.map((s) => String(s.fontName?.style ?? "").includes("Italic")))]);
    } catch {
      return "";
    }
  };
  if (italic(c) !== italic(m) && fontChanged) out.push("italic");
  if (differs("letterSpacing")) out.push("letterSpacing");
  if (differs("lineHeight")) {
    out.push("lineHeightPx", "lineHeightPercent", "lineHeightPercentFontSize", "lineHeightUnit");
  }
  if (differs("fills")) out.push("fills");
  return out;
}

// ---------------------------------------------------------------------------
// characterStyleOverrides + styleOverrideTable (the hard one)
// ---------------------------------------------------------------------------

export interface SegmentInput {
  start: number; // inclusive, UTF-16 code units
  end: number; // exclusive
  style: Record<string, unknown>; // full TypeStyle of this range
}

export interface TextOverrides {
  /** Default TypeStyle (index 0) — REST emits this as `style`. */
  style: Record<string, unknown>;
  /** One integer per character, trailing zeros trimmed (REST convention). */
  characterStyleOverrides: number[];
  /** Deduplicated partial TypeStyles; keys are stringified integers. */
  styleOverrideTable: Record<string, Record<string, unknown>>;
}

/** The font-identity fields REST keeps together in override entries. */
const FONT_KEYS = ["fontFamily", "fontPostScriptName", "fontStyle", "fontWeight"] as const;

/**
 * Only the keys where `segment` differs from `default`.
 *
 * Font identity travels as a group (measured from REST payloads): when any
 * of fontFamily/fontPostScriptName/fontStyle/fontWeight differs, all four
 * appear in the override entry even if some are unchanged.
 */
function styleDelta(defaultStyle: Record<string, unknown>, segment: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const k of Object.keys(segment)) {
    if (!deepEqual(segment[k], defaultStyle[k])) delta[k] = segment[k];
  }
  if (FONT_KEYS.some((k) => k in delta)) {
    for (const k of FONT_KEYS) {
      if (k in segment && !(k in delta)) delta[k] = segment[k];
    }
  }
  return delta;
}

/**
 * Build the REST per-character override structures from styled-text
 * segments. UTF-16 semantics match REST exactly (surrogate pairs count as
 * 2 — do not "fix" this). Trailing zeros in characterStyleOverrides are
 * trimmed, exactly like REST.
 */
export function buildTextOverrides(characters: string, segments: SegmentInput[]): TextOverrides {
  if (!segments.length) {
    return { style: {}, characterStyleOverrides: [], styleOverrideTable: {} };
  }

  const overrides = new Array<number>(characters.length).fill(0);
  const table: Record<string, Record<string, unknown>> = {};
  // REST publishes the default style WITHOUT fills (0/523 real payloads
  // have fills in `style`) while override deltas DO carry them — so the
  // delta baseline keeps fills, the published style drops them.
  const defaultFull = segments[0].style;
  const style: Record<string, unknown> = { ...defaultFull };
  delete style.fills;
  let nextId = 1;

  for (const seg of segments) {
    if (deepEqual(seg.style, defaultFull)) continue; // 0 = default
    const delta = styleDelta(defaultFull, seg.style);
    if (!Object.keys(delta).length) continue;

    // Dedup: identical deltas share one table entry.
    let id: string | undefined;
    for (const k of Object.keys(table)) {
      if (deepEqual(table[k], delta)) {
        id = k;
        break;
      }
    }
    if (id === undefined) {
      id = String(nextId++);
      table[id] = delta;
    }

    for (let i = seg.start; i < seg.end && i < characters.length; i++) {
      overrides[i] = Number(id);
    }
  }

  // REST trims trailing zeros — characters beyond the array use the default.
  while (overrides.length > 0 && overrides[overrides.length - 1] === 0) overrides.pop();

  return { style, characterStyleOverrides: overrides, styleOverrideTable: table };
}
