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
3. **Build.** Mirror the node tree, then style it — adapt to the project's
   stack and conventions.

## The translation is mechanical — do not improvise it

Mirror the tree **1:1**: one element per Figma node, same nesting.
Transparent spacer frames with asymmetric padding are **intentional
structure** — they create the design's spacing rhythm (insets, stagger,
centering). Never flatten them away and never re-derive their effect
from pixel positions.

| Figma (flex digest) | CSS |
| --- | --- |
| `layoutMode: VERTICAL/HORIZONTAL` | `display: flex` + `flex-direction: column/row` |
| sizing `FIXED` | explicit `width`/`height` |
| sizing `HUG` | content sizing (usually: don't set it) |
| `FILL` (child) | `flex-grow: 1` (or `flex: 1`) along the parent's axis |
| `layoutAlign: STRETCH` | `align-items: stretch` / `align-self: stretch` |
| `itemGap` / padding | `gap` / `padding` — copy the values |
| rotation (flex digest `transform: rotate(…)`, outline `rot X`, data `rotation: X`) | copy the digest's line verbatim. **Do not write `rotate(Xdeg)` yourself**: Figma's sign is positive counter-clockwise, CSS's is clockwise — the digest already flips it and pins `transform-origin: top left` (Figma rotates about the top-left corner, CSS defaults to center) |

Build in this order: **structure from the flex digest first, styling
from `get_nodes` second.** Bounding-box pixels are only ever a final
verification pass — never an input.

## Responsive scaling (only when asked)

Do not invent responsive behavior — build the design as drawn. If the
user asks for the build to scale, use the design's own sizing modes,
not invented breakpoints:

1. Give the outer wrapper `container-type: inline-size` (container
   queries). The design's pixel dimensions then translate against the
   **design resolution** — the root frame's width `W` (e.g. 1200).
2. `FIXED` sizes scale rigidly: a `120px` value in a `1200`-wide
   design becomes `calc(100cqw * 120 / 1200)`. Do this for FIXED
   widths, heights, gaps, paddings, radii, font sizes.
3. `FILL` / `HUG` stay ordinary flex CSS (`flex-grow`, content
   sizing) — those are the parts the design itself says should reflow.
4. Everything else (colors, text, effects) is untouched by scaling.

The ratio base is always the design's own resolution — never a
viewport width, never a guessed breakpoint. If the design contains
multiple artboards at different sizes, each artboard scales against
its own `W`.

## Multiple selections / multiple files

When several Figma windows run the plugin at once, `prepare_build` /
`get_selection` may return **labeled options instead of a build kit**
(selections arrived from more than one file). Never pick one yourself:
show the options (frame name + id + fileKey) to the user and ask which
one to build, then re-run `prepare_build` with that frame's
`frameIds` (and `fileKey`). Naming the frame in the request is also
the reliable path in single-window use — `prepare_build
{frameIds: ["76:657"]}` is race-free.

## Hard rules

- **Never derive layout from bounding-box pixels.** Pixel dimensions are
  the path of least resistance — that is exactly why they are wrong: they
  describe the *result*, not the *intent*. Use the flex digest and the
  translation table above; pixels only to verify what you built, never
  to structure it.
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
- Do not invent behavior that is not drawn (animations, states,
  responsive scaling — scaling only when the user asks, via the recipe
  above). If the data leaves a real ambiguity, ask the user — do not
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
