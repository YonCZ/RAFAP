/**
 * Round 4 (G1) + Round 5 (D4) — bootstrap the library-style join table and
 * the per-file prototype-transition table from a saved REST file envelope.
 *
 * The envelope's styles map is itself the join table: the map key is the
 * library node id REST keys remote styles by, the `key` field is the
 * 40-hex publish key the plugin sees from the consumer side. The
 * document tree additionally yields the file's transition records
 * (`transitionNodeID`/`Duration`/`Easing` — server-side state the plugin
 * cannot see, deviation #16). One run per file; the result is cached in
 * `store/libraries/bootstrap_<key>.json` and refreshed only by re-running
 * (or by the bridge's live auto bootstrap on the next fresh pull).
 *
 * Usage:
 *   npx tsx tools/bootstrap-library-styles.ts <path/to/rest-envelope.json>
 *
 * The envelope JSON must be a GET /v1/files/:key response body (its
 * top-level `styles` map and `document` tree are mined; `fileKey` is read
 * from the filename for labeling).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeRestBootstrap } from "../lib/library-harvest.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: npx tsx tools/bootstrap-library-styles.ts <rest-envelope.json>");
    process.exit(1);
  }
  const env = JSON.parse(fs.readFileSync(input, "utf8"));
  const styles = env?.styles;
  if (!styles || typeof styles !== "object") {
    console.error("envelope has no styles map — is this a /v1/files/:key body?");
    process.exit(1);
  }
  const remoteCount = Object.values(styles).filter((s: any) => s?.remote === true).length;
  const fileKey =
    typeof process.argv[3] === "string"
      ? process.argv[3]
      : path.basename(input).replace(/^file-/, "").replace(/\.rest\.json$|\.json$/, "");
  const harvest = writeRestBootstrap(path.join(ROOT, "store", "libraries"), fileKey, env);
  if (!harvest) {
    console.error("styles map had no joinable entries (node id + 40-hex key)");
    process.exit(1);
  }
  console.log(
    `bootstrapped ${fileKey}: ${Object.keys(harvest.styles).length} style ids ` +
      `(${remoteCount} remote)` +
      (harvest.transitions ? `, ${Object.keys(harvest.transitions).length} transitions` : "") +
      ` → store/libraries/bootstrap_${fileKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
  );
}

main();
