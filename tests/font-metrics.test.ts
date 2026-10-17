/**
 * Unit tests for the Round 2 font-metrics rewriter (lib/font-metrics.ts).
 */
import { describe, expect, it } from "vitest";
import { parseFontMetricsTable, rewriteFontMetrics } from "../lib/font-metrics.js";

const TABLE = parseFontMetricsTable({
  lineHeightMultipliers: { Inter: 1.2102272510528564, "SF Pro Text": 1.193359375 },
  postScriptNames: { "SF Pro Text/Semibold": "SFProText-Semibold", "Inter/Medium": "Inter-Medium" },
})!;

function textNode(style: Record<string, any>, styleOverrideTable?: Record<string, any>) {
  return { id: "1:2", type: "TEXT", style, ...(styleOverrideTable ? { styleOverrideTable } : {}) };
}

function frame(...nodes: any[]) {
  return { id: "0:1", type: "FRAME", children: nodes };
}

describe("parseFontMetricsTable", () => {
  it("accepts a valid table", () => {
    expect(TABLE).not.toBeNull();
    expect(TABLE.lineHeightMultipliers["Inter"]).toBeCloseTo(1.2102272510528564);
  });
  it("rejects malformed tables", () => {
    expect(parseFontMetricsTable(null)).toBeNull();
    expect(parseFontMetricsTable({})).toBeNull();
    expect(parseFontMetricsTable({ lineHeightMultipliers: {} })).toBeNull();
  });
});

describe("INTRINSIC lineHeightPx (C1)", () => {
  it("replaces the plugin's estimate with multiplier × fontSize", () => {
    const n = textNode({ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeightUnit: "INTRINSIC_%", lineHeightPx: 18 });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.lineHeightPx).toBeCloseTo(1.2102272510528564 * 14, 10);
  });
  it("adds lineHeightPx on fixed-height texts where the plugin omitted it (deviation #19)", () => {
    const n = textNode({ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeightUnit: "INTRINSIC_%" });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.lineHeightPx).toBeCloseTo(1.2102272510528564 * 14, 10);
  });
  it("falls back to the base style's family/size for styleOverrideTable entries", () => {
    const sot: Record<string, Record<string, any>> = { 1: { lineHeightUnit: "INTRINSIC_%" } };
    const n = textNode(
      { fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeightUnit: "PIXELS", lineHeightPx: 18 },
      sot,
    );
    rewriteFontMetrics(frame(n), TABLE);
    expect(sot[1].lineHeightPx).toBeCloseTo(1.2102272510528564 * 14, 10);
  });
  it("leaves unknown families untouched", () => {
    const n = textNode({ fontFamily: "Mystery", fontSize: 14, lineHeightUnit: "INTRINSIC_%", lineHeightPx: 18 });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.lineHeightPx).toBe(18);
  });
  it("does not touch PIXELS line heights' px value", () => {
    const n = textNode({ fontFamily: "Inter", fontSize: 14, lineHeightUnit: "PIXELS", lineHeightPx: 18 });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.lineHeightPx).toBe(18);
  });
});

describe("PIXELS lineHeightPercent (C3)", () => {
  it("computes px ÷ intrinsic × 100", () => {
    const n = textNode({ fontFamily: "Inter", fontSize: 14, lineHeightUnit: "PIXELS", lineHeightPx: 18 });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.lineHeightPercent).toBeCloseTo((18 / (1.2102272510528564 * 14)) * 100, 8);
  });
  it("uses the entry's own px/size when present", () => {
    const sot: Record<string, Record<string, any>> = { 2: { lineHeightUnit: "PIXELS", lineHeightPx: 20, fontSize: 10 } };
    const n = textNode(
      { fontFamily: "Inter", fontSize: 14, lineHeightUnit: "PIXELS", lineHeightPx: 18 },
      sot,
    );
    rewriteFontMetrics(frame(n), TABLE);
    expect(sot[2].lineHeightPercent).toBeCloseTo((20 / (1.2102272510528564 * 10)) * 100, 8);
  });
  it("skips entries without a px value", () => {
    const sot: Record<string, Record<string, any>> = { 3: { lineHeightUnit: "PIXELS" } };
    const n = textNode(
      { fontFamily: "Inter", fontSize: 14, lineHeightUnit: "PIXELS", lineHeightPx: 18 },
      sot,
    );
    rewriteFontMetrics(frame(n), TABLE);
    expect(sot[3].lineHeightPercent).toBeUndefined();
  });
});

describe("fontPostScriptName (C4)", () => {
  it("replaces null on node styles when the corpus names the combo", () => {
    const n = textNode({ fontFamily: "SF Pro Text", fontStyle: "Semibold", fontPostScriptName: null });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.fontPostScriptName).toBe("SFProText-Semibold");
  });
  it("keeps null for combos REST reports null for", () => {
    const n = textNode({ fontFamily: "Inter", fontStyle: "Regular", fontPostScriptName: null });
    rewriteFontMetrics(frame(n), TABLE);
    expect(n.style.fontPostScriptName).toBeNull();
  });
  it("adds name-or-null on SOT entries that carry a fontFamily delta (FONT_KEYS group)", () => {
    const sot: Record<string, Record<string, any>> = {
      1: { fontFamily: "Inter", fontStyle: "Medium" },
      2: { fontFamily: "Inter" }, // style falls back to the base
      3: { fontSize: 20 }, // no fontFamily → REST emits no psName here
    };
    const n = textNode({ fontFamily: "Inter", fontStyle: "Regular", fontPostScriptName: null }, sot);
    rewriteFontMetrics(frame(n), TABLE);
    expect(sot[1].fontPostScriptName).toBe("Inter-Medium");
    expect(sot[2].fontPostScriptName).toBeNull();
    expect(sot[3].fontPostScriptName).toBeUndefined();
  });
});

describe("structure", () => {
  it("walks nested children and skips non-text nodes", () => {
    const t = textNode({ fontFamily: "Inter", fontSize: 14, lineHeightUnit: "INTRINSIC_%" });
    const f = { id: "0:1", type: "FRAME", children: [{ id: "0:9", type: "GROUP", children: [t, { id: "0:8", type: "RECTANGLE" }] }] };
    rewriteFontMetrics(f, TABLE);
    expect(t.style.lineHeightPx).toBeCloseTo(1.2102272510528564 * 14, 10);
  });
});
