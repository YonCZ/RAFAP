/**
 * Unit tests for the pure REST-mapping helpers (agent.md §13 Step 5,
 * including the 8 text edge cases from §7.3.8).
 */
import { describe, expect, it } from "vitest";
import {
  buildTextOverrides,
  buildTypeStyle,
  deepEqual,
  detectOverrideFields,
  flatMainKey,
  fontPostScriptName,
  mainRelativeId,
  mapConstraints,
  mapEffects,
  mapLetterSpacing,
  mapLineHeight,
  mapPaint,
  omitEmpty,
} from "../plugin/lib/rest-mapping";

describe("omitEmpty (Rule B2)", () => {
  it("strips undefined and null, keeps everything else", () => {
    expect(omitEmpty({ a: 1, b: undefined, c: null, d: 0, e: false })).toEqual({ a: 1, d: 0, e: false });
  });
  it("never invents null placeholders", () => {
    expect(Object.values(omitEmpty({ x: null }))).toHaveLength(0);
  });
});

describe("deepEqual", () => {
  it("compares structures", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe("mapPaint", () => {
  it("SOLID → REST shape with float color, opacity only when != 1", () => {
    expect(
      mapPaint({ type: "SOLID", color: { r: 0.5, g: 1, b: 0 }, visible: true } as any),
    ).toEqual({ type: "SOLID", color: { r: 0.5, g: 1, b: 0, a: 1 }, blendMode: "NORMAL" });
    expect(
      mapPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.5 } as any),
    ).toEqual({ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5, blendMode: "NORMAL" });
  });

  it("hidden paint keeps visible: false", () => {
    expect(mapPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: false } as any).visible).toBe(false);
  });

  it("gradients map handles and stops with alpha", () => {
    const p = mapPaint({
      type: "GRADIENT_LINEAR",
      gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } }, { position: 1, color: { r: 0, g: 1, b: 0 } }],
    } as any);
    expect(p.gradientStops).toEqual([
      { position: 0, color: { r: 1, g: 0, b: 0, a: 0.5 } },
      { position: 1, color: { r: 0, g: 1, b: 0, a: 1 } },
    ]);
  });

  it("plugin CROP scaleMode maps to REST STRETCH", () => {
    expect(mapPaint({ type: "IMAGE", scaleMode: "CROP", imageRef: "abc" } as any)).toMatchObject({
      type: "IMAGE",
      scaleMode: "STRETCH",
      imageRef: "abc",
    });
  });

  it("image filters: all-default filters are omitted entirely", () => {
    const p = mapPaint({
      type: "IMAGE",
      scaleMode: "FILL",
      imageHash: "abc",
      filters: { contrast: 0, exposure: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
    } as any);
    expect(p.filters).toBeUndefined();
  });

  it("image filters: zero-valued keys are dropped, adjusted keys kept (R7.4)", () => {
    const p = mapPaint({
      type: "IMAGE",
      scaleMode: "FILL",
      imageHash: "abc",
      filters: {
        contrast: 0,
        exposure: 0.2118644118309021,
        saturation: -1,
        temperature: 0,
        tint: 0,
        highlights: 0.26271185278892517,
        shadows: 0.19491524994373322,
      },
    } as any);
    // exactly REST's emission for the measured Positivus fills
    expect(p.filters).toEqual({
      exposure: 0.2118644118309021,
      saturation: -1,
      highlights: 0.26271185278892517,
      shadows: 0.19491524994373322,
    });
  });

  it("unknown paint types pass through (Rule B4)", () => {
    expect(mapPaint({ type: "VIDEO" } as any)).toMatchObject({ type: "VIDEO" });
  });
});

