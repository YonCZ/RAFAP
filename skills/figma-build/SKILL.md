---
name: Figma Build
description: Understand a Figma design completely before building it — use whenever the user asks to implement, code, review, or discuss a design in Figma (e.g. "build this", "code this frame", "I selected the frame in Figma — make it"), via the figma MCP tools
---

# Figma Build — build from the design's intent

The user designs in Figma with auto-layout, selects frames, and asks you to
build them into the project. The bridge serves exactly the data needed for
that: structure, layout intent, text, and styling. Your job is to reproduce
the design faithfully in whatever stack the project uses.

## Workflow (in order, do not skip steps)

1. **Get the build kit — `figma.prepare_build`.** One call, defaults to what
   the user selected in Figma. Returns per frame: the **outline** (whole
   tree — id, name, type, size, auto-layout, and ALL text content, no depth
   pruning) and the **flexbox translation** of the auto-layout (the layout
   intent: fixed → px, hug → fit-content, fill → flex-grow /
   align-self:stretch, gaps, padding, alignment). This is everything you
   need to start building.
2. **Targeted detail while styling** — `figma.get_nodes` with explicit ids
   for exact fills, strokes, radii, effects, fonts; `figma.get_images` for
   assets (icons, images, anything you will not hand-rebuild);
   `figma.get_metadata` for components and paint/text styles;
   `figma.search_nodes` to find nodes by text when hunting something.
3. **Build.** Reproduce the structure from the flex intent, fill in the
   styling from get_nodes, adapt to the project's stack and conventions.

## Hard rules

- **Never derive layout from bounding-box pixels.** Pixel dimensions are
  the path of least resistance — that is exactly why they are wrong: they
  describe the *result*, not the *intent*. The design's auto-layout
  (hug/fill/fixed, gap, padding, alignment) maps 1:1 to flexbox;
  `prepare_build` / `figma.get_flex_layout` return that translation. Build
  layout from it; use pixels only to verify what you built, never to
  structure it.
- **Never conclude a frame is "empty" from a depth-limited pull** — the
  outline from `prepare_build` shows the whole tree. If you use
  `get_nodes` with a `depth`, children below it are pruned and look
  exactly like emptiness.
- **Understand the whole design before writing any code.** One
  `prepare_build` call beats five depth-limited `get_nodes` calls — in
  tokens and in correctness.
- **You cannot look at images yourself.** `figma.get_images` is for saving
  assets into the project, never for "looking" at the design — read the
  outline and text content instead.
- Do not invent behavior that is not drawn (responsive scaling, animations,
  states). If the data leaves a real ambiguity, ask the user — do not
  guess silently.
- Extract intent from text nodes: button labels, headings, placeholder
  copy tell you what each region is *for*. Frame names + text content are
  the design's documentation.

## Quick reference

| Need | Tool |
| --- | --- |
| Build kit for the selection (structure + text + flex intent) | `figma.prepare_build` (first, always) |
| Layout intent as flexbox (re-query) | `figma.get_flex_layout` |
| Whole-tree structure + text (re-query) | `figma.get_outline` |
| Exact styling of known ids | `figma.get_nodes {ids, depth}` |
| Export an asset | `figma.get_images {ids, format, scale}` |
| Components / paint & text styles | `figma.get_metadata` |
| Find nodes by text/name/type | `figma.search_nodes` |
| What the user has selected / what is stored | `figma.get_selection` / `figma.list_figma_frames` |
