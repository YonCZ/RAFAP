/**
 * Unit tests for the Round 4 library harvester (lib/library-harvest.ts):
 * harvest persistence, join-table loading, and the consumer-side rewrite.
 */
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyTransitionTable,
  collectUnresolvedStyles,
  hasRestBootstrap,
  loadLibraryIndex,
  loadTransitionTable,
  rewriteFrameStyles,
  writeLibraryHarvest,
  writeRestBootstrap,
} from "../lib/library-harvest.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rafap-libharvest-"));
afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

/** A page-index styles map as the plugin emits it (nodeId-keyed). */
const LIBRARY_STYLES = {
  "36:572": {
    key: "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
    name: "Icon/Icon Grid",
    description: "",
    remote: false,
    styleType: "GRID",
  },
  "10:876": {
    key: "d46730e73ebb93963a0a58eb4c57627f1973b89b",
    name: "Heading/H1",
    description: "",
    remote: false,
    styleType: "TEXT",
  },
};

function consumerFrame(): any {
  return {
    id: "180:304",
    name: "Frame A",
    fileKey: "local-consumer",
    styles: {
      "776:35": {
        key: "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
        name: "Icon/Icon Grid",
        description: "",
        remote: true,
        styleType: "GRID",
      },
      "910:2": {
        key: "6bf7658826803110607706d89878a6cdc8503c93",
        name: "Purple-main",
        description: "",
        remote: false,
        styleType: "FILL",
      },
      "500:1": {
        key: "0000000000000000000000000000000000000000",
        name: "Not/Harvested",
        description: "",
        remote: true,
        styleType: "FILL",
      },
    },
    document: {
      id: "180:304",
      type: "FRAME",
      children: [
        { id: "180:305", type: "RECTANGLE", styles: { grid: "776:35" } },
        {
          id: "180:306",
          type: "GROUP",
          children: [{ id: "180:307", type: "TEXT", styles: { fill: "910:2", text: "500:1" } }],
        },
      ],
    },
  };
}

describe("writeLibraryHarvest", () => {
  it("persists a key-keyed join table from the nodeId-keyed plugin map", () => {
    const harvest = writeLibraryHarvest(TMP, "lib-key-1", LIBRARY_STYLES);
    expect(harvest).not.toBeNull();
    expect(Object.keys(harvest!.styles)).toEqual([
      "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
      "d46730e73ebb93963a0a58eb4c57627f1973b89b",
    ]);
    expect(harvest!.styles["bccec8610eaa78b9e79480f8026fa2f055cd2b52"]).toEqual({
      nodeId: "36:572",
      name: "Icon/Icon Grid",
      description: "",
      styleType: "GRID",
    });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(TMP, "lib-key-1.json"), "utf8"),
    );
    expect(onDisk.fileKey).toBe("lib-key-1");
    expect(onDisk.harvestedAt).toBe(harvest!.harvestedAt);
  });

  it("writes nothing for a file with no styles", () => {
    expect(writeLibraryHarvest(TMP, "empty", {})).toBeNull();
    expect(fs.readdirSync(TMP)).toEqual([]);
  });

  it("replaces a previous harvest wholesale (snapshot semantics)", () => {
    writeLibraryHarvest(TMP, "lib-key-1", LIBRARY_STYLES);
    writeLibraryHarvest(TMP, "lib-key-1", {
      "36:999": { ...LIBRARY_STYLES["36:572"], key: "ff".repeat(20) },
    });
    const index = loadLibraryIndex(TMP);
    expect(index.size).toBe(1);
    expect(index.get("ff".repeat(20))?.nodeId).toBe("36:999");
  });
});

