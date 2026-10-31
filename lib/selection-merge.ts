// Round 16.2 — multi-window selection fan-out (merge + options).
//
// Field report: with two Figma windows each running the plugin, a single
// `selection` command lands on whichever window's long-poll wins the
// race — the agent gets the WRONG window's selection ~50% of the time.
// The fix: fire a burst of selection commands, merge the answers, and
// dedupe by fileKey + frame id. When the answers span more than one
// file, the agent must ask which frame to build — never guess.

export interface SelectionLike {
  id?: string;
  name?: string;
  fileKey?: string;
}

/**
 * Merge selection answers from any number of commands: keep every
 * distinct (fileKey, frame id) pair, first answer wins, order
 * preserved. Anything without a string id is dropped; non-arrays are
 * skipped. The same frame selected in two windows of the SAME file
 * collapses to one entry.
 */
export function mergeSelectionLists<T extends SelectionLike>(lists: unknown[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== "object") continue;
      const s = f as SelectionLike;
      if (typeof s.id !== "string" || !s.id) continue;
      const key = `${typeof s.fileKey === "string" ? s.fileKey : ""}\u0000${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f as T);
    }
  }
  return out;
}

/** Distinct fileKeys among the merged frames ("" counts as one file). */
export function selectionFileCount(frames: SelectionLike[]): number {
  return new Set(frames.map((f) => (typeof f.fileKey === "string" ? f.fileKey : ""))).size;
}

/**
 * Human-readable options list for the multi-file ask-back, grouped by
 * file: one bullet per frame, `"Name" (id) — fileKey`. Unknown names
 * fall back to the id.
 */
export function formatSelectionOptions(frames: SelectionLike[]): string {
  const byFile = new Map<string, SelectionLike[]>();
  for (const f of frames) {
    const fk = typeof f.fileKey === "string" ? f.fileKey : "";
    if (!byFile.has(fk)) byFile.set(fk, []);
    byFile.get(fk)!.push(f);
  }
  const lines: string[] = [];
  for (const [fk, list] of byFile) {
    for (const f of list) {
      const name = typeof f.name === "string" && f.name ? f.name : f.id;
      lines.push(`- "${name}" (${f.id}) — ${fk || "(unknown file)"}`);
    }
  }
  return lines.join("\n");
}
