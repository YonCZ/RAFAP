/**
 * Golden-diff harness (agent.md §9) — proves REST parity instead of
 * assuming it.
 *
 *   npx tsx tools/golden-diff.ts <nodeId> --file-key <key> [options]
 *
 * For one Figma node id:
 *   1. Loads the REST fixture from golden/<nodeId>.rest.json. If absent
 *      (and a token is available) fetches it ONCE from api.figma.com and
 *      caches it — never more than one REST call per run (§9.2).
 *   2. Fetches our payload from the local bridge (/v1/files/:key/nodes).
 *   3. Normalizes both trees and deep-compares.
 *   4. Writes docs/golden-diff-report.md and prints the summary.
 *
 * Token resolution: --token <path>, $FIGMA_TOKEN, or ~/.figma-token.
 * Rate-limit discipline: on 429 the tool stops and tells you to retry
 * later — it never loops.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, diffTrees, normalize, type TreeDiff } from "./normalize.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(ROOT);
const GOLDEN_DIR = path.join(REPO, "golden");
const REPORT = path.join(REPO, "docs", "golden-diff-report.md");

interface Args {
  nodeId: string;
  fileKey: string;
  bridge: string;
  token: string | null;
  depth?: number;
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
  if (positional.length < 1) {
    console.error("usage: tsx tools/golden-diff.ts <nodeId> --file-key <key> [--bridge URL] [--token <path>] [--depth N]");
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
    nodeId: positional[0],
    fileKey: opts["file-key"] ?? "",
    bridge: opts.bridge ?? "http://127.0.0.1:3002",
    token,
    depth: opts.depth ? Number(opts.depth) : undefined,
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
  const url = `${args.bridge}/v1/files/${args.fileKey}/nodes?${qs}`;
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

async function main() {
  const args = parseArgs(process.argv);
  const { nodeId } = args;

  let rest = loadRestFixture(nodeId);
  if (!rest) rest = await fetchRestFixture(args, nodeId);
  const ours = await fetchOurs(args, nodeId);

  const restNode = rest?.nodes?.[nodeId];
  const oursNode = ours?.nodes?.[nodeId];
  if (!restNode) throw new Error(`REST fixture has no node ${nodeId}`);
  if (!oursNode) throw new Error(`bridge returned no node ${nodeId}`);

  const diffs = diffTrees(normalize(restNode), normalize(oursNode));
  const pass = diffs.length === 0;

  const lines = [
    `# Golden diff report`,
    ``,
    `Node \`${nodeId}\` — ${pass ? "✅ IDENTICAL (normalized)" : `❌ ${diffs.length} difference(s)`}`,
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
  fs.writeFileSync(
    path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.ours.normalized.json`),
    canonicalJson(oursNode) + "\n",
  );
  fs.writeFileSync(
    path.join(GOLDEN_DIR, `${nodeId.replace(/:/g, "_")}.rest.normalized.json`),
    canonicalJson(restNode) + "\n",
  );

  console.log(pass ? `✅ ${nodeId}: identical after normalization` : `❌ ${nodeId}: ${diffs.length} difference(s)`);
  diffs.slice(0, 20).forEach((d) =>
    console.log(`  ${d.path} — ${d.kind}${d.kind === "value" ? ` (rest=${JSON.stringify(d.rest)?.slice(0, 60)} ours=${JSON.stringify(d.ours)?.slice(0, 60)})` : ""}`),
  );
  console.log(`report: ${path.relative(REPO, REPORT)}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`[golden] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
