// Round 16.3 — plugin-window identity with memory (lib/window-registry.ts).
import { describe, expect, it } from "vitest";
import { ANONYMOUS_WINDOW, WINDOW_MEMORY_MS, WindowRegistry } from "../lib/window-registry.js";

describe("WindowRegistry", () => {
  it("counts distinct windows seen within the memory window", () => {
    const r = new WindowRegistry();
    expect(r.activeCount()).toBe(0);
    r.touch("aaa", 1000);
    r.touch("bbb", 1000);
    expect(r.activeCount(1000)).toBe(2);
  });

  it("forgets windows silent past the memory window", () => {
    const r = new WindowRegistry();
    r.touch("aaa", 1000);
    r.touch("bbb", 1000 + WINDOW_MEMORY_MS - 1);
    expect(r.activeCount(1000 + WINDOW_MEMORY_MS)).toBe(2); // boundary is inclusive
    expect(r.activeCount(1000 + WINDOW_MEMORY_MS + 1)).toBe(1); // only bbb
    expect(r.activeCount(1000 + 2 * WINDOW_MEMORY_MS)).toBe(0);
  });

  it("collapses missing wids into one anonymous window (pre-16.3 plugins)", () => {
    const r = new WindowRegistry();
    r.touch("");
    r.touch(undefined as unknown as string);
    r.touch("");
    expect(r.activeCount()).toBe(1);
  });

  it("tracks which window answered a command — errors count as heard", () => {
    const r = new WindowRegistry();
    r.touch("aaa");
    r.touch("bbb");
    r.deliveredTo("cmd_1", "aaa");
    r.heardResult("cmd_1"); // success
    r.deliveredTo("cmd_2", "bbb");
    r.heardResult("cmd_2"); // error result — still heard
    expect(r.unheard()).toEqual([]);
  });

  it("lists only active windows without a delivered result", () => {
    const r = new WindowRegistry();
    const t0 = 1000;
    r.touch("aaa", t0);
    r.touch("bbb", t0);
    r.deliveredTo("cmd_1", "aaa");
    r.heardResult("cmd_1");
    expect(r.unheard(t0)).toEqual(["bbb"]);
    // past the memory window, even unheard windows are forgotten
    expect(r.unheard(t0 + WINDOW_MEMORY_MS + 1)).toEqual([]);
  });

  it("prune drops stale windows and their heard marks", () => {
    const r = new WindowRegistry();
    r.touch("aaa", 1000);
    r.touch("bbb", 1000);
    r.deliveredTo("cmd_1", "bbb");
    r.heardResult("cmd_1");
    r.prune(1000 + WINDOW_MEMORY_MS + 1);
    expect(r.activeCount(1000 + WINDOW_MEMORY_MS + 1)).toBe(0);
    expect(r.unheard(1000 + WINDOW_MEMORY_MS + 1)).toEqual([]);
  });

  it("anonymous deliveries map to the anonymous window", () => {
    const r = new WindowRegistry();
    r.touch("");
    r.deliveredTo("cmd_1", "");
    r.heardResult("cmd_1");
    expect(r.unheard()).toEqual([]);
    expect(r.activeCount()).toBe(1);
    expect(ANONYMOUS_WINDOW).toBe("(anonymous)");
  });

  it("keeps working across many commands (bounded takenBy map)", () => {
    const r = new WindowRegistry();
    r.touch("aaa");
    for (let i = 0; i < 500; i++) {
      r.deliveredTo(`cmd_${i}`, "aaa");
      r.heardResult(`cmd_${i}`);
    }
    expect(r.unheard()).toEqual([]);
  });
});
