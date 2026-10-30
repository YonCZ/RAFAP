---
name: Figma Build
description: Understand a Figma design completely before building it — use whenever implementing, reviewing, or answering questions about a design in Figma via the figma MCP tools
---

# Figma Build — read the whole design first

The figma MCP serves the design tree. Its REST-shaped payloads are huge, so
there is a right and a wrong way to read them. The failure this skill prevents:
pulling a subtree with a depth limit, seeing no children, and concluding the
frame is empty — depth-pruned children look exactly like emptiness.

## Workflow (in order, do not skip steps)

1. **Frame inventory** — if you don't know the file/frames yet:
   `figma.request_from_figma {type:'page-index'}` (needs the plugin open in
   Figma), or `figma.list_figma_frames` for what is already stored.
2. **Understand — `figma.get_outline`** — this is the mandatory first read of
   any design you are about to build or review. One indented line per node:
   id, name, type, size, child count, auto-layout, and **all text content**.
   No depth pruning, none of the paint JSON. One call per file, cheap.
3. **Extract intent from the text nodes.** Button labels, headings, placeholder
   copy — they tell you what each region is *for*. Frame names + text content
   are the design's documentation.
4. **Only then, targeted detail** — `figma.get_nodes` with explicit ids (small
   `depth` is fine now, because you already know the structure) for exact
   fills, radii, strokes; `figma.get_metadata` for components and styles;
   `figma.search_nodes` to find nodes by text when hunting something specific.
5. **Build.** Map frames to components/routes using the understanding from
   step 2–3, not assumptions.

## Hard rules

- **Never conclude a frame is "empty" from a depth-limited pull** — verify
  with `get_outline` first. If `get_nodes depth=3` shows a frame with no
  children, that means nothing about the real design.
- **Understand the whole design before writing any code.** No partial reads,
  no "I'll check the rest later".
- One `get_outline` call beats five depth-limited `get_nodes` calls — both in
  tokens and in correctness.
- You are not multimodal: rendering images (`get_images`) is for saving
  assets or giving them to the user, never for "looking" at the design. The
  outline IS your eyes.
- If a frame's purpose is still ambiguous after the outline (no text, generic
  name), ask the user — do not guess silently.

## Quick reference

| Need | Tool |
| --- | --- |
| Whole-design understanding | `figma.get_outline` (first, always) |
| Pages + top-level frames | `figma.request_from_figma {type:'page-index'}` |
| Exact styling of known ids | `figma.get_nodes {ids, depth}` |
| Components / paint & text styles | `figma.get_metadata` |
| Find nodes by text/name/type | `figma.search_nodes` |
| What the user has selected | `figma.get_selection` |
| Export an asset | `figma.get_images {ids, format, scale}` |
