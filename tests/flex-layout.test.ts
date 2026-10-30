// Round 15 — flexbox translation of Figma auto-layout (get_flex_layout).
import { describe, expect, it } from "vitest";
import { axisSizing, buildFlexLayout, type FlexLayoutFrame } from "../lib/flex-layout.js";

const auto = (over: Record<string, unknown>) => ({
  id: "1:1",
  name: "Card",
  type: "FRAME",
  layoutMode: "VERTICAL",
  itemSpacing: 10,
  paddingTop: 40,
  paddingRight: 40,
  paddingBottom: 40,
  paddingLeft: 40,
  absoluteBoundingBox: { width: 335, height: 316 },
  children: [],
  ...over,
});

const frame = (document: unknown, id = "1:1", name = "Card"): FlexLayoutFrame => ({ id, name, document });

describe("axisSizing (both schema generations)", () => {
  it("prefers modern layoutSizingHorizontal/Vertical", () => {
    expect(axisSizing(auto({ layoutSizingVertical: "HUG" }), "vertical")).toBe("HUG");
    expect(axisSizing(auto({ layoutSizingHorizontal: "FILL" }), "horizontal")).toBe("FILL");
  });

  it("maps legacy primary/counter sizing via layoutMode", () => {
    // VERTICAL layout: primary axis is vertical, counter is horizontal.
    const n = auto({ layoutSizingVertical: undefined, primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "HUG" });
    expect(axisSizing(n, "vertical")).toBe("FIXED");
    expect(axisSizing(n, "horizontal")).toBe("HUG");
    // HORIZONTAL layout swaps them.
    const h = auto({ layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FILL", counterAxisSizingMode: "FIXED" });
    expect(axisSizing(h, "horizontal")).toBe("FILL");
    expect(axisSizing(h, "vertical")).toBe("FIXED");
  });

  it("defaults to FIXED when nothing is set", () => {
    expect(axisSizing(auto({ layoutSizingVertical: undefined }), "vertical")).toBe("FIXED");
  });
});

describe("buildFlexLayout", () => {
  it("emits paste-ready flexbox declarations for an auto-layout container", () => {
    const out = buildFlexLayout([
      frame(auto({ primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER", layoutWrap: "WRAP" })),
    ]);
    expect(out).toContain(`"Card" (1:1) · flex column · 335x316`);
    expect(out).toContain("display: flex; flex-direction: column; gap: 10px; padding: 40px 40px 40px 40px; justify-content: center; align-items: center; flex-wrap: wrap;");
  });

  it("translates each child's sizing: fixed px, hug, fill on main vs cross axis", () => {
    const doc = auto({
      children: [
        { id: "1:2", name: "Fixed Child", type: "FRAME", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", absoluteBoundingBox: { width: 377, height: 900 } },
        { id: "1:3", name: "Hug Child", type: "FRAME", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" },
        { id: "1:4", name: "Fill Main", type: "FRAME", layoutSizingVertical: "FILL", layoutSizingHorizontal: "FIXED", absoluteBoundingBox: { width: 377, height: 900 } },
        { id: "1:5", name: "Fill Cross", type: "FRAME", layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED", absoluteBoundingBox: { width: 100, height: 900 } },
        { id: "1:6", name: "Growing", type: "FRAME", layoutGrow: 2, absoluteBoundingBox: { width: 10, height: 10 } },
        { id: "1:7", name: "score", type: "TEXT", characters: "Score" },
      ],
    });
    const out = buildFlexLayout([frame(doc)]);
    // parent is VERTICAL: vertical = main axis
    expect(out).toContain(`"Fixed Child" (1:2): w:377px · h:900px`);
    expect(out).toContain(`"Hug Child" (1:3): w:fit-content · h:fit-content`);
    expect(out).toContain(`"Fill Main" (1:4): w:377px · h:flex:1`);
    expect(out).toContain(`"Fill Cross" (1:5): w:stretch · h:900px`);
    expect(out).toContain(`"Growing" (1:6): w:10px · h:10px · flex-grow:2`);
    expect(out).not.toContain(`"score"`); // TEXT children are not layout rows
  });

  it("nests auto-layout children as their own blocks", () => {
    const doc = auto({
      children: [
        auto({ id: "1:2", name: "Inner", layoutMode: "HORIZONTAL", itemSpacing: 8, children: [] }),
      ],
    });
    const out = buildFlexLayout([frame(doc)]);
    expect(out).toContain(`"Inner" (1:2) · flex row`);
    expect(out).toContain("flex-direction: row; gap: 8px;");
  });

  it("says so when a frame has no auto-layout (absolute positioning)", () => {
    const out = buildFlexLayout([frame({ id: "1:9", name: "Abs", type: "FRAME", children: [] }, "1:9", "Abs")]);
    expect(out).toContain(`"Abs" (1:9) · no auto-layout (absolutely positioned children)`);
  });

  it("supports legacy sizing fields on auto-layout children (containers)", () => {
    // Legacy primary/counter sizing lives on auto-layout containers; a
    // nested container's own sizing surfaces through its child note in
    // the parent's list. The legacy field maps via the CHILD's own
    // layoutMode (its primary axis), but the CSS phrase maps main/cross
    // via the PARENT's direction — flexbox semantics.
    const rowChild = auto({ id: "1:2", name: "LegacyRow", layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FILL", counterAxisSizingMode: "HUG", children: [] });
    const colChild = auto({ id: "1:3", name: "LegacyCol", layoutMode: "VERTICAL", primaryAxisSizingMode: "FILL", counterAxisSizingMode: "HUG", children: [] });
    const doc = auto({ children: [rowChild, colChild] }); // parent is VERTICAL
    const out = buildFlexLayout([frame(doc)]);
    // parent column → horizontal is the cross axis: FILL → stretch
    expect(out).toContain(`"LegacyRow" (1:2): w:stretch · h:fit-content`);
    // parent column → vertical is the main axis: FILL → flex:1
    expect(out).toContain(`"LegacyCol" (1:3): w:fit-content · h:flex:1`);
  });
});
