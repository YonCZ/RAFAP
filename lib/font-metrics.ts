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
}

export function parseFontMetricsTable(raw: unknown): FontMetricsTable | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.lineHeightMultipliers !== "object" || t.lineHeightMultipliers === null) return null;
  if (typeof t.postScriptNames !== "object" || t.postScriptNames === null) return null;
  return {
    lineHeightMultipliers: t.lineHeightMultipliers as Record<string, number>,
    postScriptNames: t.postScriptNames as Record<string, string>,
  };
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
      style.lineHeightPx = mult * size;
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
