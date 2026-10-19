/**
 * Round 2 (C1/C3/C4) — corpus-bootstrapped font metrics rewriting.
 *
 * REST computes several text-style fields from real font metrics the plugin
 * API does not expose. Measured on the golden corpus (tools/build-font-metrics.ts):
 *
 *   · INTRINSIC (AUTO) lineHeightPx is a pure per-family multiplier × fontSize
 *     (validated to ~1e-6 across 906 samples). The plugin can only estimate
 *     (height ÷ lineCount), and omits entirely on fixed-height boxes
 *     (deviation #19) — the bridge rewrites/adds it here.
 *   · PIXELS lineHeightPercent = lineHeightPx ÷ (multiplier × fontSize) × 100
 *     (validated exactly on 146 corpus samples) — REST emits it, we omitted it.
 *   · fontPostScriptName follows the rule `Family-Style` (spaces stripped),
 *     but REST only has server-side names for some (family, style) combos —
 *     Inter resolves to null except Inter/Medium in the corpus. The table
 *     records exactly which combos REST names; the rest stay null.
 *     On styleOverrideTable entries REST emits fontPostScriptName (name or
 *     null) exactly when fontFamily is part of the delta (FONT_KEYS group).
 *
 * The rewriter runs bridge-side at persist time so plugin output stays
 * untouched and the table (corpus-derived data) stays in the gitignored
 * store. All rewrites are keyed on the *effective* family/size —
 * styleOverrideTable entries carry only deltas, so missing fields fall back
 * to the node's base style.
 */
export interface FontMetricsTable {
  /** fontFamily → lineHeightPx multiplier (AUTO/INTRINSIC line heights) */
  lineHeightMultipliers: Record<string, number>;
  /** "fontFamily/fontStyle" → PostScript name; only combos REST names */
  postScriptNames: Record<string, string>;
  /**
   * Families whose multiplier is an exact rational recovered by a Round 7
   * probe snap. REST computes INTRINSIC lineHeightPx as
   * float32(fontSize × float32(m)) — for these families the rewriter emits
   * exactly that (bit-identical to REST). Corpus (fit) multipliers keep the
   * plain double product.
   */
  exactRationalFamilies?: string[];
}

export function parseFontMetricsTable(raw: unknown): FontMetricsTable | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.lineHeightMultipliers !== "object" || t.lineHeightMultipliers === null) return null;
  if (typeof t.postScriptNames !== "object" || t.postScriptNames === null) return null;
  const exact = Array.isArray(t.exactRationalFamilies)
    ? t.exactRationalFamilies.filter((f): f is string => typeof f === "string")
    : undefined;
  return {
    lineHeightMultipliers: t.lineHeightMultipliers as Record<string, number>,
    postScriptNames: t.postScriptNames as Record<string, string>,
    ...(exact ? { exactRationalFamilies: exact } : {}),
  };
}

// ---------------------------------------------------------------------------
// Round 7 (C2) — runtime probe merging for unseen families.
//
// The plugin measures intrinsic line heights on a scratch text node, whose
// layout rounds to integer px per line. Each sample L at font size S therefore
// bounds the true multiplier to m ∈ [(L−0.5)/S, (L+0.5)/S]; intersecting many
// samples (taken at large sizes) recovers m far past the normalizer's 4
// decimals. REST's own pipeline is lineHeightPx = float32(size × float32(m))
// with m = (ascender+descender+lineGap)/unitsPerEm — a rational with a small
// denominator — so once the intersection is tight we snap to the simplest
// rational that validates every sample and emit REST's float32 arithmetic
// verbatim (bit-exact, no corpus needed).
// ---------------------------------------------------------------------------

export interface FontProbeSample {
  size: number;
  linePx: number;
}

export interface FontProbeEntry {
  family: string;
  style: string;
  samples?: FontProbeSample[];
  error?: string;
}

export interface FontProbeResult {
  fonts?: FontProbeEntry[];
  probedAt?: string;
}

export interface FontProbeAdded {
  family: string;
  multiplier: number;
  /** true → multiplier is an exact rational; rewriter float32-emulates REST */
  exact: boolean;
  /** half-width of the recovered multiplier window */
  precision: number;
}

