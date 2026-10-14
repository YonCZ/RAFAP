/**
 * Unit tests for the bridge-side envelope stitching (agent.md §7.1, §8.5).
 */
import { describe, expect, it } from "vitest";
import { buildFileEnvelope, buildNodesResponse, frameFileName, pruneDepth } from "../lib/stitch";

const page = (id: string, ...children: { id: string; name: string }[]) => ({
  id,
  name: `Page ${id}`,
  type: "CANVAS" as const,
  backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
  children: children.map((c) => ({ ...c, type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } })),
});

const frame = (id: string, name: string) => ({
  id,
  name,
  document: { id, name, type: "FRAME", visible: true, children: [{ id: `${id}.1`, type: "TEXT", children: [] }] },
  components: { "c:1": { key: "c:1", name: "Button" } },
  componentSets: {},
  styles: { "s:1": { key: "s:1", name: "Primary", styleType: "FILL" } },
  schemaVersion: 0,
  _figmaAgent: { extractedAt: "2026-10-15T00:00:00Z", source: "plugin" },
});

describe("frameFileName", () => {
  it("makes node ids filename-safe and reversible within our convention", () => {
    expect(frameFileName("247:448")).toBe("247_448");
  });
});

describe("pruneDepth", () => {
  it("cuts children past the depth limit", () => {
    const tree = { id: "1", children: [{ id: "2", children: [{ id: "3", children: [] }] }] };
    expect(pruneDepth(tree, 1)).toEqual({ id: "1", children: [{ id: "2" }] as any, ...{} });
    expect(pruneDepth(tree, 0)).toEqual({ id: "1" });
  });
});

describe("buildFileEnvelope", () => {
  it("produces the DOCUMENT → CANVAS → children structure with aggregated maps", () => {
    const env = buildFileEnvelope(
      { fileKey: "KEY", pages: [page("0:1", { id: "1:1", name: "A" }, { id: "1:2", name: "B" })] },
      [frame("1:1", "A"), frame("1:2", "B")],
    );
    const canvas = (env.document as any).children[0];
    expect(canvas.type).toBe("CANVAS");
    expect(canvas.children.map((c: any) => c.id)).toEqual(["1:1", "1:2"]);
    expect((env.components as any)["c:1"].name).toBe("Button");
    expect((env.styles as any)["s:1"].name).toBe("Primary");
    expect(env.schemaVersion).toBe(0);
    expect(env.role).toBe("owner");
  });

  it("unextracted frames appear as stubs (partial pulls stay coherent)", () => {
    const env = buildFileEnvelope(
      { fileKey: "KEY", pages: [page("0:1", { id: "1:1", name: "A" })] },
      [], // nothing extracted yet
    );
    const child = (env.document as any).children[0].children[0];
    expect(child.id).toBe("1:1");
    expect(child.children).toEqual([]);
  });

  it("?ids filters top-level children", () => {
    const env = buildFileEnvelope(
      { fileKey: "KEY", pages: [page("0:1", { id: "1:1", name: "A" }, { id: "1:2", name: "B" })] },
      [frame("1:1", "A"), frame("1:2", "B")],
      { ids: ["1:2"] },
    );
    expect((env.document as any).children[0].children.map((c: any) => c.id)).toEqual(["1:2"]);
  });
});

describe("buildNodesResponse", () => {
  it("nests each tree under nodes[id].document with err: null (the asymmetry!)", () => {
    const res = buildNodesResponse([frame("1:1", "A")]);
    expect(res.err).toBeNull();
    expect((res.nodes as any)["1:1"].document.id).toBe("1:1");
    expect((res.nodes as any)["1:1"].components["c:1"].name).toBe("Button");
    expect((res.nodes as any)["1:1"].name).toBe("A");
  });
});
