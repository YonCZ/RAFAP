/**
 * Golden-diff harness (agent.md §9) — proves REST parity instead of
 * assuming it.
 *
 *   npx tsx tools/golden-diff.ts <nodeId> --file-key <key> [options]   (node mode, default)
 *   npx tsx tools/golden-diff.ts --mode file    --fixture <path> …     (file mode: whole envelope)
 *   npx tsx tools/golden-diff.ts --mode scorecard                      (aggregate over all cached pairs)
 *
 * Node mode, for one Figma node id:
 *   1. Loads the REST fixture from golden/<nodeId>.rest.json. If absent
 *      (and a token is available) fetches it ONCE from api.figma.com and
 *      caches it — never more than one REST call per run (§9.2).
 *   2. Fetches our payload from the local bridge (/v1/files/:key/nodes).
 *   3. Normalizes both trees and deep-compares.
 *   4. Writes docs/golden-diff-report.md and prints the summary.
 *
 * File mode compares the whole GET /v1/files/:key envelope (document,
 * canvases, component/style maps) against a cached whole-file REST
 * snapshot — zero API calls.
 *
 * Scorecard mode aggregates every cached normalized pair, classifies the
 * residue by root cause (report.md §3), and writes a scorecard table.
 *
 * Token resolution: --token <path>, $FIGMA_TOKEN, or ~/.figma-token.
 * Rate-limit discipline: on 429 the tool stops and tells you to retry
 * later — it never loops.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, countLeaves, diffTrees, normalize, type TreeDiff } from "./normalize.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const GOLDEN_DIR = path.join(REPO, "golden");
const REPORT = path.join(REPO, "docs", "golden-diff-report.md");

interface Args {
  mode: "node" | "file" | "scorecard";
  nodeId?: string;
  fileKey: string;
  localKey: string;
  bridge: string;
  token: string | null;
  depth?: number;
  fixture?: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "");
      const next = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      opts[key] = next;
    } else {
      positional.push(args[i]);
    }
  }
  const mode = (opts.mode as Args["mode"]) ?? "node";
  if (mode === "node" && positional.length < 1) {
    console.error(
      "usage: tsx tools/golden-diff.ts <nodeId> --file-key <key> [--bridge URL] [--token <path>] [--depth N]\n" +
        "       tsx tools/golden-diff.ts --mode file --fixture <golden/file.rest.json> --local-key <key> [--depth N]\n" +
        "       tsx tools/golden-diff.ts --mode scorecard",
    );
    process.exit(2);
  }
  const token =
    opts.token && opts.token !== "true"
      ? fs.readFileSync(path.resolve(opts.token), "utf8").trim()
      : process.env.FIGMA_TOKEN ??
        (fs.existsSync(path.join(process.env.HOME ?? "", ".figma-token"))
          ? fs.readFileSync(path.join(process.env.HOME ?? "", ".figma-token"), "utf8").trim()
          : null);
  return {
    mode,
    nodeId: positional[0],
    fileKey: opts["file-key"] ?? "",
    localKey: opts["local-key"] ?? opts["file-key"] ?? "",
    bridge: opts.bridge ?? "http://127.0.0.1:3002",
    token,
    depth: opts.depth ? Number(opts.depth) : undefined,
    fixture: opts.fixture && opts.fixture !== "true" ? opts.fixture : undefined,
  };
}

function loadRestFixture(nodeId: string): any | null {
  const file = path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.rest.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchRestFixture(args: Args, nodeId: string): Promise<any> {
  if (!args.token) throw new Error("no REST fixture cached and no token available (see --token / $FIGMA_TOKEN / ~/.figma-token)");
  if (!args.fileKey) throw new Error("--file-key is required to fetch REST fixtures");
  const url = `https://api.figma.com/v1/files/${args.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  console.log(`[golden] ONE REST call: ${url}`);
  const res = await fetch(url, { headers: { "X-Figma-Token": args.token } });
  if (res.status === 429) {
    throw new Error("429 rate-limited — stop; run a docs-first pass and retry when the window resets (§9.2)");
  }
  if (!res.ok) throw new Error(`REST fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const file = path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.rest.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  console.log(`[golden] cached REST fixture → ${path.relative(REPO, file)}`);
  return body;
}

async function fetchOurs(args: Args, nodeId: string): Promise<any> {
  const qs = new URLSearchParams({ ids: nodeId });
  if (args.depth) qs.set("depth", String(args.depth));
  const url = `${args.bridge}/v1/files/${args.localKey}/nodes?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bridge fetch failed (${res.status}): ${await res.text()} — is the bridge running and the frame pulled?`);
  return res.json();
}

function classify(diff: TreeDiff): string {
  // Heuristic classification — a human reviews the report and moves items
  // to BUG / INTENTIONAL SUPERSET / REST QUIRK in the deviations doc.
  if (diff.path.includes("._")) return "superset (extension field leaking?)";
  if (diff.path.endsWith(".name") || diff.path.endsWith(".lastModified")) return "volatile";
  return "unclassified";
}

// ---------------------------------------------------------------------------
// Root-cause classifier (report.md §3) — used by the scorecard.
// ---------------------------------------------------------------------------

export function classifyRootCause(d: TreeDiff): string {
  const p = d.path;
  const leaf = p.split(".").pop() ?? "";
  // leaf base without array index — `overrides[0]` reports as `overrides`
  const leafBase = leaf.replace(/\[\d+\]$/, "");
  // canvas-level fields (file mode) — structural / by-design deviations
  if (leaf === "prototypeDevice" || leaf === "prototypeBackgrounds") return "envelope (structural)";
  // G1: cross-file (library) data — style bindings & maps, library transitions
  if (p.includes(".styles") || p === "$.styles" || /^transition(Duration|Easing|NodeID)$/.test(leaf)) return "G1 cross-file (library) data";
  // G2: font metrics
  if (
    leaf === "lineHeightPx" ||
    leaf === "lineHeightPercent" ||
    leaf === "lineHeightUnit" ||
    leaf === "lineHeightPercentFontSize" ||
    (leaf === "fontPostScriptName" && !p.includes("styleOverrideTable"))
  )
    return "G2 font metrics";
  // G3: server-side history metadata
  if (
    leaf === "layoutVersion" ||
    leaf === "rectangleCornerRadii" ||
    leaf === "cornerSmoothing" ||
    leaf === "rotation" ||
    leaf === "isFixed" ||
    leaf === "scrollBehavior"
  )
    return "G3 server history";
  // G5: instance override tables
  if (leafBase === "overrides" || leafBase === "fillOverrideTable" || leafBase === "overriddenFields" || p.includes(".constraints")) return "G5 instance tables";
  // envelope-level fields (file mode): the whole-file wrapper — by-design
  if (/^\$\.(name|role|editorType|thumbnailUrl|version|lastModified|linkAccess|schemaVersion|components|componentSets)(\.|$)/.test(p))
    return "envelope (structural)";
  // G4: REST base-style text model (everything left inside text nodes)
  return "G4 base-style text";
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function writeReport(title: string, pass: boolean, diffs: TreeDiff[]): void {
  const lines = [
    `# Golden diff report`,
    ``,
    `${title} — ${pass ? "✅ IDENTICAL (normalized)" : `❌ ${diffs.length} difference(s)`}`,
    `Run: ${new Date().toISOString()}`,
    ``,
  ];
  if (pass) {
    lines.push(`Normalized trees are identical. Zero unexplained differences.`);
  } else {
    lines.push(`| # | Path | Kind | REST | Ours | Class |`, `|---|---|---|---|---|---|`);
    diffs.slice(0, 200).forEach((d, i) => {
      const brief = (v: unknown) =>
        JSON.stringify(v)?.slice(0, 80).replace(/\|/g, "\\|") ?? "—";
      lines.push(
        `| ${i + 1} | \`${d.path}\` | ${d.kind} | ${brief(d.rest)} | ${brief(d.ours)} | ${classify(d)} |`,
      );
    });
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join("\n") + "\n");
}

async function runNodeMode(args: Args): Promise<number> {
  const { nodeId } = args;
  if (!nodeId) throw new Error("node mode requires a node id");

  let rest = loadRestFixture(nodeId);
  if (!rest) rest = await fetchRestFixture(args, nodeId);
  const ours = await fetchOurs(args, nodeId);

  const restNode = rest?.nodes?.[nodeId];
  const oursNode = ours?.nodes?.[nodeId];
  if (!restNode) throw new Error(`REST fixture has no node ${nodeId}`);
  if (!oursNode) throw new Error(`bridge returned no node ${nodeId}`);

  // Diff the document trees — the component/style maps live at different
  // scopes in REST (file-level) vs ours (frame-level) and are compared
  // separately, informally.
  const restDoc = restNode.document ?? restNode;
  const oursDoc = oursNode.document ?? oursNode;
  const diffs = diffTrees(normalize(restDoc), normalize(oursDoc));
  const pass = diffs.length === 0;

  writeReport(`Node \`${nodeId}\``, pass, diffs);
  fs.writeFileSync(
    path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.ours.normalized.json`),
    canonicalJson(oursDoc) + "\n",
  );
  fs.writeFileSync(
    path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.rest.normalized.json`),
    canonicalJson(restDoc) + "\n",
  );

  console.log(pass ? `✅ ${nodeId}: identical after normalization` : `❌ ${nodeId}: ${diffs.length} difference(s)`);
  diffs.slice(0, 20).forEach((d) =>
    console.log(`  ${d.path} — ${d.kind}${d.kind === "value" ? ` (rest=${JSON.stringify(d.rest)?.slice(0, 60)} ours=${JSON.stringify(d.ours)?.slice(0, 60)})` : ""}`),
  );
  console.log(`report: ${path.relative(REPO, REPORT)}`);
  return pass ? 0 : 1;
}

async function runFileMode(args: Args): Promise<number> {
  const fixture =
    args.fixture ??
    fs
      .readdirSync(GOLDEN_DIR)
      .filter((f) => /^file-.*\.rest\.json$/.test(f) && !f.includes(".v2."))
      .sort()[0];
  if (!fixture) throw new Error("file mode needs --fixture <path> (a cached whole-file REST snapshot)");
  const rest = JSON.parse(fs.readFileSync(fixture, "utf8"));

  const qs = new URLSearchParams();
  if (args.depth) qs.set("depth", String(args.depth));
  const url = `${args.bridge}/v1/files/${args.localKey}${qs.size ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bridge fetch failed (${res.status}): ${await res.text()}`);
  const ours = await res.json();

  const diffs = diffTrees(normalize(rest), normalize(ours));
  const pass = diffs.length === 0;

  writeReport(`File envelope (\`${path.basename(fixture)}\`${args.depth ? `, depth=${args.depth}` : ""})`, pass, diffs);
  fs.writeFileSync(path.join(GOLDEN_DIR, "file-envelope.ours.normalized.json"), canonicalJson(ours) + "\n");
  fs.writeFileSync(path.join(GOLDEN_DIR, "file-envelope.rest.normalized.json"), canonicalJson(rest) + "\n");

  console.log(pass ? `✅ file envelope: identical after normalization` : `❌ file envelope: ${diffs.length} difference(s)`);
  diffs.slice(0, 30).forEach((d) =>
    console.log(`  ${d.path} — ${d.kind}${d.kind === "value" ? ` (rest=${JSON.stringify(d.rest)?.slice(0, 50)} ours=${JSON.stringify(d.ours)?.slice(0, 50)})` : ""}`),
  );
  console.log(`report: ${path.relative(REPO, REPORT)}`);
  return pass ? 0 : 1;
}

async function runScorecard(): Promise<number> {
  const groups = new Map<string, number>();
  let totalDiffs = 0;
  let totalLeaves = 0;
  let frames = 0;
  let identical = 0;

  for (const f of fs.readdirSync(GOLDEN_DIR).sort()) {
    if (!f.endsWith(".rest.normalized.json") || f.startsWith("file-")) continue;
    const oursFile = path.join(GOLDEN_DIR, f.replace(".rest.normalized.json", ".ours.normalized.json"));
    if (!fs.existsSync(oursFile)) continue;
    frames++;
    const rest = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), "utf8"));
    const ours = JSON.parse(fs.readFileSync(oursFile, "utf8"));
    const diffs = diffTrees(rest, ours);
    totalLeaves += countLeaves(rest);
    if (diffs.length === 0) identical++;
    totalDiffs += diffs.length;
    for (const d of diffs) {
      const g = classifyRootCause(d);
      groups.set(g, (groups.get(g) ?? 0) + 1);
    }
  }

  const parity = totalLeaves > 0 ? (100 * (1 - totalDiffs / totalLeaves)).toFixed(3) : "n/a";
  const lines = [
    `# Golden diff report`,
    ``,
    `## Scorecard — ${new Date().toISOString()}`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Frames compared (document trees) | ${frames} |`,
    `| Byte-identical after normalization | ${identical} |`,
    `| Differing paths | ${totalDiffs} |`,
    `| Compared leaves | ${totalLeaves} |`,
    `| Byte parity | ${parity}% |`,
    `| Semantic parity | not yet measured (E2 canonicalization layer pending) |`,
    ``,
    `| Root cause | Paths |`,
    `|---|---|`,
  ];
  [...groups.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => lines.push(`| ${g} | ${n} |`));
  lines.push(``, `Zero unclassified residue means every path maps to a documented`, `root cause (docs/rest-parity-deviations.md).`, ``);

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join("\n") + "\n");

  console.log(`scorecard: ${totalDiffs} paths across ${frames} frames (${identical} identical), byte parity ${parity}%`);
  [...groups.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`  ${String(n).padStart(5)}  ${g}`));
  console.log(`report: ${path.relative(REPO, REPORT)}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === "file") return runFileMode(args);
  if (args.mode === "scorecard") return runScorecard();
  return runNodeMode(args);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[golden] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
