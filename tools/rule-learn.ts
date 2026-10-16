/**
 * Corpus rule-learner (next_step.md I1) — fits candidate REST-emission
 * rules against cached ground truth. Zero network, ever: REST truth comes
 * from the cached whole-file snapshot, our values from the stored frames.
 *
 *   npx tsx tools/rule-learn.ts <probe> [--cohort <nodeType>] [--json]
 *                                   [--fixture <path>] [--store <dir>]
 *
 * Probes register (name, cohort, target, candidates); the harness pairs
 * REST and our nodes by id (id correspondence is verified — report.md §2),
 * collects rows for the cohort, and scores every candidate rule:
 * coverage % and the first counterexamples.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const GOLDEN_DIR = path.join(REPO, "golden");
const STORE_DIR = path.join(REPO, "store");

// ---------------------------------------------------------------------------
// Corpus loading + id pairing
// ---------------------------------------------------------------------------

interface Pair {
  id: string;
  type: string;
  parentType: string;
  rest: Record<string, unknown>;
  ours: Record<string, unknown>;
}

function collectNodes(node: unknown, parentType: string, out: Map<string, { node: Record<string, unknown>; parentType: string }>): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.id === "string") out.set(n.id, { node: n, parentType });
  const kids = n.children;
  if (Array.isArray(kids)) {
    const t = typeof n.type === "string" ? n.type : parentType;
    for (const c of kids) collectNodes(c, t, out);
  }
}

export function loadPairs(opts: { fixture?: string; store?: string }): Pair[] {
  const fixture =
    opts.fixture ??
    fs
      .readdirSync(GOLDEN_DIR)
      .filter((f) => /^file-.*\.rest\.json$/.test(f) && !f.includes(".v2."))
      .sort()[0];
  if (!fixture) throw new Error("no whole-file REST snapshot under golden/ (pass --fixture)");
  const restFile = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, fixture), "utf8"));

  const storeDir = opts.store ?? fs.readdirSync(STORE_DIR).filter((d) => fs.statSync(path.join(STORE_DIR, d)).isDirectory())[0];
  if (!storeDir) throw new Error("no store/ directory with extracted frames (pass --store)");
  const framesDir = path.join(STORE_DIR, storeDir, "frames");

  const restNodes = new Map<string, { node: Record<string, unknown>; parentType: string }>();
  for (const page of (restFile.document?.children ?? []) as Record<string, unknown>[]) {
    for (const top of (page.children ?? []) as Record<string, unknown>[]) {
      collectNodes(top, "CANVAS", restNodes);
    }
  }
  const ourNodes = new Map<string, { node: Record<string, unknown>; parentType: string }>();
  if (fs.existsSync(framesDir)) {
    for (const f of fs.readdirSync(framesDir)) {
      if (!f.endsWith(".json")) continue;
      const frame = JSON.parse(fs.readFileSync(path.join(framesDir, f), "utf8"));
      collectNodes(frame.document ?? frame, "CANVAS", ourNodes);
    }
  }

  const pairs: Pair[] = [];
  for (const [id, { node, parentType }] of restNodes) {
    const ours = ourNodes.get(id);
    if (!ours) continue;
    pairs.push({ id, type: String(node.type ?? ""), parentType, rest: node, ours: ours.node });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface Row {
  nodeId: string;
  nodeType: string;
  parentType: string;
  restValue: unknown;
  ourValue: unknown;
  context: Record<string, unknown>;
}

interface Candidate {
  name: string;
  predict(row: Row): unknown;
}

interface Probe {
  name: string;
  description: string;
  cohort(p: Pair): boolean;
  row(p: Pair): Row | null;
  candidates: Candidate[];
}

const equals = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const PROBES: Probe[] = [
  {
    name: "layoutVersion",
    description: "Is REST's layoutVersion deterministic? (492 paths — 21% of the whole diff)",
    cohort: (p) => "layoutVersion" in p.rest,
    row: (p) => ({
      nodeId: p.id,
      nodeType: p.type,
      parentType: p.parentType,
      restValue: p.rest.layoutVersion,
      ourValue: p.ours.layoutVersion,
      context: { hasChildren: Array.isArray(p.rest.children) && p.rest.children.length > 0 },
    }),
    candidates: [
      { name: "constant 5", predict: () => 5 },
      {
        name: "modal value per node type",
        predict: (row) => {
          const table = modalByType.get(row.nodeType);
          return table ? table.value : undefined;
        },
      },
      { name: "constant 1", predict: () => 1 },
    ],
  },
  {
    name: "psNameRule",
    description: "Which (family, style) pairs get a real fontPostScriptName, and how is it composed? (38 paths)",
    cohort: (p) =>
      p.type === "TEXT" && typeof ((p.rest.style ?? {}) as Record<string, unknown>).fontPostScriptName === "string",
    row: (p) => {
      const st = (p.rest.style ?? {}) as Record<string, unknown>;
      return {
        nodeId: p.id,
        nodeType: p.type,
        parentType: p.parentType,
        restValue: st.fontPostScriptName,
        ourValue: ((p.ours.style ?? {}) as Record<string, unknown>).fontPostScriptName,
        context: { fontFamily: st.fontFamily, fontStyle: st.fontStyle },
      };
    },
    candidates: [
      {
        name: "composed Family-Style (spaces stripped)",
        predict: (row) => {
          const family = String(row.context.fontFamily ?? "");
          const style = String(row.context.fontStyle ?? "");
          if (!family) return null;
          return `${family.replace(/\s+/g, "")}-${style.replace(/\s+/g, "")}`;
        },
      },
      { name: "family only", predict: (row) => row.context.fontFamily ?? null },
    ],
  },
  {
    name: "baseStyleRule",
    description: "Which segment does REST's base style come from? (G4, 317 paths)",
    cohort: (p) => p.type === "TEXT" && !!p.rest.styleOverrideTable,
    row: (p) => {
      const segments = p.ours._figmaAgentTextSegments as
        | { characters: string; style: Record<string, unknown> }[]
        | undefined;
      const sot = p.rest.styleOverrideTable as Record<string, Record<string, unknown>>;
      const base = p.rest.style as Record<string, unknown>;
      return {
        nodeId: p.id,
        nodeType: p.type,
        parentType: p.parentType,
        restValue: { baseFontStyle: base.fontStyle, baseFontWeight: base.fontWeight, tableKeys: Object.keys(sot).length },
        ourValue: { ourFontStyle: ((p.ours.style ?? {}) as Record<string, unknown>).fontStyle, ourSegments: segments?.length ?? 0 },
        context: { segments: segments ?? [] },
      };
    },
    candidates: [
      { name: "first segment", predict: () => 0 },
      { name: "last segment", predict: () => -1 },
      { name: "longest segment", predict: () => -2 },
      { name: "segment of the last character", predict: () => -3 },
    ],
  },
];

// populated by score() for the modal-value candidate
const modalByType = new Map<string, { value: unknown; count: number }>();

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function score(probe: Probe, pairs: Pair[], cohortFilter: string | undefined, asJson: boolean): void {
  let rows = pairs.filter(probe.cohort);
  if (cohortFilter) rows = rows.filter((r) => r.type === cohortFilter);

  // pre-pass: modal rest value per node type (feeds the modal candidate)
  const byType = new Map<string, Map<string, number>>();
  for (const p of rows) {
    const row = probe.row(p);
    if (!row) continue;
    const key = JSON.stringify(row.restValue);
    const dist = byType.get(row.nodeType) ?? new Map<string, number>();
    dist.set(key, (dist.get(key) ?? 0) + 1);
    byType.set(row.nodeType, dist);
  }
  for (const [type, dist] of byType) {
    let best = { value: undefined as unknown, count: -1 };
    for (const [key, count] of dist) {
      if (count > best.count) best = { value: JSON.parse(key), count };
    }
    modalByType.set(type, best);
  }

  if (asJson) {
    const out = rows.map((p) => {
      const row = probe.row(p)!;
      return {
        nodeId: row.nodeId,
        nodeType: row.nodeType,
        restValue: row.restValue,
        ourValue: row.ourValue,
        context: row.context,
      };
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\nprobe: ${probe.name} — ${probe.description}`);
  console.log(`cohort: ${rows.length} paired nodes${cohortFilter ? ` (type=${cohortFilter})` : ""}`);

  if (rows.length === 0) {
    console.log("no rows — nothing to fit");
    return;
  }

  // rest-value distribution
  const dist = new Map<string, number>();
  for (const p of rows) {
    const row = probe.row(p)!;
    const key = JSON.stringify(row.restValue);
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log(`rest-value distribution (top 8):`);
  [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k.slice(0, 70)}`));

  for (const cand of probe.candidates) {
    let hit = 0;
    const misses: Row[] = [];
    for (const p of rows) {
      const row = probe.row(p)!;
      if (equals(cand.predict(row), row.restValue)) hit++;
      else if (misses.length < 3) misses.push(row);
    }
    const pct = ((100 * hit) / rows.length).toFixed(1);
    console.log(`candidate "${cand.name}": ${hit}/${rows.length} (${pct}%)`);
    for (const m of misses) {
      console.log(`  ✗ ${m.nodeId} (${m.nodeType}): rest=${JSON.stringify(m.restValue)?.slice(0, 50)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "");
      const next = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      opts[key] = next;
    } else positional.push(args[i]);
  }
  if (!positional[0]) {
    console.error(`usage: tsx tools/rule-learn.ts <probe> [--cohort <nodeType>] [--json] [--fixture <path>] [--store <dir>]\nprobes: ${PROBES.map((p) => p.name).join(", ")}`);
    process.exit(2);
  }
  const probe = PROBES.find((p) => p.name === positional[0]);
  if (!probe) {
    console.error(`unknown probe "${positional[0]}" — available: ${PROBES.map((p) => p.name).join(", ")}`);
    process.exit(2);
  }
  const pairs = loadPairs({ fixture: opts.fixture !== "true" ? opts.fixture : undefined, store: opts.store !== "true" ? opts.store : undefined });
  console.log(`corpus: ${pairs.length} paired nodes (REST snapshot ↔ stored frames)`);
  score(probe, pairs, opts.cohort !== "true" ? opts.cohort : undefined, opts.json === "true");
}

main();
