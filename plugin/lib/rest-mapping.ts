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
        gradientStops: (paint.gradientStops ?? []).map((s) => ({
          position: s.position,
          color: mapColor(s.color, s.color.a ?? 1),
        })),
      };
    }

    case "IMAGE": {
      const img = paint as unknown as {
        scaleMode?: string;
        imageRef?: string | null;
        imageTransform?: unknown;
        scalingFactor?: number;
        rotation?: number;
        filters?: unknown;
      };
      // Plugin "CROP" is REST "STRETCH" (same UI mode, different names).
      const scaleMode = img.scaleMode === "CROP" ? "STRETCH" : img.scaleMode;
      return omitEmpty({
        ...base,
        type: "IMAGE",
        scaleMode,
        imageRef: img.imageRef ?? undefined,
        imageTransform: scaleMode === "STRETCH" ? img.imageTransform : undefined,
        scalingFactor: scaleMode === "TILE" ? img.scalingFactor : undefined,
        rotation: img.rotation,
        filters: img.filters,
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
        out.push(
          omitEmpty({
            type: e.type,
            color: mapColor(color, color.a ?? 1),
            blendMode: (eff.blendMode as string) ?? "NORMAL",
            offset: eff.offset ? { x: (eff.offset as any).x, y: (eff.offset as any).y } : { x: 0, y: 0 },
            radius: eff.radius as number,
            spread: eff.spread as number | undefined,
            visible: eff.visible !== false,
            showShadowBehindNode: eff.showShadowBehindNode === true,
          }),
        );
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

/** REST line height: lineHeightPx / lineHeightPercent / lineHeightUnit. */
export function mapLineHeight(lh: LineHeight | undefined): Record<string, unknown> {
  if (!lh) return {};
  if (lh.unit === "PIXELS") return { lineHeightPx: lh.value, lineHeightUnit: "PIXELS" };
  if (lh.unit === "AUTO") return { lineHeightUnit: "INTRINSIC_%", lineHeightPercent: 100 };
  return {};
}

/** Build a REST TypeStyle object from a de-mixed style source. */
export function buildTypeStyle(s: StyleSource): Record<string, unknown> {
  return omitEmpty({
    fontFamily: s.fontFamily,
    fontPostScriptName: s.fontFamily && s.fontStyle ? fontPostScriptName(s.fontFamily, s.fontStyle) : undefined,
    fontStyle: s.fontStyle,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    textAlignHorizontal: s.textAlignHorizontal,
    textAlignVertical: s.textAlignVertical,
    letterSpacing: mapLetterSpacing(s.letterSpacing, s.fontSize),
    ...mapLineHeight(s.lineHeight),
    textCase: s.textCase,
    textDecoration: s.textDecoration,
    italic: s.fontStyle?.toLowerCase().includes("italic") ? true : undefined,
    paragraphSpacing: s.paragraphSpacing,
    paragraphIndent: s.paragraphIndent,
    fills: s.fills ? mapPaints(s.fills) : undefined,
  });
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

/** Only the keys where `segment` differs from `default`. */
function styleDelta(defaultStyle: Record<string, unknown>, segment: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const k of Object.keys(segment)) {
    if (!deepEqual(segment[k], defaultStyle[k])) delta[k] = segment[k];
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
  const defaultStyle = segments[0].style;
  let nextId = 1;

  for (const seg of segments) {
    if (deepEqual(seg.style, defaultStyle)) continue; // 0 = default
    const delta = styleDelta(defaultStyle, seg.style);
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

  return { style: defaultStyle, characterStyleOverrides: overrides, styleOverrideTable: table };
}
