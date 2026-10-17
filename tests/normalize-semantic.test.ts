/**
 * Unit tests for the E2 semantic text-model canonicalization
 * (tools/normalize.ts — canonicalizeTextModel / semanticize).
 */
import { describe, expect, it } from "vitest";
import { canonicalizeTextModel, semanticize } from "../tools/normalize.js";

function textNode(fields: Record<string, any>): Record<string, any> {
  return { id: "1:2", type: "TEXT", name: "t", characters: "", ...fields };
}

describe("canonicalizeTextModel", () => {
  it("re-encodes both base choices to one canonical form (the 180:316 pattern)", () => {
    // Same rendered text "AB" where char 0 is Regular and char 1 is Semi Bold.
    // REST picks the Semi Bold segment as base; we pick the first segment.
    const rest = textNode({
      characters: "AB",
      style: { fontFamily: "Inter", fontStyle: "Semi Bold", fontWeight: 600 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0.5, b: 0 } }],
      characterStyleOverrides: [1, 0],
      styleOverrideTable: { 1: { fontStyle: "Regular", fontWeight: 400, fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }] } },
    });
    const ours = textNode({
      characters: "AB",
      style: { fontFamily: "Inter", fontStyle: "Regular", fontWeight: 400 },
      fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }],
      characterStyleOverrides: [0, 1],
      styleOverrideTable: { 1: { fontStyle: "Semi Bold", fontWeight: 600, fills: [{ type: "SOLID", color: { r: 0, g: 0.5, b: 0 } }] } },
    });
    canonicalizeTextModel(rest);
    canonicalizeTextModel(ours);
    expect(ours).toEqual(rest);
    // canonical base = char 0's resolved style
    expect(rest.style).toEqual({ fontFamily: "Inter", fontStyle: "Regular", fontWeight: 400 });
    expect(rest.fills).toEqual([{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }]);
    expect(rest.characterStyleOverrides).toEqual([0, 1]);
  });

  it("drops unreferenced stored table entries (the 180:338 pattern)", () => {
    const n = textNode({
      characters: "Hi",
      style: { fontFamily: "Inter", fontStyle: "Regular" },
      fills: [],
      characterStyleOverrides: [],
      styleOverrideTable: { 1: { lineHeightUnit: "PIXELS", lineHeightPx: 16 } }, // no char uses slot 1
    });
    canonicalizeTextModel(n);
    expect(n.styleOverrideTable).toBeUndefined();
  });

  it("drops the phantom lineHeightPercentFontSize on INTRINSIC segments", () => {
    // Our PIXELS base leaks lineHeightPercentFontSize through the delta merge
    // onto the INTRINSIC segment; REST's INTRINSIC base carries none.
    const n = textNode({
      characters: "AB",
      style: { fontFamily: "Inter", lineHeightUnit: "PIXELS", lineHeightPx: 16, lineHeightPercentFontSize: 133.3333 },
      characterStyleOverrides: [0, 1],
      styleOverrideTable: { 1: { lineHeightUnit: "INTRINSIC_%", lineHeightPx: 14.5227, lineHeightPercent: 100 } },
    });
    canonicalizeTextModel(n);
    expect(n.style.lineHeightUnit).toBe("PIXELS");
    expect(n.styleOverrideTable[1]).toEqual({
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPx: 14.5227,
      lineHeightPercent: 100,
    });
  });

  it("drops plugin-invisible inherit* style ids (#21)", () => {
    const n = textNode({
      characters: "AB",
      style: { fontFamily: "Inter", fontStyle: "Regular" },
      characterStyleOverrides: [0, 1],
      styleOverrideTable: { 1: { inheritFillStyleId: "9:9", inheritTextStyleId: "9:8", fontStyle: "Semi Bold" } },
    });
    canonicalizeTextModel(n);
    expect(n.styleOverrideTable[1]).toEqual({ fontStyle: "Semi Bold" });
  });

  it("folds a stored base that no character uses (the 238:160 pattern)", () => {
    // REST base = Semi Bold typing style; every live character is Regular.
    const rest = textNode({
      characters: "XY",
      style: { fontFamily: "Inter", fontStyle: "Semi Bold", fontWeight: 600 },
      characterStyleOverrides: [1, 2],
      styleOverrideTable: {
        1: { fontStyle: "Regular", fontWeight: 400 },
        2: { fontStyle: "Regular", fontWeight: 400, textDecoration: "UNDERLINE" },
      },
    });
    const ours = textNode({
      characters: "XY",
      style: { fontFamily: "Inter", fontStyle: "Regular", fontWeight: 400 },
      characterStyleOverrides: [0, 1],
      styleOverrideTable: { 1: { textDecoration: "UNDERLINE" } },
    });
    canonicalizeTextModel(rest);
    canonicalizeTextModel(ours);
    expect(ours).toEqual(rest);
    expect(rest.characterStyleOverrides).toEqual([0, 1]);
    expect(rest.styleOverrideTable).toEqual({ 1: { textDecoration: "UNDERLINE" } });
  });

  it("numbers slots by first appearance (canonical base = char 0's resolved style)", () => {
    // char 0 uses slot 5 (Semi Bold) — that becomes the canonical base, and
    // the node's original base style (Regular) becomes delta slot 1.
    const n = textNode({
      characters: "ABCA",
      style: { fontFamily: "Inter", fontStyle: "Regular" },
      characterStyleOverrides: [5, 5, 0, 5],
      styleOverrideTable: { 5: { fontStyle: "Semi Bold" }, 3: { textDecoration: "UNDERLINE" } },
    });
    canonicalizeTextModel(n);
    expect(n.style.fontStyle).toBe("Semi Bold");
    expect(n.characterStyleOverrides).toEqual([0, 0, 1]);
    expect(n.styleOverrideTable).toEqual({ 1: { fontStyle: "Regular" } });
  });

  it("removes empty override structures on uniform texts", () => {
    const n = textNode({
      characters: "ABC",
      style: { fontFamily: "Inter" },
      characterStyleOverrides: [0, 0, 0],
      styleOverrideTable: {},
    });
    canonicalizeTextModel(n);
    expect(n.characterStyleOverrides).toBeUndefined();
    expect(n.styleOverrideTable).toBeUndefined();
  });

  it("leaves non-text nodes alone and walks trees via semanticize", () => {
    const t = textNode({
      characters: "AB",
      style: { fontFamily: "Inter" },
      characterStyleOverrides: [0, 1],
      styleOverrideTable: { 1: { fontStyle: "Bold" } },
    });
    const tree = { id: "0:1", type: "FRAME", children: [{ id: "0:2", type: "RECTANGLE" }, t] };
    semanticize(tree);
    expect(t.styleOverrideTable).toEqual({ 1: { fontStyle: "Bold" } }); // untouched content
    expect(tree.children[0].type).toBe("RECTANGLE");
  });
});