describe("mapEffects", () => {
  it("drop shadows carry color, offset, spread, showShadowBehindNode", () => {
    const [e] = mapEffects([
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 2, visible: true },
    ] as any);
    expect(e).toMatchObject({
      type: "DROP_SHADOW",
      color: { r: 0, g: 0, b: 0, a: 0.25 },
      offset: { x: 0, y: 4 },
      radius: 8,
      spread: 2,
      showShadowBehindNode: false,
    });
  });

  it("blurs are type/visible/radius only", () => {
    const [e] = mapEffects([{ type: "BACKGROUND_BLUR", radius: 4, visible: true }] as any);
    expect(e).toEqual({ type: "BACKGROUND_BLUR", visible: true, radius: 4 });
  });

  it("invisible effects are kept with visible: false (REST behaviour)", () => {
    const [e] = mapEffects([{ type: "LAYER_BLUR", radius: 4, visible: false }] as any);
    expect(e.visible).toBe(false);
  });
});

describe("TypeStyle building", () => {
  it("fontPostScriptName composes family + style (kept for _figmaAgent diagnostics)", () => {
    expect(fontPostScriptName("Inter", "Semi Bold")).toBe("Inter-SemiBold");
    expect(fontPostScriptName("Source Sans Pro", "Regular")).toBe("SourceSansPro-Regular");
  });

  it("letterSpacing: PIXELS passes through, PERCENT resolves via fontSize", () => {
    expect(mapLetterSpacing({ unit: "PIXELS", value: 1.5 }, 16)).toBe(1.5);
    expect(mapLetterSpacing({ unit: "PERCENT", value: 2 }, 16)).toBe(0.32);
    expect(mapLetterSpacing(undefined, 16)).toBeUndefined();
  });

  it("lineHeight: PIXELS and AUTO map to REST units", () => {
    expect(mapLineHeight({ unit: "PIXELS", value: 24 }, 16)).toEqual({
      lineHeightPx: 24,
      lineHeightUnit: "PIXELS",
      lineHeightPercentFontSize: 150,
    });
    expect(mapLineHeight({ unit: "AUTO" })).toEqual({ lineHeightUnit: "INTRINSIC_%", lineHeightPercent: 100 });
    expect(mapLineHeight({ unit: "AUTO" }, undefined, 29.0454)).toEqual({
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPercent: 100,
      lineHeightPx: 29.0454,
    });
    expect(mapLineHeight(undefined)).toEqual({});
  });

  it("fontPostScriptName is always present and null (measured REST rule); no italic field", () => {
    const s = buildTypeStyle({ fontFamily: "Inter", fontStyle: "Italic" });
    expect(s.fontPostScriptName).toBeNull();
    expect(s.italic).toBeUndefined();
  });

  it("letterSpacing always emits (0 when unset); default-valued text props are omitted", () => {
    const s = buildTypeStyle({
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontWeight: 400,
      fontSize: 16,
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
    });
    expect(s.letterSpacing).toBe(0);
    expect(s.textCase).toBeUndefined();
    expect(s.textDecoration).toBeUndefined();
    expect(s.paragraphSpacing).toBeUndefined();
    expect(s.fills).toBeUndefined();
  });

  it("fills ride along only in segment styles (override deltas), never the published style", () => {
    const fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] as unknown as Paint[];
    const published = buildTypeStyle({ fontFamily: "Inter", fontSize: 12, fills });
    expect(published.fills).toBeUndefined();
    const segment = buildTypeStyle({ fontFamily: "Inter", fontSize: 12, fills, includeFills: true });
    expect(Array.isArray(segment.fills)).toBe(true);
  });
});

describe("constraints mapping", () => {
  it("plugin MIN/MAX/STRETCH become REST LEFT/RIGHT/LEFT_RIGHT", () => {
    expect(mapConstraints({ horizontal: "MIN", vertical: "MIN" })).toEqual({ horizontal: "LEFT", vertical: "TOP" });
    expect(mapConstraints({ horizontal: "MAX", vertical: "MAX" })).toEqual({ horizontal: "RIGHT", vertical: "BOTTOM" });
    expect(mapConstraints({ horizontal: "STRETCH", vertical: "STRETCH" })).toEqual({
      horizontal: "LEFT_RIGHT",
      vertical: "TOP_BOTTOM",
    });
    expect(mapConstraints({ horizontal: "CENTER", vertical: "SCALE" })).toEqual({ horizontal: "CENTER", vertical: "SCALE" });
  });
});

