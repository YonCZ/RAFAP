/**
 * Unit tests for the golden-diff normalizer (A6 — characterStyleOverrides
 * re-padding, plus the override-table canonicalization it interacts with).
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, countLeaves, normalize } from "../tools/normalize";

describe("normalize: characterStyleOverrides re-padding", () => {
  it("arrays trimmed differently but semantically equal normalize identically", () => {
    const a = {
      characters: "Hello world",
      characterStyleOverrides: [1],
      styleOverrideTable: { 1: { fontFamily: "Inter", fontWeight: 600 } },
    };
    const b = {
      characters: "Hello world",
      characterStyleOverrides: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      styleOverrideTable: { 1: { fontFamily: "Inter", fontWeight: 600 } },
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("does not touch arrays that are already full-length", () => {
    const a = {
      characters: "Hi",
      characterStyleOverrides: [1, 1],
      styleOverrideTable: { 1: { fontFamily: "Inter" } },
    };
    expect((normalize(a) as any).characterStyleOverrides).toEqual([1, 1]);
  });

  it("padding is semantics-preserving (trailing chars use the default style)", () => {
    // REST: shorter array — "chars beyond the array's length use the default style"
    const rest = {
      characters: "Abc",
      characterStyleOverrides: [1],
      styleOverrideTable: { 1: { fontStyle: "Semi Bold" } },
    };
    const ours = {
      characters: "Abc",
      characterStyleOverrides: [1, 0, 0],
      styleOverrideTable: { 1: { fontStyle: "Semi Bold" } },
    };
    expect(canonicalJson(rest)).toBe(canonicalJson(ours));
  });
});

describe("countLeaves", () => {
  it("counts scalar leaves in nested structures", () => {
    expect(countLeaves({ a: 1, b: [1, 2], c: { d: "x" } })).toBe(4);
    expect(countLeaves("s")).toBe(1);
    expect(countLeaves([[], [null]])).toBe(1); // [] has no leaves; null is one
  });
});