describe("loadLibraryIndex", () => {
  it("merges every harvested library", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    writeLibraryHarvest(TMP, "lib-b", {
      "1:1": { key: "ab".repeat(20), name: "Other", description: "", remote: false, styleType: "FILL" },
    });
    const index = loadLibraryIndex(TMP);
    expect(index.size).toBe(3);
    expect(index.get("ab".repeat(20))?.name).toBe("Other");
  });

  it("returns empty for a missing directory and skips corrupt files", () => {
    expect(loadLibraryIndex(path.join(TMP, "nope")).size).toBe(0);
    fs.writeFileSync(path.join(TMP, "corrupt.json"), "{not json");
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    expect(loadLibraryIndex(TMP).size).toBe(2);
  });

  it("never loads placeholder node ids into the join table", () => {
    // a poisoned harvest (written before the S:-guard) must not enter the
    // index even though the file exists on disk
    fs.writeFileSync(
      path.join(TMP, "poisoned.json"),
      JSON.stringify({
        fileKey: "poisoned",
        harvestedAt: "2026-10-17T00:00:00.000Z",
        styles: {
          "6bf7658826803110607706d89878a6cdc8503c93": {
            nodeId: "S:6bf7658826803110607706d89878a6cdc8503c93,",
            name: "Purple-main",
            description: "",
            styleType: "PAINT",
          },
          abababababababababababababababababababab: {
            nodeId: "",
            name: "empty",
            description: "",
            styleType: "FILL",
          },
        },
      }),
    );
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const index = loadLibraryIndex(TMP);
    expect(index.size).toBe(2); // only the two legit entries
    expect(index.has("6bf7658826803110607706d89878a6cdc8503c93")).toBe(false);
  });
});

describe("rewriteFrameStyles", () => {
  it("re-keys remote entries to library node ids and renames bindings", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const frame = consumerFrame();
    const { resolved, unresolved } = rewriteFrameStyles(frame, loadLibraryIndex(TMP));
    expect(resolved).toBe(1);
    expect(Object.keys(frame.styles)).toContain("36:572");
    expect(frame.styles["36:572"]).toEqual({
      key: "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
      name: "Icon/Icon Grid",
      description: "",
      remote: true,
      styleType: "GRID",
    });
    // marker id gone, metadata kept verbatim from the consumer copy
    expect(frame.styles["776:35"]).toBeUndefined();
    // nested binding renamed to the library node id
    expect(frame.document.children[0].styles.grid).toBe("36:572");
    // local + unresolved-remote bindings untouched
    expect(frame.document.children[1].children[0].styles.fill).toBe("910:2");
    expect(frame.document.children[1].children[0].styles.text).toBe("500:1");
    expect(unresolved).toEqual([
      { key: "0000000000000000000000000000000000000000", name: "Not/Harvested", usedBy: ["180:307"] },
    ]);
  });

  it("is idempotent (rewriting stored output changes nothing)", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const frame = consumerFrame();
    const index = loadLibraryIndex(TMP);
    rewriteFrameStyles(frame, index);
    const once = JSON.stringify(frame);
    const second = rewriteFrameStyles(frame, index);
    expect(JSON.stringify(frame)).toBe(once);
    expect(second.resolved).toBe(1); // still counts the (stable) mapping
    expect(second.unresolved).toEqual([
      { key: "0000000000000000000000000000000000000000", name: "Not/Harvested", usedBy: ["180:307"] },
    ]);
  });

  it("is a no-op for frames without remote styles or a styles map", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const index = loadLibraryIndex(TMP);
    const localOnly = {
      styles: { "910:2": LIBRARY_STYLES["36:572"] },
      document: { id: "1:1", children: [] },
    };
    expect(rewriteFrameStyles(localOnly, index)).toEqual({ resolved: 0, unresolved: [] });
    const bare = { id: "1:2", document: { id: "1:2" } };
    expect(rewriteFrameStyles(bare, index)).toEqual({ resolved: 0, unresolved: [] });
  });

  it("lists a node once in usedBy even with several bindings to the same style", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const frame = {
      styles: {
        "500:1": {
          key: "0000000000000000000000000000000000000000",
          name: "Not/Harvested",
          description: "",
          remote: true,
          styleType: "FILL",
        },
      },
      document: {
        id: "9:9",
        type: "FRAME",
        children: [{ id: "9:10", type: "RECTANGLE", styles: { fill: "500:1", stroke: "500:1" } }],
      },
    };
    const { unresolved } = rewriteFrameStyles(frame, loadLibraryIndex(TMP));
    expect(unresolved).toEqual([
      { key: "0000000000000000000000000000000000000000", name: "Not/Harvested", usedBy: ["9:10"] },
    ]);
  });
});

