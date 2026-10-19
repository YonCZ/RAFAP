/**
 * Unit tests for the Round 2 font-metrics rewriter (lib/font-metrics.ts).
 */
import { describe, expect, it } from "vitest";
import {
  mergeFontProbeResult,
  parseFontMetricsTable,
  rewriteFontMetrics,
  robustFontSampleWindow,
  snapToRational,
} from "../lib/font-metrics.js";

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
  it("materializes the inherited lineHeight group on SOT entries whose fontSize differs from the base (R7.4)", () => {
    // Positivus "team card" shape: base 20px, override range 18px, both
    // INTRINSIC — REST's entry carries unit + percent + px = size × mult.
    const sot: Record<string, Record<string, any>> = {
      1: { fontStyle: "Regular", fontWeight: 400, fontSize: 18, fontFamily: "Inter" },
    };
    const n = textNode({
      fontFamily: "Inter",
      fontStyle: "Medium",
      fontWeight: 500,
      fontSize: 20,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPercent: 100,
    }, sot);
    rewriteFontMetrics(frame(n), TABLE);
    expect(sot[1].lineHeightUnit).toBe("INTRINSIC_%");
    expect(sot[1].lineHeightPercent).toBe(100);
    expect(sot[1].lineHeightPx).toBeCloseTo(1.2102272510528564 * 18, 10);
  });
  it("uses the float32 path for exact-rational families in materialized SOT entries (R7.4)", () => {
    const exact = parseFontMetricsTable({
      lineHeightMultipliers: { Inter: INTER_TRUE },
      postScriptNames: {},
      exactRationalFamilies: ["Inter"],
    })!;
    const sot: Record<string, Record<string, any>> = {
      1: { fontStyle: "Regular", fontWeight: 400, fontSize: 20, fontFamily: "Inter" },
    };
    const n = textNode({
      fontFamily: "Inter",
      fontStyle: "Medium",
      fontWeight: 500,
      fontSize: 18,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPercent: 100,
    }, sot);
    rewriteFontMetrics(frame(n), exact);
    expect(sot[1].lineHeightPx).toBe(Math.fround(20 * Math.fround(INTER_TRUE)));
  });
  it("adds nothing when the SOT entry's fontSize equals the base's (corpus shape)", () => {
    const sot: Record<string, Record<string, any>> = {
      1: { fontStyle: "Regular", fontWeight: 400, fontSize: 14, fontFamily: "Inter" },
    };
    const n = textNode({
      fontFamily: "Inter",
      fontStyle: "Semi Bold",
      fontWeight: 600,
      fontSize: 14,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPercent: 100,
    }, sot);
    rewriteFontMetrics(frame(n), TABLE);
    expect("lineHeightPx" in sot[1]).toBe(false);
    expect("lineHeightUnit" in sot[1]).toBe(false);
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

// Round 7 (C2) — probe merging -------------------------------------------------

/** Inter's true multiplier: (ascender+descender+lineGap)/unitsPerEm = 3408/2816. */
const INTER_TRUE = 213 / 176;

function interSamples(n: number, base = 4000): { size: number; linePx: number }[] {
  const out: { size: number; linePx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s = base + i;
    out.push({ size: s, linePx: Math.round(INTER_TRUE * s) });
  }
  return out;
}

/** Like interSamples, but with the real-world large-size layout anomalies
 *  injected: ~1/4 of samples get +1 px on a line, ~1/8 get +0.2 px/line
 *  (a +1 px box anomaly) — all strictly upward, never below the floor. */
function interSamplesWithAnomalies(n: number, base = 30000) {
  const out: { size: number; linePx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s = base + i;
    let linePx = Math.round(INTER_TRUE * s);
    if (i % 4 === 1) linePx += 1;
    if (i % 8 === 3) linePx += 0.2;
    out.push({ size: s, linePx });
  }
  return out;
}

describe("robustFontSampleWindow (R7.1)", () => {
  it("narrows the multiplier window with more samples", () => {
    const w10 = robustFontSampleWindow(interSamples(10))!;
    const w1000 = robustFontSampleWindow(interSamples(1000))!;
    expect(w10.lo).toBeLessThanOrEqual(INTER_TRUE);
    expect(w10.hi).toBeGreaterThanOrEqual(INTER_TRUE);
    expect(w1000.lo).toBeLessThanOrEqual(INTER_TRUE);
    expect(w1000.hi).toBeGreaterThanOrEqual(INTER_TRUE);
    expect(w1000.hi - w1000.lo).toBeLessThan(w10.hi - w10.lo);
  });

  it("survives one-sided upward anomalies and still contains the truth", () => {
    const samples = interSamplesWithAnomalies(600, 50000);
    const w = robustFontSampleWindow(samples)!;
    expect(w.lo).toBeLessThanOrEqual(INTER_TRUE);
    expect(w.hi).toBeGreaterThanOrEqual(INTER_TRUE);
    // the anomalous bounds must be filtered out, not averaged in: the window
    // stays tight (anomalies reach +1.5 px/line ≈ 3e-5 on the multiplier)
    expect(w.hi - w.lo).toBeLessThan(1e-6);
  });

  it("returns null on fewer than 8 samples and on malformed samples", () => {
    expect(robustFontSampleWindow(interSamples(4))).toBeNull();
    expect(robustFontSampleWindow([{ size: 0, linePx: 10 } as any])).toBeNull();
    expect(robustFontSampleWindow([{ size: 100, linePx: NaN } as any])).toBeNull();
    expect(robustFontSampleWindow([null as any])).toBeNull();
  });
});

describe("snapToRational (R7.1)", () => {
  it("recovers the exact rational (Inter = 3408/2816, reduced 213/176)", () => {
    const samples = interSamples(1000, 30000);
    const w = robustFontSampleWindow(samples)!;
    const snapped = snapToRational(w, samples)!;
    expect(snapped.value).toBe(INTER_TRUE);
    expect(snapped.denominator).toBe(176);
  });

  it("recovers the exact rational from anomaly-corrupted samples", () => {
    const samples = interSamplesWithAnomalies(600, 50000);
    const w = robustFontSampleWindow(samples)!;
    const snapped = snapToRational(w, samples)!;
    expect(snapped.value).toBe(INTER_TRUE);
    expect(snapped.denominator).toBe(176);
  });

  it("returns a candidate inside the window within one-sided rounding distance", () => {
    const m = 1.23456789;
    const samples = Array.from({ length: 600 }, (_, i) => ({
      size: 5000 + i,
      linePx: Math.round(m * (5000 + i)),
    }));
    const w = robustFontSampleWindow(samples)!;
    const snapped = snapToRational(w, samples)!;
    expect(snapped.value).toBeGreaterThanOrEqual(w.lo);
    expect(snapped.value).toBeLessThanOrEqual(w.hi);
    for (const s of samples) {
      const e = s.linePx - snapped.value * s.size;
      expect(e).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(e).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });

  it("returns null when no rational fits the window", () => {
    expect(snapToRational({ lo: 2, hi: 3 }, [{ size: 1000, linePx: 5000 }])).toBeNull();
  });
});

describe("mergeFontProbeResult (R7.1)", () => {
  const fresh = () =>
    parseFontMetricsTable({
      lineHeightMultipliers: { Inter: 1.2102272510528564 },
      postScriptNames: {},
    })!;

  it("adds a probe-snapped family as an exact rational and marks it for float32 emulation", () => {
    const table = fresh();
    const samples = interSamples(1000, 30000);
    const report = mergeFontProbeResult(table, {
      fonts: [{ family: "Space Grotesk", style: "Regular", samples }],
    });
    expect(report.rejected).toEqual([]);
    expect(report.added).toHaveLength(1);
    expect(report.added[0].family).toBe("Space Grotesk");
    expect(report.added[0].multiplier).toBe(INTER_TRUE);
    expect(report.added[0].exact).toBe(true);
    expect(table.exactRationalFamilies).toContain("Space Grotesk");
  });

  it("merges all styles of a family into one intersection", () => {
    const table = fresh();
    const report = mergeFontProbeResult(table, {
      fonts: [
        { family: "Space Grotesk", style: "Regular", samples: interSamples(500, 30000) },
        { family: "Space Grotesk", style: "Bold", samples: interSamples(500, 40000) },
      ],
    });
    expect(report.added).toHaveLength(1);
    expect(report.added[0].multiplier).toBe(INTER_TRUE);
    expect(report.added[0].exact).toBe(true);
  });

  it("never overwrites a corpus entry", () => {
    const table = fresh();
    const report = mergeFontProbeResult(table, {
      fonts: [{ family: "Inter", style: "Regular", samples: interSamples(1000, 30000) }],
    });
    expect(report.added).toEqual([]);
    expect(table.lineHeightMultipliers.Inter).toBeCloseTo(1.2102272510528564, 10);
    expect(report.rejected[0].reason).toContain("corpus value kept");
  });

  it("rejects style divergence (metrics differ across styles of a family)", () => {
    const table = fresh();
    // one style at Inter's multiplier, one at a genuinely different one —
    // the divergence guard must catch it even though the window's anomaly
    // filter would silently keep only the lower style
    const other = Array.from({ length: 100 }, (_, i) => ({
      size: 30000 + i,
      linePx: Math.round(1.5 * (30000 + i)),
    }));
    const report = mergeFontProbeResult(table, {
      fonts: [
        { family: "Wonky", style: "Regular", samples: interSamples(100, 30000) },
        { family: "Wonky", style: "Bold", samples: other },
      ],
    });
    expect(report.added).toEqual([]);
    expect("Wonky" in table.lineHeightMultipliers).toBe(false);
    expect(report.rejected[0].reason).toContain("inconsistent");
  });

  it("rejects families whose only samples errored", () => {
    const table = fresh();
    const report = mergeFontProbeResult(table, {
      fonts: [{ family: "Missing", style: "Regular", error: "font not available" }],
    });
    expect(report.added).toEqual([]);
    expect(report.rejected[0].reason).toContain("font not available");
  });

  it("rejects too-imprecise windows, accepts tight uncertified ones as midpoints", () => {
    const table = fresh();
    // 8 samples at ~4000 → window ~1e-5 wide → no certified snap, too wide
    // for the midpoint fallback
    const sparse = mergeFontProbeResult(table, {
      fonts: [{ family: "Sparse", style: "Regular", samples: interSamples(8, 4000) }],
    });
    expect(sparse.added).toEqual([]);
    expect("Sparse" in table.lineHeightMultipliers).toBe(false);
    expect(sparse.rejected[0].reason).toContain("insufficient precision");

    // non-simple multiplier, 600 samples at ~5000 → either a certified snap
    // or a tight midpoint — always within the window of the truth
    const m = 1.23456789;
    const samples = Array.from({ length: 600 }, (_, i) => ({
      size: 5000 + i,
      linePx: Math.round(m * (5000 + i)),
    }));
    const dense = mergeFontProbeResult(table, {
      fonts: [{ family: "Dense", style: "Regular", samples }],
    });
    expect(dense.added).toHaveLength(1);
    expect(Math.abs(dense.added[0].multiplier - m)).toBeLessThan(2e-6);
  });
});

describe("float32 lineHeightPx emulation (R7.1)", () => {
  it("emits REST's exact float32 values for probe-snapped families (golden-anchored)", () => {
    const table = parseFontMetricsTable({
      lineHeightMultipliers: { Inter: INTER_TRUE },
      postScriptNames: {},
      exactRationalFamilies: ["Inter"],
    })!;
    for (const [fontSize, rest] of [
      [12, 14.522727012634277],
      [13, 15.732954025268555],
      [14, 16.94318199157715],
      [20, 24.204544067382812],
      [96, 116.18181610107422],
    ] as [number, number][]) {
      const t = textNode({ fontFamily: "Inter", fontSize, lineHeightUnit: "INTRINSIC_%" });
      rewriteFontMetrics({ id: "0:1", type: "FRAME", children: [t] }, table);
      expect(t.style.lineHeightPx).toBe(rest); // bit-identical to REST
    }
  });

  it("keeps the plain double product for corpus (fit) multipliers", () => {
    const t = textNode({ fontFamily: "Inter", fontSize: 13, lineHeightUnit: "INTRINSIC_%" });
    rewriteFontMetrics({ id: "0:1", type: "FRAME", children: [t] }, TABLE);
    expect(t.style.lineHeightPx).toBe(13 * 1.2102272510528564);
  });
});

// R7.2 — the INTRINSIC lineHeightPx contract as an explicit degradation
// ladder. Everything a consumer can observe, in one place:

describe("degradation ladder (R7.2)", () => {
  const estimate = 16; // the plugin's height ÷ lines estimate

  it("tier 1 — probe-snapped (exact rational) family: bit-exact float32 emulation of REST", () => {
    const exact = parseFontMetricsTable({
      lineHeightMultipliers: { Inter: INTER_TRUE },
      postScriptNames: {},
      exactRationalFamilies: ["Inter"],
    })!;
    const t = textNode({
      fontFamily: "Inter",
      fontSize: 13,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPx: estimate,
    });
    rewriteFontMetrics(frame(t), exact);
    expect(t.style.lineHeightPx).toBe(Math.fround(13 * Math.fround(INTER_TRUE)));
  });

  it("tier 2 — corpus (fit) family: plain double product (never frounded)", () => {
    const t = textNode({
      fontFamily: "Inter",
      fontSize: 13,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPx: estimate,
    });
    rewriteFontMetrics(frame(t), TABLE); // Inter is a corpus entry, not exactRational
    expect(t.style.lineHeightPx).toBe(13 * TABLE.lineHeightMultipliers["Inter"]);
    expect(t.style.lineHeightPx).not.toBe(Math.fround(13 * Math.fround(INTER_TRUE)));
  });

  it("tier 3 — unseen, unprobed family: the plugin's estimate passes through untouched", () => {
    const t = textNode({
      fontFamily: "Mystery Sans",
      fontSize: 13,
      lineHeightUnit: "INTRINSIC_%",
      lineHeightPx: estimate,
    });
    const px = t.style.lineHeightPx;
    rewriteFontMetrics(frame(t), TABLE);
    expect(t.style.lineHeightPx).toBe(px);
    expect(t.style.lineHeightPx).toBe(estimate);
  });

  it("tier 3 — unseen family with no plugin estimate (fixed-height text): stays omitted", () => {
    const t = textNode({ fontFamily: "Mystery Sans", fontSize: 13, lineHeightUnit: "INTRINSIC_%" });
    rewriteFontMetrics(frame(t), TABLE);
    expect("lineHeightPx" in t.style).toBe(false);
  });

  it("no table at all: rewriting is disabled (parseFontMetricsTable(null) → callers skip)", () => {
    expect(parseFontMetricsTable(null)).toBeNull();
    // the bridge guards on this (applyFontMetrics) — a null table must never
    // reach rewriteFontMetrics, and malformed stores parse to null, not garbage
    expect(parseFontMetricsTable({ lineHeightMultipliers: "nope" } as any)).toBeNull();
  });
});
