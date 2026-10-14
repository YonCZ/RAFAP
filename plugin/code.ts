/**
 * Agent Figma Exporter (enhanced) — local design-tree extractor.
 *
 * Two commands (buttons live in ui.html):
 *   · export-selection   → full trees of every selected node (multi-select ok)
 *   · export-page-index → names/ids/sizes of all top-level frames on the page
 *
 * Each node exports the layout skeleton AND the styling the agent needs to
 * reproduce designs faithfully: fills/strokes as hex (+opacity, gradients),
 * text content + typography (per-range when styles vary inside one node),
 * corner radius (incl. per-corner + smoothing), rotation, render bounds,
 * effects (shadows + blurs), auto-layout paddings/spacing/wrap, dashed
 * and per-side strokes, component info — and real SVG markup for
 * vector/icon nodes (via exportAsync).
 */

figma.showUI(__html__, { width: 340, height: 280 });

/**
 * Deep-clone a payload with every symbol (figma.mixed) replaced by the
 * string "MIXED" — postMessage cannot serialize symbols, and any node
 * property that varies across children comes back as one.
 */
function sanitize(value: any): any {
  if (typeof value === "symbol") return "MIXED";
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const k of Object.keys(value)) {
      const v = sanitize(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

function postToUI(msg: any) {
  figma.ui.postMessage(sanitize(msg));
}

figma.ui.onmessage = async (msg: any) => {
  if (msg.type === "export-selection") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("⚠️ Please select a frame first!");
      return;
    }
    const frames: any[] = [];
    for (const node of selection) {
      try {
        frames.push(await extractNode(node));
      } catch (e) {
        figma.notify(`⚠️ ${node.name}: ${(e as Error).message}`);
      }
    }
    if (frames.length) {
      postToUI({ type: "selection-data", payload: frames });
    }
  }

  if (msg.type === "export-page-index") {
    postToUI({ type: "page-index-data", payload: buildPageIndex() });
  }

  // Pull mode: a command the agent queued on the bridge, forwarded by the UI.
  if (msg.type === "agent-command") {
    const { commandId, commandType, params } = msg;
    try {
      let payload: any;
      if (commandType === "page-index") {
        payload = buildPageIndex();
      } else if (commandType === "frame") {
        const node = await figma.getNodeByIdAsync(params.id);
        if (!node) throw new Error(`node ${params.id} not found in this file`);
        payload = await extractNode(node as SceneNode);
      } else if (commandType === "selection") {
        const sel = figma.currentPage.selection;
        if (sel.length === 0) throw new Error("nothing is selected in Figma");
        payload = [];
        for (const node of sel) payload.push(await extractNode(node));
      } else {
        throw new Error(`unknown command type: ${commandType}`);
      }
      postToUI({ type: "command-result", commandId, payload });
    } catch (e) {
      postToUI({ type: "command-result", commandId, error: (e as Error).message });
    }
  }
};

