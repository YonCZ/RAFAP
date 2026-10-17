/**
 * Round 2 (C1/C3/C4) — corpus-bootstrap font metrics table.
 *
 * REST computes several text-style fields from real font metrics the plugin
 * API does not expose. Measured hypotheses (all validated on the cached
 * REST file fixture):
 *
 *   · INTRINSIC lineHeightPx = per-FAMILY multiplier × fontSize
 *     (906 samples, 4 families, worst-case fit error ~1e-6).
 *   · PIXELS lineHeightPercent = lineHeightPx ÷ (multiplier × fontSize) × 100
 *     (146 samples, exact to ~1e-6).
 *   · fontPostScriptName follows `Family-Style` (spaces stripped), but REST
 *     only names some (family, style) combos — the rest are null. We record
 *     exactly the combos REST names (Inter is null except Inter/Medium).
 *
 * Output (store/font-metrics.json, gitignored — corpus-derived data):
 *
 *   { "lineHeightMultipliers": { "Inter": 1.21022725… },
 *     "postScriptNames": { "SF Pro Text/Semibold": "SFProText-Semibold" } }
 *
 * The bridge loads the table at startup and applies it at persist time
 * (lib/font-metrics.ts).
 *
 * Usage: npx tsx tools/build-font-metrics.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const GOLDEN_DIR = path.join(REPO, "golden");
const OUT = path.join(REPO, "store", "font-metrics.json");

interface IntrinsicSample {
  family: string;
  size: number;
  px: number;
}

interface PixelsSample {
  family: string;
  size: number;
  px: number;
  percent: number;
}

interface PsNameSample {
  family: string;
  style: string;
  ps: string | null;
}

function walkTextNodes(root: any, visit: (node: any) => void): void {
  const stack: any[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (n.type === "TEXT") visit(n);
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
  }
}

function main(): void {
  const fixtures = fs
    .readdirSync(GOLDEN_DIR)
    .filter((f) => f.startsWith("file-") && f.endsWith(".rest.json"))
    .sort();
  if (!fixtures.length) throw new Error("no golden/file-*.rest.json fixtures found");

  const intrinsic: IntrinsicSample[] = [];
  const pixels: PixelsSample[] = [];
  const psNames: PsNameSample[] = [];

  for (const f of fixtures) {
    const doc = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), "utf8"));
    walkTextNodes(doc.document ?? doc, (n) => {
      const base = n.style ?? {};
      if (typeof base.fontFamily === "string" && typeof base.fontStyle === "string") {
        psNames.push({ family: base.fontFamily, style: base.fontStyle, ps: base.fontPostScriptName ?? null });
      }
      const scan = (s: Record<string, unknown>, isSotEntry: boolean) => {
        if (!s || typeof s !== "object") return;
        const family = (s.fontFamily ?? (isSotEntry ? undefined : base.fontFamily)) as string | undefined;
        const size = (s.fontSize ?? (isSotEntry ? undefined : base.fontSize)) as number | undefined;
        if (isSotEntry) {
          // SOT entries emit fontPostScriptName exactly when fontFamily is
          // in the delta; effective style falls back to the base.
          if ("fontFamily" in s && typeof s.fontFamily === "string") {
            const style = (s.fontStyle ?? base.fontStyle) as string;
            if (typeof style === "string") {
              psNames.push({ family: s.fontFamily, style, ps: (s as any).fontPostScriptName ?? null });
            }
          }
        }
        if (typeof family !== "string" || typeof size !== "number" || size <= 0) return;
        if (s.lineHeightUnit === "INTRINSIC_%") {
          if (typeof s.lineHeightPx === "number") intrinsic.push({ family, size, px: s.lineHeightPx as number });
        } else if (s.lineHeightUnit === "PIXELS") {
          if (typeof s.lineHeightPx === "number" && typeof s.lineHeightPercent === "number") {
            pixels.push({ family, size, px: s.lineHeightPx as number, percent: s.lineHeightPercent as number });
          }
        }
      };
      scan(base, false);
      for (const e of Object.values(n.styleOverrideTable ?? {}) as Record<string, unknown>[]) scan(e, true);
    });
  }
  if (!intrinsic.length) throw new Error("no INTRINSIC lineHeight samples found");

  // --- Fit the per-family multipliers (see lib/font-metrics.ts for the
  // rounding rationale: REST emits raw float64 doubles, the golden-diff
  // normalizer rounds to 4 decimals, so <1e-5 worst-case error is exact
  // after normalization).
  const byFamily = new Map<string, IntrinsicSample[]>();
  for (const s of intrinsic) {
    const lst = byFamily.get(s.family) ?? [];
    lst.push(s);
    byFamily.set(s.family, lst);
  }
  const multipliers: Record<string, number> = {};
  const errors: string[] = [];
  for (const [family, lst] of byFamily) {
    const candidates = [...new Set(lst.map((s) => s.px / s.size))];
    let best: { mult: number; maxErr: number } | null = null;
    for (const c of candidates) {
      const maxErr = Math.max(...lst.map((s) => Math.abs(c * s.size - s.px)));
      if (!best || maxErr < best.maxErr) best = { mult: c, maxErr };
    }
    if (!best || best.maxErr > 1e-5) {
      errors.push(`${family}: no multiplier reproduces all ${lst.length} INTRINSIC samples within 1e-5`);
      continue;
    }
    multipliers[family] = best.mult;
  }

  // --- Validate the PIXELS lineHeightPercent formula against the fit.
  let pixelBad = 0;
  for (const s of pixels) {
    const mult = multipliers[s.family];
    if (typeof mult !== "number") continue;
    if (Math.abs((s.px / (mult * s.size)) * 100 - s.percent) > 1e-3) pixelBad++;
  }
  if (pixelBad) errors.push(`${pixelBad}/${pixels.length} PIXELS lineHeightPercent samples break the px ÷ intrinsic × 100 formula`);

  // --- Fit the PostScript-name table: record only combos REST names;
  // fail if a combo is both named and null, or maps to conflicting names.
  const postScriptNames: Record<string, string> = {};
  const nullCombos = new Set<string>();
  for (const s of psNames) {
    const key = `${s.family}/${s.style}`;
    if (s.ps === null) {
      nullCombos.add(key);
      continue;
    }
    const prev = postScriptNames[key];
    if (prev !== undefined && prev !== s.ps) errors.push(`${key}: conflicting PostScript names ${prev} vs ${s.ps}`);
    if (nullCombos.has(key)) errors.push(`${key}: REST emits both null and ${s.ps}`);
    postScriptNames[key] = s.ps;
  }

  if (errors.length) {
    for (const e of errors) console.error(`[font-metrics] FIT FAILURE: ${e}`);
    process.exit(1);
  }

  const table = { lineHeightMultipliers: multipliers, postScriptNames };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(table, null, 2) + "\n");
  console.log(
    `[font-metrics] ${intrinsic.length} INTRINSIC + ${pixels.length} PIXELS samples, ` +
      `${Object.keys(multipliers).length} multipliers, ${Object.keys(postScriptNames).length} PostScript names ` +
      `(${nullCombos.size} null combos) → ${path.relative(REPO, OUT)}`,
  );
  for (const [family, mult] of Object.entries(multipliers).sort()) {
    console.log(`  ${family.padEnd(20)} × ${mult}`);
  }
  for (const [combo, ps] of Object.entries(postScriptNames).sort()) {
    console.log(`  ${combo.padEnd(26)} → ${ps}`);
  }
}

main();
