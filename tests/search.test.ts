import { describe, expect, it } from "vitest";
import { searchNodes, type SearchableFrame } from "../lib/search.js";

function frame(overrides: Partial<SearchableFrame> = {}): SearchableFrame {
  return {
    id: "10:1",
    name: "Hero",
    document: {
      id: "10:1",
      name: "Hero",
      type: "FRAME",
      children: [
        {
          id: "10:2",
          name: "Headline",
          type: "TEXT",
          characters: "Design faster with RAFAP",
          children: [
            { id: "10:3", name: "Glyph", type: "VECTOR", children: [] },
          ],
        },
        { id: "10:4", name: "CTA Button", type: "INSTANCE", children: [] },
        { id: "10:5", name: "avatar.png", type: "RECTANGLE", children: [] },
      ],
    },
    ...overrides,
  };
}

describe("searchNodes", () => {
  it("matches node names case-insensitively", () => {
    const hits = searchNodes([frame()], { query: "cta" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "10:4", type: "INSTANCE", matchedOn: "name", frameId: "10:1" });
  });

  it("matches TEXT content and previews it", () => {
    const hits = searchNodes([frame()], { query: "rafap" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "10:2", matchedOn: "text", characters: "Design faster with RAFAP" });
  });

  it("matches by node type, case-insensitive", () => {
    const hits = searchNodes([frame()], { type: "vector" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "10:3", matchedOn: "type" });
  });

  it("ANDs query and type when both are given", () => {
    expect(searchNodes([frame()], { query: "avatar", type: "TEXT" })).toHaveLength(0);
    expect(searchNodes([frame()], { query: "headline", type: "text" })).toHaveLength(1);
  });

  it("walks into stored subtrees and reports the frame they live in", () => {
    const deep = frame({
      id: "99:1",
      name: "Deep Frame",
      document: {
        id: "99:1",
        name: "Deep Frame",
        type: "FRAME",
        children: [
          { id: "99:2", name: "Outer", type: "GROUP", children: [
            { id: "99:3", name: "Inner", type: "FRAME", children: [] },
          ] },
        ],
      },
    });
    const hits = searchNodes([frame(), deep], { type: "FRAME" });
    expect(hits.map((h) => h.id).sort()).toEqual(["10:1", "99:1", "99:3"]);
    const inner = hits.find((h) => h.id === "99:3")!;
    expect(inner.frameId).toBe("99:1");
    expect(inner.frameName).toBe("Deep Frame");
  });

  it("caps results at the limit (default 50)", () => {
    const many: SearchableFrame = {
      id: "1:1",
      name: "Many",
      document: {
        id: "1:1",
        name: "Many",
        type: "FRAME",
        children: Array.from({ length: 80 }, (_, i) => ({ id: `1:${i + 2}`, name: `Row ${i}`, type: "TEXT", characters: "x" })),
      },
    };
    expect(searchNodes([many], { type: "TEXT" })).toHaveLength(50);
    expect(searchNodes([many], { type: "TEXT", limit: 10 })).toHaveLength(10);
  });

  it("carries the fileKey through when present", () => {
    const hits = searchNodes([frame({ fileKey: "local-x" })], { query: "hero" });
    expect(hits[0].fileKey).toBe("local-x");
  });

  it("throws when no criterion is given (that would be a node dump)", () => {
    expect(() => searchNodes([frame()], {})).toThrow(/query.*type|type.*query/i);
  });

  it("truncates long text previews at 60 characters", () => {
    const long: SearchableFrame = {
      id: "2:1",
      name: "Long",
      document: {
        id: "2:1",
        name: "Long",
        type: "FRAME",
        children: [
          { id: "2:2", name: "Body", type: "TEXT", characters: "y".repeat(100) },
        ],
      },
    };
    const hits = searchNodes([long], { query: "y" });
    expect(hits[0].characters).toHaveLength(61); // 60 + ellipsis
    expect(hits[0].characters!.endsWith("…")).toBe(true);
  });
});