// ---------------------------------------------------------------------------
// characterStyleOverrides + styleOverrideTable — the 8 edge cases (§7.3.8)
// ---------------------------------------------------------------------------

const style = (over: Record<string, unknown>) => ({ fontFamily: "Inter", fontWeight: 400, fontSize: 14, ...over });

describe("buildTextOverrides", () => {
  it("1. empty text / no segments → empty arrays, no crash", () => {
    expect(buildTextOverrides("", [])).toEqual({ style: {}, characterStyleOverrides: [], styleOverrideTable: {} });
  });

  it("2. single uniform style → all zeros (trimmed to empty), empty table", () => {
    const r = buildTextOverrides("Hello", [{ start: 0, end: 5, style: style({}) }]);
    expect(r.characterStyleOverrides).toEqual([]);
    expect(r.styleOverrideTable).toEqual({});
    expect(r.style).toEqual(style({}));
  });

  it("3. an override identical to the default stays 0 — no table entry allocated", () => {
    const r = buildTextOverrides("Hello World", [
      { start: 0, end: 5, style: style({}) },
      { start: 5, end: 11, style: style({}) }, // identical
    ]);
    expect(r.characterStyleOverrides).toEqual([]);
    expect(r.styleOverrideTable).toEqual({});
  });

  it("4. two segments with identical deltas share ONE table entry", () => {
    const bold = style({ fontWeight: 700 });
    const r = buildTextOverrides("abcXYZabc", [
      { start: 0, end: 3, style: style({}) },
      { start: 3, end: 6, style: bold },
      { start: 6, end: 9, style: bold }, // same delta again
    ]);
    expect(Object.keys(r.styleOverrideTable)).toHaveLength(1);
    expect(r.characterStyleOverrides).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]);
    // delta only — font identity travels as a group (measured REST rule)
    expect(r.styleOverrideTable["1"]).toEqual({ fontFamily: "Inter", fontWeight: 700 });
  });

  it("5. segment end beyond characters.length is clamped, never out of bounds", () => {
    const r = buildTextOverrides("abc", [
      { start: 0, end: 3, style: style({}) },
      { start: 2, end: 99, style: style({ fontWeight: 700 }) }, // end clamps to 3
    ]);
    expect(r.characterStyleOverrides).toEqual([0, 0, 1]); // index 2 only, no crash
    // a segment entirely beyond the string writes nothing at all
    const empty = buildTextOverrides("ab", [
      { start: 0, end: 2, style: style({}) },
      { start: 2, end: 99, style: style({ fontWeight: 700 }) },
    ]);
    expect(empty.characterStyleOverrides).toEqual([]); // trailing zeros trimmed
  });

  it("6b. range-bound style ids ride on the delta as inherit fields (Round 6, #21)", () => {
    const bold = style({ fontWeight: 700 });
    const r = buildTextOverrides("abcXYZ", [
      { start: 0, end: 3, style: style({}) },
      {
        start: 3,
        end: 6,
        style: bold,
        inheritFillStyleId: "S:hash,209:24",
        inheritTextStyleId: "S:hash,109:75",
      },
    ]);
    expect(r.styleOverrideTable["1"].inheritFillStyleId).toBe("S:hash,209:24");
    expect(r.styleOverrideTable["1"].inheritTextStyleId).toBe("S:hash,109:75");
    // the default range's binding is never emitted (REST-invisible)
    const base = buildTextOverrides("abcXYZ", [
      { start: 0, end: 3, style: style({}), inheritFillStyleId: "S:hash,209:141" },
      { start: 3, end: 6, style: bold },
    ]);
    expect(base.styleOverrideTable["1"].inheritFillStyleId).toBeUndefined();
    expect(base.style.inheritFillStyleId).toBeUndefined();
    // identical deltas but distinct bindings never dedup onto one entry
    const r2 = buildTextOverrides("abcXYZdef", [
      { start: 0, end: 3, style: style({}) },
      { start: 3, end: 6, style: bold, inheritFillStyleId: "S:hash,209:24" },
      { start: 6, end: 9, style: bold, inheritFillStyleId: "S:hash,209:99" },
    ]);
    expect(Object.keys(r2.styleOverrideTable)).toHaveLength(2);
    // a binding-only difference from the default stays cso 0 — the
    // default's own binding is REST-invisible (corpus: no such range)
    const r3 = buildTextOverrides("abcXYZ", [
      { start: 0, end: 3, style: style({}) },
      { start: 3, end: 6, style: style({}), inheritFillStyleId: "S:hash,209:24" },
    ]);
    expect(r3.styleOverrideTable).toEqual({});
  });

  it("6. trailing zeros are trimmed (REST convention)", () => {
    const r = buildTextOverrides("aXYb", [
      { start: 0, end: 1, style: style({}) },
      { start: 1, end: 3, style: style({ fontWeight: 700 }) },
      { start: 3, end: 4, style: style({}) },
    ]);
    expect(r.characterStyleOverrides).toEqual([0, 1, 1]); // trailing 0 gone
  });

  it("7. UTF-16 semantics: an emoji counts as 2 code units, like REST", () => {
    // "👍!" — the emoji is 2 UTF-16 units, so indices: 0,1 emoji, 2 '!'
    const r = buildTextOverrides("👍!", [
      { start: 0, end: 2, style: style({}) },
      { start: 2, end: 3, style: style({ fontWeight: 700 }) },
    ]);
    expect(r.characterStyleOverrides).toEqual([0, 0, 1]);
  });

  it("8. table entries are DELTAS against the default style, font keys grouped", () => {
    const r = buildTextOverrides("ab", [
      { start: 0, end: 1, style: style({}) },
      { start: 1, end: 2, style: style({ fontSize: 28, fontWeight: 700 }) },
    ]);
    // fontWeight differing pulls in the whole font-identity group
    expect(r.styleOverrideTable["1"]).toEqual({ fontFamily: "Inter", fontSize: 28, fontWeight: 700 });
  });
});

