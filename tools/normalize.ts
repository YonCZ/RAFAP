/**
 * Golden-diff normalizer (agent.md §9.3).
 *
 * Canonicalizes a REST-shaped tree so api.figma.com and Figma Agent
 * payloads become byte-comparable:
 *
 *   · strips `_`-prefixed extension fields (our superset namespace)
 *   · strips volatile fields (lastModified, version, …)
 *   · sorts all object keys
 *   · rounds floats to 4 decimals (transform jitter)
 *   · treats empty objects as absent (matches Rule B2)
 *   · canonicalizes styleOverrideTable ids in first-appearance order
 *     (both sides may dedup/number overrides differently)
 *   · re-pads characterStyleOverrides to the character count (REST trims
 *     trailing zeros; the array length itself is not a real difference)
 */

const VOLATILE_KEYS = new Set([
  "lastModified",
  "version",
  "thumbnailUrl",
  "generatedAt",
  "extractedAt",
  "frameCount",
  "componentPropertyDefinitions", // volatile across publish cycles
]);

export function normalize(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      if (k.startsWith("_")) continue;
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = normalize((value as Record<string, unknown>)[k]);
    }
    if (Object.keys(out).length === 0) return undefined; // {} ≡ absent
    padCharacterOverrides(out);
    canonicalizeOverrideTable(out);
    return out;
  }
  return value;
}

/**
 * Re-pad characterStyleOverrides to the character count (REST trims
 * trailing zeros; "characters beyond the array's length also use the
 * default style" — i.e. index 0 — so padding with 0s is semantics-
 * preserving). Array length then never diffs by itself.
 */
function padCharacterOverrides(node: Record<string, unknown>): void {
  const chars = node.characters;
  const cso = node.characterStyleOverrides;
  if (typeof chars === "string" && Array.isArray(cso) && cso.length < chars.length) {
    node.characterStyleOverrides = [...cso, ...new Array(chars.length - cso.length).fill(0)];
  }
}

/** Renumber styleOverrideTable ids in first-appearance order. */
function canonicalizeOverrideTable(node: Record<string, unknown>): void {
  const cso = node.characterStyleOverrides;
  const sot = node.styleOverrideTable;
  if (!Array.isArray(cso) || !sot || typeof sot !== "object") return;

  const order: string[] = [];
  for (const id of cso) {
    const key = String(id);
    if (id !== 0 && !order.includes(key)) order.push(key);
  }
  const renumber = new Map(order.map((k, i) => [k, String(i + 1)]));
  node.characterStyleOverrides = cso.map((id) =>
    id === 0 ? 0 : Number(renumber.get(String(id)) ?? id),
  );
  const table = sot as Record<string, unknown>;
  const newTable: Record<string, unknown> = {};
  order.forEach((k, i) => {
    newTable[String(i + 1)] = table[k];
  });
  node.styleOverrideTable = newTable;
}

// ---------------------------------------------------------------------------
// Semantic canonicalization of the text model (Round 3, E2)
// ---------------------------------------------------------------------------

/**
 * REST's text model is a base style + per-range deltas, but the base is the
 * node's **stored typing style** (editor state — see deviation #20): it may
 * match no live segment, and REST and RAFAP may pick different bases for the
 * same rendered text. Both encodings are information-equivalent, so this
 * pass re-encodes both sides identically before diffing:
 *
 *   · resolve each character's full style (base ⊕ node fills ⊕ slot delta)
 *   · drop fields the plugin API cannot see (inherit*StyleId — #21) and
 *     lineHeight fields not applicable to the unit (the delta model leaks a
 *     phantom lineHeightPercentFontSize onto INTRINSIC segments)
 *   · re-encode with base = resolved style of character 0, slots numbered by
 *     first appearance — unreferenced table entries (stored records, #37)
 *     carry no rendered information and vanish
 *
 * Byte parity stays the primary metric; semantic parity (diff after this
 * pass) proves representational differences are not information loss.
 */
// Keys whose values are per-unit: a segment switching lineHeight unit needs
// the whole applicable group in its delta (JSON deltas cannot delete keys,
// so per-field diffing would emit phantom `undefined` entries).
const LINE_HEIGHT_KEYS = ["lineHeightUnit", "lineHeightPx", "lineHeightPercent", "lineHeightPercentFontSize"] as const;

