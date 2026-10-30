---
name: Figma Build
description: Understand a Figma design completely before building it — use whenever the user asks to implement, code, review, or discuss a design in Figma (e.g. "build this", "code this frame", "I selected the frame in Figma — make it"), via the figma MCP tools
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
4. **See it — `figma.describe_frames`.** The outline gives you the structure;
   this gives you the *visual* understanding: regions and their roles, visual
   hierarchy, what dominates, grouping, spacing — a vision model describing
   the rendered frame in markdown with layer-id references. Call it on the
   frames you are about to build before writing code: it prevents
   plausible-sounding but wrong layout theories (e.g. inventing responsive
   scaling that is not in the design). Numbers alone are not seeing.
5. **Only then, targeted detail** — `figma.get_nodes` with explicit ids (small
   `depth` is fine now, because you already know the structure) for exact
   fills, radii, strokes; `figma.get_metadata` for components and styles;
   `figma.search_nodes` to find nodes by text when hunting something specific.
6. **Build.** Map frames to components/routes using the understanding from
   steps 2–4, not assumptions.

## Hard rules

- **Never conclude a frame is "empty" from a depth-limited pull** — verify
  with `get_outline` first. If `get_nodes depth=3` shows a frame with no
  children, that means nothing about the real design.
- **Understand the whole design before writing any code.** No partial reads,
  no "I'll check the rest later".
- One `get_outline` call beats five depth-limited `get_nodes` calls — both in
  tokens and in correctness.
- **You cannot look at images yourself** — but `figma.describe_frames` can:
  it sends the render to a vision model and returns what the design
  actually looks like, with layer-id references that join the outline.
  Use it before building anything visual. `get_images` itself is still only
  for saving assets, never for "looking".
- Do not invent behavior that is not drawn (responsive scaling, animations,
  states). If the description and outline leave a real ambiguity, ask the
  user — do not guess silently.
- If a frame's purpose is still ambiguous after the outline (no text, generic
  name), ask the user — do not guess silently. If the design is full of lazy
  default names ("Frame 336"), `figma.suggest_frame_names` can fix the naming
  at the source with a vision model (dry-run, then `figma.apply_frame_names`)
  — better names make every later read richer.

## Quick reference

| Need | Tool |
| --- | --- |
| Whole-design understanding | `figma.get_outline` (first, always) |
| What the design visually looks like | `figma.describe_frames` (before building) |
| Pages + top-level frames | `figma.request_from_figma {type:'page-index'}` |
| Exact styling of known ids | `figma.get_nodes {ids, depth}` |
| Components / paint & text styles | `figma.get_metadata` |
| Find nodes by text/name/type | `figma.search_nodes` |
| What the user has selected | `figma.get_selection` |
| Export an asset | `figma.get_images {ids, format, scale}` |
| Rename lazy "Frame 336" names | `figma.suggest_frame_names` → `figma.apply_frame_names` |