export interface FontProbeMergeReport {
  added: FontProbeAdded[];
  rejected: { family: string; reason: string }[];
}

/**
 * Robust multiplier window from probe samples.
 *
 * Figma's text layout rounds each line's height to integer px; at very large
 * font sizes the box additionally picks up one-sided upward anomalies
 * (measured empirically: +1 px on a line, or +1 px on the box = +0.2 px/line
 * — never below the rounding floor). A clean sample bounds
 * m ∈ [(L−0.5)/S, (L+0.5)/S]; an anomalous sample only inflates its lower
 * bound above m. So the upper bound is the strict min of (L+0.5)/S
 * (anomalies never bind it), and the lower bound is the largest (L−0.5)/S
 * that does not exceed that upper bound — anomalous bounds self-identify by
 * contradicting it. Every bound that survives the filter is ≤ m, so the
 * window provably contains the true multiplier, as tightly as the rounding
 * phases allow (~2/(count·size)).
 */
export function robustFontSampleWindow(
  samples: FontProbeSample[],
): { lo: number; hi: number } | null {
  let hi = Infinity;
  const cs: number[] = [];
  let n = 0;
  for (const s of samples) {
    if (!s || typeof s !== "object") return null;
    if (typeof s.size !== "number" || typeof s.linePx !== "number") return null;
    if (!Number.isFinite(s.size) || s.size <= 0 || !Number.isFinite(s.linePx)) return null;
    cs.push((s.linePx - 0.5) / s.size);
    hi = Math.min(hi, (s.linePx + 0.5) / s.size);
    n++;
  }
  if (n < 8) return null;
  let lo = -Infinity;
  for (const c of cs) {
    if (c <= hi && c > lo) lo = c;
  }
  return Number.isFinite(lo) && lo <= hi ? { lo, hi } : null;
}

const MAX_RATIONAL_DENOMINATOR = 16384; // OpenType unitsPerEm cap (spec: 16–16384)

/**
 * Snap a multiplier window to the simplest rational k/d (d ≤ 16384) inside
 * the window that reproduces every sample within ±0.5 px. Font metrics are
 * k/unitsPerEm, so the true multiplier is always a candidate; distinct
 * rationals k/d ≠ k'/d' differ by ≥ 1/(d·d'), which is what makes the
 * smallest-denominator candidate provable (see mergeFontProbeResult).
 */