function buildPageIndex() {
  return {
    pageName: figma.currentPage.name,
    frames: figma.currentPage.children.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      width: Math.round(node.width),
      height: Math.round(node.height),
    })),
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function extractNode(node: SceneNode, depth = 0): Promise<any> {
  if (depth > 24) return { id: node.id, name: node.name, type: node.type, note: "max depth reached" };

  const n = node as any;
  const out: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: Math.round(node.x * 10) / 10,
    y: Math.round(node.y * 10) / 10,
    width: Math.round(node.width * 10) / 10,
    height: Math.round(node.height * 10) / 10,
    visible: node.visible !== false,
  };

  if (n.absoluteBoundingBox) {
    const bb = n.absoluteBoundingBox;
    out.absoluteBoundingBox = {
      x: Math.round(bb.x), y: Math.round(bb.y),
      width: Math.round(bb.width), height: Math.round(bb.height),
    };
  }

  if (typeof n.opacity === "number" && n.opacity !== 1) out.opacity = n.opacity;

  // fills / strokes → hex + opacity (gradients keep their stops).
  // NOTE: these can be the figma.mixed SYMBOL (varying across children) —
  // symbols cannot cross postMessage, so they must be filtered out.
  for (const key of ["fills", "strokes"]) {
    const paints = n[key];
    if (paints && paints !== figma.mixed && paints.length) {
      const mapped = paints.filter((p: any) => p.visible !== false).map(paintToJson);
      if (mapped.length) out[key] = mapped;
    }
  }

  if (n.strokeWeight && n.strokeWeight !== figma.mixed) out.strokeWeight = n.strokeWeight;
  // per-side strokes (when the node uses individual stroke weights)
  if (n.individualStrokeWeights && typeof n.individualStrokeWeights === "object") {
    out.individualStrokeWeights = n.individualStrokeWeights;
  }
  // dashed borders
  if (Array.isArray(n.dashPattern) && n.dashPattern.length) {
    out.dashPattern = n.dashPattern;
  }

  if (n.cornerRadius && n.cornerRadius !== figma.mixed && n.cornerRadius !== 0) {
    out.cornerRadius = n.cornerRadius;
  }
  // per-corner radii (rectangles and frames support independent corners)
  if (typeof n.topLeftRadius === "number" &&
      (n.topLeftRadius || n.topRightRadius || n.bottomLeftRadius || n.bottomRightRadius)) {
    out.cornerRadii = {
      topLeft: n.topLeftRadius, topRight: n.topRightRadius,
      bottomLeft: n.bottomLeftRadius, bottomRight: n.bottomRightRadius,
    };
  }
  // smoothness of rounded corners (0 = circle, 0.6 ≈ iOS squircle)
  if (typeof n.cornerSmoothing === "number" && n.cornerSmoothing) {
    out.cornerSmoothing = n.cornerSmoothing;
  }

  // rotation of the node in degrees (non-zero only)
  if (typeof n.rotation === "number" && n.rotation) out.rotation = n.rotation;

  // bounds including strokes/shadows (null when invisible)
  if (n.absoluteRenderBounds) {
    const rb = n.absoluteRenderBounds;
    out.absoluteRenderBounds = {
      x: Math.round(rb.x), y: Math.round(rb.y),
      width: Math.round(rb.width), height: Math.round(rb.height),
    };
  }

  // frame clips its overflow content
  if (n.clipsContent === true) out.clipsContent = true;

  // blend mode (only when it actually changes rendering)
  if (n.blendMode && n.blendMode !== "NORMAL" && n.blendMode !== "PASS_THROUGH") {
    out.blendMode = n.blendMode;
  }

  if (Array.isArray(n.effects) && n.effects.length) {
    out.effects = n.effects
      .filter((e: any) => e.visible !== false)
      .map((e: any) => ({
        type: e.type,
        color: e.color ? rgbaToHex(e.color) : undefined,
        offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
        radius: e.radius,
        spread: e.spread,
      }));
  }

  // auto layout
  if (n.layoutMode && n.layoutMode !== "NONE") {
    out.layout = {
      mode: n.layoutMode,
      itemSpacing: n.itemSpacing === figma.mixed ? "MIXED" : n.itemSpacing,
      paddingTop: n.paddingTop,
      paddingRight: n.paddingRight,
      paddingBottom: n.paddingBottom,
      paddingLeft: n.paddingLeft,
      primaryAxisAlignItems: n.primaryAxisAlignItems,
      counterAxisAlignItems: n.counterAxisAlignItems,
      primaryAxisSizingMode: n.primaryAxisSizingMode,
      counterAxisSizingMode: n.counterAxisSizingMode,
      layoutWrap: n.layoutWrap,
    };
  }

  // how this node sits inside its parent's auto layout (stretch / cross-axis)
  if (n.layoutAlign && n.layoutAlign !== "INHERIT") out.layoutAlign = n.layoutAlign;
  if (n.layoutGrow) out.layoutGrow = n.layoutGrow;

  // text nodes: content + typography. The aggregate fields keep "MIXED"
  // placeholders when ranges differ — `segments` (below) always carries
  // the REAL per-range styles and colors via getStyledTextSegments.
  if (node.type === "TEXT") {
    const t = node as TextNode;
    out.characters = t.characters;
    out.text = {
      fontFamily: t.fontName === figma.mixed ? "MIXED" : t.fontName.family,
      fontStyle: t.fontName === figma.mixed ? "MIXED" : t.fontName.style, // "Regular", "Bold", …
      fontSize: t.fontSize === figma.mixed ? "MIXED" : t.fontSize,
      lineHeight: t.lineHeight === figma.mixed ? "MIXED" : t.lineHeight,
      letterSpacing: t.letterSpacing === figma.mixed ? "MIXED" : t.letterSpacing,
      textAlignHorizontal: t.textAlignHorizontal,
      textAlignVertical: t.textAlignVertical,
      textDecoration: t.textDecoration,
      textCase: t.textCase,
    };
    try {
      const segs = t.getStyledTextSegments([
        "fontName", "fontSize", "fontWeight", "lineHeight",
        "letterSpacing", "fills", "textDecoration", "textCase",
      ]);
      // only attach when the styles actually vary — one segment = the
      // aggregate fields already say everything
      const first = JSON.stringify(segs.length ? [
        segs[0].fontName, segs[0].fontSize, segs[0].fills,
      ] : null);
      const varies = segs.some((s: any) => JSON.stringify([s.fontName, s.fontSize, s.fills]) !== first);
      if (varies) {
        out.text.segments = segs.map((s: any) => ({
          text: s.characters,
          fontFamily: s.fontName?.family,
          fontStyle: s.fontName?.style,
          fontWeight: s.fontWeight,
          fontSize: s.fontSize,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing,
          fills: (s.fills ?? []).filter((f: any) => f.visible !== false).map(paintToJson),
        }));
      }
    } catch {
      /* font not loaded — segments unavailable, aggregate still set */
    }
  }

  // vectors & icons → real SVG markup (better than guessing from outlines)
  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || node.type === "STAR") {
    try {
      const bytes = await node.exportAsync({ format: "SVG" });
      out.svg = bytesToText(bytes);
    } catch {
      /* export not allowed for this node — skip */
    }
  }

  if (node.type === "INSTANCE") {
    try {
      const mc = await (node as InstanceNode).getMainComponentAsync();
      out.mainComponent = mc ? mc.name : undefined;
    } catch {
      /* main component not accessible — skip */
    }
  }

  if ("children" in node) {
    const children: any[] = [];
    for (const child of (node as any).children) {
      children.push(await extractNode(child, depth + 1));
    }
    out.children = children;
  }

  return out;
}

function paintToJson(p: any): any {
  if (p.type === "SOLID") {
    return { type: "SOLID", color: rgbaToHex(p.color), opacity: p.opacity ?? 1 };
  }
  if (typeof p.type === "string" && p.type.startsWith("GRADIENT")) {
    return {
      type: p.type,
      opacity: p.opacity ?? 1,
      stops: (p.gradientStops ?? []).map((s: any) => ({
        position: s.position,
        color: rgbaToHex(s.color),
      })),
    };
  }
  return { type: p.type, visible: true };
}

/** plugin API colors are 0..1 floats → #RRGGBB (alpha appended when < 1) */
function rgbaToHex(c: any): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
  const alpha = c.a ?? 1;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${alpha < 1 ? h(alpha) : ""}`;
}

function bytesToText(bytes: Uint8Array): string {
  let text = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return text;
}