export function canonicalizeTextModel(node: unknown): void {
  if (!node || typeof node !== "object" || (node as any).type !== "TEXT") return;
  const n = node as Record<string, any>;
  const style = n.style;
  if (!style || typeof style !== "object") return;
  const sot = (n.styleOverrideTable ?? {}) as Record<string, any>;
  const cso = Array.isArray(n.characterStyleOverrides) ? (n.characterStyleOverrides as number[]) : [];
  const chars = typeof n.characters === "string" ? (n.characters as string) : "";

  const scrub = (s: Record<string, any>): void => {
    delete s.inheritFillStyleId;
    delete s.inheritTextStyleId;
    if (s.lineHeightUnit === "INTRINSIC_%") delete s.lineHeightPercentFontSize;
    else if (s.lineHeightUnit === "FONT_SIZE_%") {
      delete s.lineHeightPx;
      delete s.lineHeightPercent;
    }
  };

  const baseStyle = { ...style };
  if (n.fills !== undefined) baseStyle.fills = n.fills;
  // textAutoResize is a node-level property (spec: TypeStyle); REST range
  // records can still carry per-range values — record noise. Keep the
  // node's value constant so it never fans out into range deltas.
  const nodeAutoResize = style.textAutoResize;
  const resolved: Record<string, any>[] = [];
  for (let i = 0; i < chars.length; i++) {
    const slot = i < cso.length ? Number(cso[i] ?? 0) : 0;
    const delta = sot[String(slot)];
    const full = delta && typeof delta === "object" ? { ...baseStyle, ...delta } : { ...baseStyle };
    scrub(full);
    if (nodeAutoResize === undefined) delete full.textAutoResize;
    else full.textAutoResize = nodeAutoResize;
    resolved.push(full);
  }

  const baseFull = resolved.length ? resolved[0] : { ...baseStyle };
  const styleOut: Record<string, any> = { ...baseFull };
  delete styleOut.fills;

  const newSot: Record<string, any> = {};
  const idByKey = new Map<string, number>();
  const csoOut: number[] = [];
  let next = 1;
  for (const full of resolved) {
    const key = canonicalJson(full);
    if (key === canonicalJson(baseFull)) {
      csoOut.push(0);
      continue;
    }
    let id = idByKey.get(key);
    if (id === undefined) {
      id = next++;
      idByKey.set(key, id);
      const delta: Record<string, any> = {};
      const isLh = (k: string) => (LINE_HEIGHT_KEYS as readonly string[]).includes(k);
      const keys = new Set([...Object.keys(full), ...Object.keys(baseFull)].filter((k) => !isLh(k)));
      for (const k of keys) {
        if (full[k] !== undefined && canonicalJson(full[k]) !== canonicalJson(baseFull[k])) delta[k] = full[k];
      }
      // lineHeight fields travel as the whole applicable group — a unit
      // switch must replace the group, not diff per-field (a JSON delta
      // cannot delete keys, so per-field diffing emits phantom undefined).
      if (LINE_HEIGHT_KEYS.some((k) => canonicalJson(full[k]) !== canonicalJson(baseFull[k]))) {
        for (const k of LINE_HEIGHT_KEYS) {
          if (full[k] !== undefined) delta[k] = full[k];
        }
      }
      newSot[String(id)] = delta;
    }
    csoOut.push(id);
  }
  while (csoOut.length > 0 && csoOut[csoOut.length - 1] === 0) csoOut.pop();

  n.style = styleOut;
  if (baseFull.fills !== undefined) n.fills = baseFull.fills;
  else delete n.fills;
  if (csoOut.length) n.characterStyleOverrides = csoOut;
  else delete n.characterStyleOverrides;
  if (Object.keys(newSot).length) n.styleOverrideTable = newSot;
  else delete n.styleOverrideTable;
}

/** Apply canonicalizeTextModel to every TEXT node under `root`, in place. */
export function semanticize(root: unknown): void {
  if (Array.isArray(root)) {
    for (const v of root) semanticize(v);
    return;
  }
  if (!root || typeof root !== "object") return;
  canonicalizeTextModel(root);
  for (const v of Object.values(root as Record<string, unknown>)) semanticize(v);
}

export function canonicalJson(value: unknown): string {
  const normalized = normalize(value);
  const sorted = JSON.stringify(normalized, (_k, v) => v, 2);
  // JSON.stringify already emits insertion order; normalize() sorted keys
  return sorted;
}

/** Count scalar leaves — the denominator for byte-parity percentages. */
export function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, v) => sum + countLeaves(v), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce((sum, v) => sum + countLeaves(v), 0);
  return 1;
}

// ---------------------------------------------------------------------------
// Structural diff — walks both trees and records every difference.
// ---------------------------------------------------------------------------

export interface TreeDiff {
  path: string;
  kind: "value" | "missing-in-rest" | "missing-in-ours";
  rest?: unknown;
  ours?: unknown;
}

const EPSILON = 0.0001;

export function diffTrees(rest: unknown, ours: unknown, path = "$", out: TreeDiff[] = []): TreeDiff[] {
  if (typeof rest === "number" && typeof ours === "number") {
    if (Math.abs(rest - ours) > EPSILON) {
      out.push({ path, kind: "value", rest, ours });
    }
    return out;
  }
  if (Array.isArray(rest) && Array.isArray(ours)) {
    const len = Math.max(rest.length, ours.length);
    for (let i = 0; i < len; i++) {
      if (i >= rest.length) out.push({ path: `${path}[${i}]`, kind: "missing-in-rest", ours: ours[i] });
      else if (i >= ours.length) out.push({ path: `${path}[${i}]`, kind: "missing-in-ours", rest: rest[i] });
      else diffTrees(rest[i], ours[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (rest && ours && typeof rest === "object" && typeof ours === "object") {
    const keys = [...new Set([...Object.keys(rest), ...Object.keys(ours)])].sort();
    for (const k of keys) {
      const r = (rest as Record<string, unknown>)[k];
      const o = (ours as Record<string, unknown>)[k];
      if (r === undefined) out.push({ path: `${path}.${k}`, kind: "missing-in-rest", ours: o });
      else if (o === undefined) out.push({ path: `${path}.${k}`, kind: "missing-in-ours", rest: r });
      else diffTrees(r, o, `${path}.${k}`, out);
    }
    return out;
  }
  if (rest !== ours) {
    out.push({ path, kind: "value", rest, ours });
  }
  return out;
}
