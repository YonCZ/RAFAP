// Round 16.2 — multi-window selection fan-out merge (lib/selection-merge.ts).
import { describe, expect, it } from "vitest";
import { formatSelectionOptions, mergeSelectionLists, selectionFileCount } from "../lib/selection-merge.js";

const sel = (id: string, name: string, fileKey: string) => ({ id, name, fileKey, document: {} });

describe("mergeSelectionLists", () => {
  it("keeps every distinct frame, first answer wins, order preserved", () => {
    const a = [sel("76:657", "Board Screen", "local-a"), sel("5:2", "Sidebar", "local-a")];
    const b = [sel("9:1", "Doomsroller", "local-b")];
    const merged = mergeSelectionLists([a, b]);
    expect(merged.map((f) => f.id)).toEqual(["76:657", "5:2", "9:1"]);
  });

  it("dedupes by fileKey + frame id — same frame from two windows collapses to one", () => {
    const a = [sel("76:657", "Board Screen", "local-a")];
    const b = [sel("76:657", "Board Screen", "local-a"), sel("1:9", "Other", "local-a")];
    const merged = mergeSelectionLists([a, b, a]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(a[0]); // first answer wins, not a copy
  });

  it("same id in different files is two distinct frames", () => {
    const merged = mergeSelectionLists([[sel("5:2", "A", "local-a")], [sel("5:2", "B", "local-b")]]);
    expect(merged).toHaveLength(2);
    expect(selectionFileCount(merged)).toBe(2);
  });

  it("drops entries without a string id and skips non-array answers", () => {
    const merged = mergeSelectionLists([
      [null, { name: "no id" }, sel("1:1", "Ok", "local-a"), { id: 42 }],
      "not an array" as unknown as unknown[],
    ]);
    expect(merged.map((f) => f.id)).toEqual(["1:1"]);
  });

  it("treats a missing fileKey as its own (single) file", () => {
    const merged = mergeSelectionLists([[sel("1:1", "A", ""), sel("1:2", "B", "")]]);
    expect(selectionFileCount(merged)).toBe(1);
  });
});

describe("selectionFileCount", () => {
  it("is 0 for an empty list and 1 for a single file", () => {
    expect(selectionFileCount([])).toBe(0);
    expect(selectionFileCount([sel("1:1", "A", "local-a"), sel("1:2", "B", "local-a")])).toBe(1);
  });
});

describe("formatSelectionOptions", () => {
  it("lists one bullet per frame with name, id and fileKey, grouped by file", () => {
    const out = formatSelectionOptions([
      sel("76:657", "Board Screen", "local-a"),
      sel("5:2", "Doomsroller", "local-b"),
      sel("5:3", "Icons", "local-a"),
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    // grouped by file (insertion order), each file's frames together
    expect(lines[0]).toBe('- "Board Screen" (76:657) — local-a');
    expect(lines[1]).toBe('- "Icons" (5:3) — local-a');
    expect(lines[2]).toBe('- "Doomsroller" (5:2) — local-b');
  });

  it("falls back to the id when the name is missing and marks unknown files", () => {
    const out = formatSelectionOptions([{ id: "7:7" }]);
    expect(out).toBe('- "7:7" (7:7) — (unknown file)');
  });
});