// ---------------------------------------------------------------------------
// Round 1 — instance-child ↔ main correspondence + override detection
// ---------------------------------------------------------------------------

describe("mainRelativeId", () => {
  it("strips the top-instance prefix", () => {
    expect(mainRelativeId("147:350", "I147:350;66:419")).toBe("66:419");
  });
  it("resolves nested-instance descendants via the nested instance's full id", () => {
    expect(mainRelativeId("I180:321;6:1803", "I180:321;6:1803;267:5340")).toBe("267:5340");
  });
  it("resolves the same node via the TOP instance with the full flat path", () => {
    expect(mainRelativeId("180:321", "I180:321;6:1803;267:5340")).toBe("6:1803;267:5340");
  });
  it("returns null for non-descendants and the instance itself", () => {
    expect(mainRelativeId("180:321", "180:321")).toBeNull();
    expect(mainRelativeId("180:321", "I999:1;5:2")).toBeNull();
    expect(mainRelativeId("180:321", "5:2")).toBeNull();
  });
});

describe("flatMainKey", () => {
  it("passes plain ids through", () => {
    expect(flatMainKey("5:2")).toBe("5:2");
    expect(flatMainKey("6:1803")).toBe("6:1803");
  });
  it("strips the inner I of nested-instance children walked from the main", () => {
    expect(flatMainKey("I6:1803;267:5340")).toBe("6:1803;267:5340");
    expect(flatMainKey("I6:1803;I7:2;5:9")).toBe("6:1803;7:2;5:9");
  });
});

