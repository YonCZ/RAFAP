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
    canonicalizeOverrideTable(out);
    return out;
  }
  return value;
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

export function canonicalJson(value: unknown): string {
  const normalized = normalize(value);
  const sorted = JSON.stringify(normalized, (_k, v) => v, 2);
  // JSON.stringify already emits insertion order; normalize() sorted keys
  return sorted;
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
