import { describe, expect, it } from "vitest";
import { buildOutline, type OutlinableFrame } from "../lib/outline.js";

function frame(overrides: Partial<OutlinableFrame> = {}): OutlinableFrame {
  return {
    id: "10:1",
    name: "Hero",
    document: {
      id: "10:1",
      name: "Hero",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 1200, height: 800 },
      children: [
        {
          id: "10:2",
          name: "Top Nav",
          type: "FRAME",
          layoutMode: "HORIZONTAL",
          itemSpacing: 12,
          paddingLeft: 24,
          paddingRight: 24,
          absoluteBoundingBox: { x: 0, y: 0, width: 1200.4, height: 79.6 },
          children: [
            { id: "10:3", name: "Quest", type: "TEXT", characters: "Quest", absoluteBoundingBox: { x: 0, y: 0, width: 60.2, height: 24 } },
            { id: "10:4", name: "Board", type: "TEXT", characters: "Board", absoluteBoundingBox: { x: 0, y: 0, width: 58, height: 24 } },
          ],
        },
        {
          id: "10:5",
          name: "Left Panel",
          type: "FRAME",
          layoutMode: "VERTICAL",
          absoluteBoundingBox: { x: 0, y: 0, width: 537, height: 700 },
          children: [
            { id: "10:6", name: "Headline", type: "TEXT", characters: "Truth score: 82%", absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 32 } },
            { id: "10:7", name: "Icon", type: "VECTOR", visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 16, height: 16 } },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("buildOutline", () => {
  it("renders a header with id, name, type, size and node count", () => {
    const out = buildOutline([frame()]);
    const [header] = out.split("\n");
    expect(header).toBe('== 10:1 "Hero" · FRAME · 1200x800 · 6 nodes ==');
  });

  it("walks every child at increasing depth with names, ids, types and sizes", () => {
    const lines = buildOutline([frame()]).split("\n");
    expect(lines[1]).toBe('"Top Nav" · 10:2 · FRAME · 1200x80 · 2 ch · auto:H gap 12 pad R24 L24');
    expect(lines[2]).toBe('  "Quest" · 10:3 · TEXT · 60x24');
    expect(lines[4]).toBe('"Left Panel" · 10:5 · FRAME · 537x700 · 2 ch · auto:V');
  });

  it("renders TEXT characters, not the layer name", () => {
    const lines = buildOutline([frame()]).split("\n");
    expect(lines[5]).toBe('  "Truth score: 82%" · 10:6 · TEXT · 400x32');
  });

  it("marks hidden nodes", () => {
    const lines = buildOutline([frame()]).split("\n");
    expect(lines[6]).toBe('  "Icon" · 10:7 · VECTOR · 16x16 · [hidden]');
  });

  it("normalizes whitespace and truncates long TEXT content", () => {
    const f = frame();
    (f.document as any).children = [
      {
        id: "20:1",
        name: "Paragraph",
        type: "TEXT",
        characters: `line one\n\nline   two\ttabbed ${"x".repeat(100)}`,
        children: [],
      },
    ];
    const line = buildOutline([f]).split("\n")[1];
    expect(line).not.toMatch(/\n/);
    expect(line.startsWith('"line one line two tabbed xxx')).toBe(true);
    expect(line.length).toBeLessThan(140);
    expect(line.endsWith('…" · 20:1 · TEXT')).toBe(true);
  });

  it("omits size when absoluteBoundingBox is missing", () => {
    const f = frame();
    (f.document as any).children = [{ id: "30:1", name: "Ghost", type: "RECTANGLE", children: [] }];
    const line = buildOutline([f]).split("\n")[1];
    expect(line).toBe('"Ghost" · 30:1 · RECTANGLE');
  });

  it("caps nodes per frame and says so", () => {
    const f = frame();
    const kids = Array.from({ length: 50 }, (_, i) => ({ id: `40:${i}`, name: `N${i}`, type: "RECTANGLE", children: [] }));
    (f.document as any).children = kids;
    const out = buildOutline([f], { maxNodes: 10 });
    const lines = out.split("\n");
    expect(lines).toHaveLength(12); // header + 10 nodes + truncation note
    expect(lines[0]).toMatch(/== 10:1 "Hero" · FRAME · 1200x800 · 10\+ nodes ==/);
    expect(lines[11]).toMatch(/^… outline truncated at 10 nodes/);
  });

  it("omits auto-layout summary for absolutely positioned nodes and zero paddings", () => {
    const f = frame();
    (f.document as any).children = [
      { id: "50:1", name: "Abs", type: "FRAME", layoutMode: "NONE", paddingTop: 0, itemSpacing: 0, children: [] },
    ];
    const line = buildOutline([f]).split("\n")[1];
    expect(line).toBe('"Abs" · 50:1 · FRAME');
  });

  it("handles a document with no children and non-object documents", () => {
    const out = buildOutline([
      { id: "60:1", name: "Empty", document: { id: "60:1", name: "Empty", type: "FRAME", children: [] } },
      { id: "60:2", name: "Broken", document: null as unknown as Record<string, unknown> },
    ]);
    const [a, b] = out.split("\n\n");
    expect(a).toBe('== 60:1 "Empty" · FRAME · 0 nodes ==');
    expect(b).toBe('== 60:2 "Broken" · FRAME · 0 nodes ==');
  });

  it("separates frames with a blank line and joins many frames", () => {
    const out = buildOutline([frame(), frame()]);
    expect(out.split("\n\n")).toHaveLength(2);
  });
});

describe("outline auto-layout intent tokens (Round 15)", () => {
  it("shows hug/fill sizing and non-default alignment", () => {
    const doc = {
      id: "20:1",
      name: "Intent",
      type: "FRAME",
      children: [
        {
          id: "20:2",
          name: "Fill Row",
          type: "FRAME",
          layoutMode: "HORIZONTAL",
          itemSpacing: 12,
          layoutSizingHorizontal: "FILL",
          layoutSizingVertical: "HUG",
          primaryAxisAlignItems: "CENTER",
          counterAxisAlignItems: "BASELINE",
          absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 50 },
          children: [],
        },
        {
          id: "20:3",
          name: "Plain",
          type: "FRAME",
          layoutMode: "VERTICAL",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          children: [],
        },
      ],
    };
    const out = buildOutline([{ id: "20:1", name: "Intent", document: doc }]);
    const fillRow = out.split("\n").find((l) => l.includes("20:2"))!;
    expect(fillRow).toContain("auto:H gap 12");
    expect(fillRow).toContain("size V:hug H:fill");
    expect(fillRow).toContain("align main:center cross:baseline");
    const plain = out.split("\n").find((l) => l.includes("20:3"))!;
    expect(plain).toBe('"Plain" · 20:3 · FRAME · 100x100 · auto:V'); // FIXED/MIN defaults stay implicit
  });

  it("resolves legacy sizing fields via layoutMode", () => {
    const doc = {
      id: "30:1",
      name: "Legacy",
      type: "FRAME",
      children: [
        {
          id: "30:2",
          name: "Old",
          type: "FRAME",
          layoutMode: "VERTICAL",
          primaryAxisSizingMode: "FIXED",
          counterAxisSizingMode: "FILL",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          children: [],
        },
      ],
    };
    const out = buildOutline([{ id: "30:1", name: "Legacy", document: doc }]);
    expect(out).toContain("size V:fixed H:fill");
  });
});