describe("rest bootstrap", () => {
  const REST_ENVELOPE_STYLES = {
    "36:572": {
      key: "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
      name: "Icon/Icon Grid",
      styleType: "GRID",
      remote: true,
      description: "",
    },
    "67:659": {
      key: "6bf7658826803110607706d89878a6cdc8503c93",
      name: "Purple-main",
      styleType: "FILL",
      remote: false,
      description: "",
    },
  };

  it("writeRestBootstrap mines the join from a REST envelope styles map", () => {
    const harvest = writeRestBootstrap(TMP, "real-key-1", { styles: REST_ENVELOPE_STYLES });
    expect(harvest).not.toBeNull();
    expect(harvest!.source).toBe("rest-bootstrap");
    expect(harvest!.styles["bccec8610eaa78b9e79480f8026fa2f055cd2b52"]).toEqual({
      nodeId: "36:572",
      name: "Icon/Icon Grid",
      description: "",
      styleType: "GRID",
    });
    expect(fs.existsSync(path.join(TMP, "bootstrap_real-key-1.json"))).toBe(true);
  });

  it("hasRestBootstrap detects the cache; degenerate entries are skipped", () => {
    expect(hasRestBootstrap(TMP, "real-key-1")).toBe(false);
    writeRestBootstrap(TMP, "real-key-1", { styles: REST_ENVELOPE_STYLES });
    expect(hasRestBootstrap(TMP, "real-key-1")).toBe(true);
    const harvest = writeRestBootstrap(TMP, "real-key-2", {
      styles: {
        "": { key: "ab".repeat(20), name: "no node id", styleType: "FILL" },
        "1:1": { key: "", name: "no publish key", styleType: "FILL" },
      },
    });
    expect(harvest).toBeNull();
  });

  it("the rewrite repairs degenerate local markers via the bootstrap join", () => {
    writeRestBootstrap(TMP, "real-key-1", { styles: REST_ENVELOPE_STYLES });
    const frame = {
      // live plugin emission: Purple-main's marker is the empty string
      styles: {
        "": {
          key: "6bf7658826803110607706d89878a6cdc8503c93",
          name: "Purple-main",
          description: "",
          remote: false,
          styleType: "PAINT",
        },
      },
      document: {
        id: "5:1",
        type: "FRAME",
        children: [{ id: "5:2", type: "RECTANGLE", styles: { fill: "" } }],
      },
    };
    const { resolved, unresolved } = rewriteFrameStyles(frame as any, loadLibraryIndex(TMP));
    expect(resolved).toBe(0); // local — not counted as remote resolution
    expect(unresolved).toEqual([]);
    expect((frame.styles as any)["67:659"]).toBeDefined();
    expect((frame.styles as any)[""]).toBeUndefined();
    expect((frame.document as any).children[0].styles.fill).toBe("67:659");
  });
});