describe("detectOverrideFields", () => {
  const base = { type: "FRAME", name: "Card", width: 100, height: 50, fills: [], strokes: [] };
  it("fires nothing when identical", () => {
    expect(detectOverrideFields(base, { ...base })).toEqual([]);
  });
  it("detects name and size separately", () => {
    expect(detectOverrideFields({ ...base, name: "Renamed" }, base)).toEqual(["name"]);
    expect(detectOverrideFields({ ...base, width: 120 }, base)).toEqual(["width"]);
    expect(detectOverrideFields({ ...base, height: 80 }, base)).toEqual(["height"]);
  });
  it("detects fills/strokes by raw JSON and style ids via styleIdValue", () => {
    expect(detectOverrideFields({ ...base, fills: [{ type: "SOLID" }] }, base)).toEqual(["fills"]);
    expect(detectOverrideFields({ ...base, strokes: [{ type: "SOLID" }] }, base)).toEqual(["strokes"]);
    expect(detectOverrideFields({ ...base, fillStyleId: "S:abc,1:2" }, base)).toEqual([
      "inheritFillStyleId",
    ]);
    // "" (unbound) and undefined are equal — no false fire
    expect(detectOverrideFields({ ...base, fillStyleId: "" }, { ...base })).toEqual([]);
  });
  it("corner radii fire per-corner and uniform (both sides must expose the prop)", () => {
    const radii = { topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0 };
    expect(detectOverrideFields({ ...base, ...radii, cornerRadius: 8 }, { ...base, ...radii, cornerRadius: 0 })).toEqual(["cornerRadius"]);
    expect(detectOverrideFields({ ...base, ...radii, topLeftRadius: 4 }, { ...base, ...radii })).toEqual(["topLeftRadius"]);
    // VECTOR mains expose no cornerRadius — nothing to compare, no false fire
    expect(detectOverrideFields({ ...base, cornerRadius: 8 }, base)).toEqual([]);
  });
  it("auto-layout overrides only compared when both lay out", () => {
    const al = { ...base, layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED" };
    expect(detectOverrideFields({ ...al, primaryAxisSizingMode: "AUTO" }, al)).toEqual([
      "primaryAxisSizingMode",
    ]);
    expect(detectOverrideFields({ ...base, primaryAxisSizingMode: "AUTO" }, base)).toEqual([]);
  });
  it("auto-scale cascade: size diffs matching the owning instance's ratio are suppressed", () => {
    const mainChild = { ...base, width: 18, height: 10 };
    const scaledChild = { ...base, width: 24, height: 13.333333015441895 }; // 1.3333× of main
    const scale = { x: 32 / 24, y: 32 / 24 }; // the owning instance's resize ratio
    expect(detectOverrideFields(scaledChild, mainChild, scale)).toEqual([]);
    // a real override on top of the cascade still fires
    expect(detectOverrideFields({ ...scaledChild, width: 30 }, mainChild, scale)).toEqual(["width"]);
    // without scale context the diff fires (conservative)
    expect(detectOverrideFields(scaledChild, mainChild)).toEqual(["height", "width"]);
  });

  it("reactions: differing prototype reactions fire REST's legacy transition group", () => {
    const nav = [{ action: { type: "NODE", destinationId: "7:1" }, trigger: { type: "ON_CLICK" } }];
    const c = { ...base, reactions: nav };
    const m = { ...base, reactions: [] };
    expect(detectOverrideFields(c, m)).toEqual(["transitionDuration", "transitionEasing", "transitionNodeID"]);
    expect(detectOverrideFields({ ...base, reactions: [] }, { ...base, reactions: [] })).toEqual([]);
  });

  it("TEXT: characters fire as 'text' and font changes fire as a group", () => {
    const segs = (fontName: string, size: number, weight: number) => () => [
      { fontName: { family: "Inter", style: fontName }, fontSize: size, fontWeight: weight },
    ];
    const c = {
      type: "TEXT",
      characters: "Hello",
      getStyledTextSegments: segs("Semi Bold", 16, 600),
    };
    const m = {
      type: "TEXT",
      characters: "Hello",
      getStyledTextSegments: segs("Regular", 16, 400),
    };
    expect(detectOverrideFields(c, m)).toEqual([
      "fontFamily",
      "fontPostScriptName",
      "fontSize",
      "fontWeight",
    ]);
    expect(detectOverrideFields({ ...c, characters: "Hi" }, m)).toEqual([
      "fontFamily",
      "fontPostScriptName",
      "fontSize",
      "fontWeight",
      "text",
    ]);
  });
});