export function snapToRational(
  window: { lo: number; hi: number },
  samples: FontProbeSample[],
): { value: number; denominator: number } | null {
  const mid = (window.lo + window.hi) / 2;
  let best: number | null = null;
  let bestD = Infinity;
  for (let d = 1; d <= MAX_RATIONAL_DENOMINATOR; d++) {
    const k = Math.round(mid * d);
    if (k <= 0) continue;
    const cand = k / d;
    if (cand < window.lo || cand > window.hi) continue;
    // One-sided validation: a sample's linePx may exceed cand·size by up to
    // +1.5 px (rounding + the layout's upward box anomalies) but never falls
    // more than 0.5 px below it (see robustFontSampleWindow).
    let ok = true;
    for (const s of samples) {
      const e = s.linePx - cand * s.size;
      if (e < -0.5 - 1e-6 || e > 1.5 + 1e-6) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return best === null ? null : { value: best, denominator: bestD };
}

/** A non-snapped (midpoint) multiplier is accepted only this tight. */
const FALLBACK_MAX_HALF_WIDTH = 1e-6;

/**
 * Merge a `probe-fonts` result into the table. Entries already present are
 * never overwritten — the corpus table is REST-derived ground truth; the
 * probe is the fallback for families the corpus never saw. All styles of a
 * family contribute samples to one family-level intersection (styles with
 * divergent metrics make it empty → rejected). Returns what happened, for
 * logs and tests.
 */
export function mergeFontProbeResult(
  table: FontMetricsTable,
  probe: FontProbeResult,
): FontProbeMergeReport {
  const added: FontProbeAdded[] = [];
  const rejected: { family: string; reason: string }[] = [];

  const byFamily = new Map<string, { samples: FontProbeSample[]; errors: string[] }>();
  for (const f of probe.fonts ?? []) {
    if (!f || typeof f.family !== "string" || !f.family) continue;
    let g = byFamily.get(f.family);
    if (!g) {
      g = { samples: [], errors: [] };
      byFamily.set(f.family, g);
    }
    if (f.error) {
      g.errors.push(f.error);
      continue;
    }
    if (Array.isArray(f.samples)) {
      for (const s of f.samples) {
        if (
          s &&
          typeof s.size === "number" &&
          Number.isFinite(s.size) &&
          s.size > 0 &&
          typeof s.linePx === "number" &&
          Number.isFinite(s.linePx)
        ) {
          g.samples.push(s);
        }
      }
    }
  }

  for (const [family, g] of byFamily) {
    if (typeof table.lineHeightMultipliers[family] === "number") {
      rejected.push({ family, reason: "already in table — corpus value kept" });
      continue;
    }
    if (!g.samples.length) {
      rejected.push({ family, reason: `probe error: ${g.errors[0] ?? "no samples"}` });
      continue;
    }
    let window = robustFontSampleWindow(g.samples);
    if (window) {
      // The window's lower-bound filter silently drops one-sided anomalies,
      // which also means a style with different metrics would vanish rather
      // than empty the intersection. Catch that here: every sample must sit
      // within one-sided rounding (+anomaly) distance of the window midpoint.
      const mid = (window.lo + window.hi) / 2;
      const diverged = g.samples.some((s) => {
        const e = s.linePx - mid * s.size;
        return e > 2.5 || e < -1.5;
      });
      if (diverged) window = null;
    }
    if (!window) {
      rejected.push({
        family,
        reason:
          g.errors.length > 0
            ? `inconsistent samples — probed styles disagree (${g.errors.length} style(s) errored)`
            : "inconsistent samples — styles disagree or layout is non-linear",
      });
      continue;
    }
    const width = window.hi - window.lo;
    const snapped = snapToRational(window, g.samples);
    // Certification: distinct rationals k/d ≠ k'/d' differ by ≥ 1/(d·d').
    // If the window is narrower than 1/d̂², no rational with a smaller
    // denominator than the snapped d̂ can lie inside it — so d̂ is provably
    // the smallest possible denominator, which (given that font metrics are
    // k/unitsPerEm with unitsPerEm ≤ 16384) makes the snapped value the true
    // multiplier, and the rewriter can emulate REST's float32 arithmetic
    // bit-for-bit.
    if (snapped !== null && width < 1 / (snapped.denominator * snapped.denominator)) {
      table.lineHeightMultipliers[family] = snapped.value;
      if (!table.exactRationalFamilies) table.exactRationalFamilies = [];
      if (!table.exactRationalFamilies.includes(family)) table.exactRationalFamilies.push(family);
      added.push({ family, multiplier: snapped.value, exact: true, precision: width / 2 });
      continue;
    }
    if (width / 2 > FALLBACK_MAX_HALF_WIDTH) {
      rejected.push({
        family,
        reason: `insufficient precision — multiplier window ±${(width / 2).toExponential(2)}`,
      });
      continue;
    }
    const mid = (window.lo + window.hi) / 2;
    table.lineHeightMultipliers[family] = mid;
    added.push({ family, multiplier: mid, exact: false, precision: width / 2 });
  }
  return { added, rejected };
}

/**
 * Rewrite one text style in place. `base` is the node's base style —
 * styleOverrideTable entries inherit family/size/style from it when their
 * own deltas omit them. `isSotEntry` gates the fontPostScriptName rule:
 * node styles always carry the key; SOT entries only when fontFamily is
 * part of the delta.
 */
function rewriteStyle(
  style: Record<string, any>,
  table: FontMetricsTable,
  opts: { isSotEntry: boolean; base?: Record<string, any> },
): void {
  const family = style.fontFamily ?? opts.base?.fontFamily;
  const size = style.fontSize ?? opts.base?.fontSize;

  // AUTO/INTRINSIC — lineHeightPx from the multiplier (fixes the plugin's
  // height ÷ lines estimate, and deviation #19's omission on fixed-height boxes).
  if (style.lineHeightUnit === "INTRINSIC_%") {
    const mult = typeof family === "string" ? table.lineHeightMultipliers[family] : undefined;
    if (typeof mult === "number" && typeof size === "number" && size > 0) {
      // Probe-snapped multipliers are exact rationals; REST computes
      // float32(size × float32(m)) — emit the same arithmetic bit-for-bit.
      // Corpus (fit) multipliers keep the plain double product.
      style.lineHeightPx = table.exactRationalFamilies?.includes(family as string)
        ? Math.fround(size * Math.fround(mult))
        : mult * size;
    }
  }

  // R7.4 (second-file acceptance) — styleOverrideTable deltas that inherit
  // the base's line height but carry their own fontSize. The range's
  // lineHeightPx = fontSize × multiplier then DIFFERS from the base's, and
  // REST materializes the inherited group (unit + percent + px) on the
  // entry. The plugin cannot see this (server-side font metrics), so the
  // bridge adds it here. Measured: corpus entries with fontSize equal to
  // the base carry no lineHeight keys; the Positivus mixed-size entries
  // carry the full group (px = fround(range size × fround(m))).
  if (
    opts.isSotEntry &&
    typeof style.fontSize === "number" &&
    style.fontSize > 0 &&
    !("lineHeightUnit" in style) &&
    opts.base?.lineHeightUnit === "INTRINSIC_%" &&
    typeof opts.base.fontSize === "number" &&
    style.fontSize !== opts.base.fontSize
  ) {
    const mult = typeof family === "string" ? table.lineHeightMultipliers[family] : undefined;
    if (typeof mult === "number") {
      style.lineHeightUnit = "INTRINSIC_%";
      style.lineHeightPercent = typeof opts.base.lineHeightPercent === "number" ? opts.base.lineHeightPercent : 100;
      style.lineHeightPx = table.exactRationalFamilies?.includes(family as string)
        ? Math.fround(style.fontSize * Math.fround(mult))
        : mult * style.fontSize;
    }
  }

  // PIXELS — lineHeightPercent = px ÷ intrinsic × 100.
  if (
    style.lineHeightUnit === "PIXELS" &&
    typeof style.lineHeightPx === "number" &&
    typeof family === "string"
  ) {
    const mult = table.lineHeightMultipliers[family];
    if (typeof mult === "number" && typeof size === "number" && size > 0) {
      style.lineHeightPercent = (style.lineHeightPx / (mult * size)) * 100;
    }
  }

  // fontPostScriptName — replace our null/omitted value with REST's when the
  // corpus table has a name for the effective (family, style).
  const fontStyle = style.fontStyle ?? opts.base?.fontStyle;
  if (typeof family === "string" && typeof fontStyle === "string") {
    const ps = table.postScriptNames[`${family}/${fontStyle}`];
    if (ps !== undefined) {
      const shouldEmit = !opts.isSotEntry || "fontFamily" in style || "fontPostScriptName" in style;
      if (shouldEmit) style.fontPostScriptName = ps;
    } else if (opts.isSotEntry && "fontFamily" in style && !("fontPostScriptName" in style)) {
      // REST emits null on FONT_KEYS-group SOT entries it has no name for.
      style.fontPostScriptName = null;
    }
  }
}

/** Rewrite every TEXT style (base + styleOverrideTable) under a frame in place. */
export function rewriteFontMetrics(frame: any, table: FontMetricsTable): void {
  const stack: any[] = [frame?.document ?? frame];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.type === "TEXT") {
      const base = n.style;
      if (base) rewriteStyle(base, table, { isSotEntry: false });
      const sot = n.styleOverrideTable;
      if (sot && typeof sot === "object") {
        for (const e of Object.values(sot)) {
          if (e && typeof e === "object") rewriteStyle(e, table, { isSotEntry: true, base });
        }
      }
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) stack.push(c);
    }
  }
}