describe("prototype transition table (Round 5 D4)", () => {
  const ENV = {
    styles: {
      "36:572": {
        key: "bccec8610eaa78b9e79480f8026fa2f055cd2b52",
        name: "Icon/Icon Grid",
        styleType: "GRID",
        remote: true,
        description: "",
      },
    },
    document: {
      id: "0:1",
      type: "DOCUMENT",
      children: [
        {
          id: "0:2",
          type: "CANVAS",
          children: [
            {
              id: "180:335",
              type: "INSTANCE",
              transitionNodeID: "10:1098",
              transitionDuration: 300,
              transitionEasing: "EASE_OUT",
              children: [{ id: "180:336", type: "RECTANGLE" }],
            },
          ],
        },
      ],
    },
  };

  it("writeRestBootstrap mines transitions from the document tree", () => {
    const harvest = writeRestBootstrap(TMP, "real-key-1", ENV);
    expect(harvest!.transitions).toEqual({
      "180:335": { transitionNodeID: "10:1098", transitionDuration: 300, transitionEasing: "EASE_OUT" },
    });
  });

  it("loadTransitionTable is scoped to the file's own bootstrap only", () => {
    writeRestBootstrap(TMP, "real-key-1", ENV);
    writeRestBootstrap(TMP, "real-key-2", {
      styles: {
        "1:1": { key: "cd".repeat(20), name: "Other file", styleType: "FILL", remote: true },
      },
      document: {
        id: "0:1",
        children: [
          {
            id: "180:335", // same node id, different file — must not leak
            type: "INSTANCE",
            transitionNodeID: "99:1",
            transitionDuration: 1,
          },
        ],
      },
    });
    const table = loadTransitionTable(TMP, "real-key-1");
    expect(table.get("180:335")).toEqual({
      transitionNodeID: "10:1098",
      transitionDuration: 300,
      transitionEasing: "EASE_OUT",
    });
    // a file with no bootstrap degrades to an empty table
    expect(loadTransitionTable(TMP, "nope").size).toBe(0);
  });

  it("applyTransitionTable injects missing fields, never overwrites the live node id", () => {
    writeRestBootstrap(TMP, "real-key-1", ENV);
    const table = loadTransitionTable(TMP, "real-key-1");
    const frame: any = {
      id: "180:324",
      document: {
        id: "180:324",
        type: "FRAME",
        children: [
          {
            id: "180:335",
            type: "INSTANCE",
            // the plugin derived the destination live (reactions)
            transitionNodeID: "10:1098",
            children: [{ id: "180:336", type: "RECTANGLE" }],
          },
        ],
      },
    };
    const injected = applyTransitionTable(frame as any, table);
    expect(injected).toBe(1);
    const n = frame.document.children[0];
    expect(n.transitionNodeID).toBe("10:1098"); // live value kept
    expect(n.transitionDuration).toBe(300); // server-side state filled
    expect(n.transitionEasing).toBe("EASE_OUT");
    // idempotent + nodes not in the table untouched
    expect(applyTransitionTable(frame as any, table)).toBe(1);
    expect(frame.document.children[0].children[0]).toEqual({ id: "180:336", type: "RECTANGLE" });
  });

  it("a table entry fills the node id when the plugin could not derive it", () => {
    writeRestBootstrap(TMP, "real-key-1", ENV);
    const table = loadTransitionTable(TMP, "real-key-1");
    const frame: any = {
      id: "180:324",
      document: { id: "180:324", type: "FRAME", children: [{ id: "180:335", type: "INSTANCE" }] },
    };
    applyTransitionTable(frame as any, table);
    expect(frame.document.children[0].transitionNodeID).toBe("10:1098");
    expect(frame.document.children[0].transitionDuration).toBe(300);
  });
});

describe("collectUnresolvedStyles", () => {
  it("merges usedBy across frames, keyed by publish key", () => {
    writeLibraryHarvest(TMP, "lib-a", LIBRARY_STYLES);
    const frameA = consumerFrame();
    const frameB = {
      ...consumerFrame(),
      id: "200:1",
      document: {
        id: "200:1",
        type: "FRAME",
        children: [{ id: "200:2", type: "RECTANGLE", styles: { fill: "500:1" } }],
      },
    };
    const unresolved = collectUnresolvedStyles([frameA, frameB], loadLibraryIndex(TMP));
    expect(unresolved).toEqual([
      {
        key: "0000000000000000000000000000000000000000",
        name: "Not/Harvested",
        usedBy: ["180:307", "200:2"],
      },
    ]);
  });
});
