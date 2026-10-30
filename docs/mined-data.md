# What RAFAP mines — and why

Written in Round 16 after the launchpad conversation. The contract, in the
user's own words: *"I tell the agent: let's build the next step in our
webapp, I made this frame, I selected it in Figma. I expect them to build
the same structure from the fill/hug/fixed auto-layouts, then fill it with
same color, same text, same effects."* Everything below is judged against
that contract.

## Core — the contract needs it (mined and served)

| Category | Fields | Served by |
| --- | --- | --- |
| Structure | id, name, type, visible, absoluteBoundingBox, tree | `prepare_build`, `get_outline` |
| Layout intent | layoutMode, itemSpacing, paddings, primary/counterAxisAlignItems, sizing (both schema generations), layoutWrap, counterAxisSpacing, layoutAlign, layoutGrow | `prepare_build`, `get_flex_layout` |
| Positioning behavior | constraints (kept by user decision — how absolutely-positioned children behave) | `get_nodes` |
| Text | characters, style (font family/size/weight, lineHeight, letterSpacing, alignment, textCase, textDecoration, fills), styleOverrideTable for mixed-rich text | `get_nodes` |
| Styling | fills, strokes, strokeWeight, strokeAlign, cornerRadius / rectangleCornerRadii, effects, opacity, clipsContent (overflow) | `get_nodes` |
| Components | componentId, componentProperties, component/componentSets/styles maps | `get_metadata` |
| Assets | PNG/JPG/SVG/PDF renders via plugin `exportAsync`, cached under `store/` | `get_images` |

## Thrown away in Round 16 (option A — speed over parity)

The founding mission was byte-parity with `GET /v1/files/:key`. Round 16
retired it: the plugin now extracts **only the contract** above, which makes
pulls faster and payloads much smaller. Removed from extraction:

- `svgBase64` — SVG markup baked into every vector node; nothing ever
  consumed it (pure payload bloat)
- vector geometry paths (per-node vector networks, fill/stroke geometry)
- prototyping: interactions/reactions, transitions, destinations
- per-side stroke weights, dash patterns, caps/joins, corner smoothing
- blend modes, locked, scrollBehavior, layoutGrids, export settings
- absoluteRenderBounds, transforms (matrices), aspect-ratio lock
- isMask/maskType, booleanOperation, arcData, boundVariables
- frame `background`/`backgroundColor` (redundant with `fills`)
- per-range bound style ids in rich text (inheritFillStyleId/…)
- the `_figmaAgent` timings block and the parity `probe` command

The HTTP REST endpoints (`/v1/files/:key`, …) still serve the store — now
with contract-shaped payloads instead of parity-shaped ones.

## MCP surface — 9 tools

`prepare_build`, `get_outline`, `get_flex_layout`, `get_nodes`, `get_images`,
`get_metadata`, `search_nodes`, `get_selection`, `list_figma_frames`.

Removed in Round 16: `describe_frames` (vision — solved a problem that was
really method laziness, not blindness), `get_file` / `get_figma_frame` /
`get_latest_figma_frame` / `request_from_figma` (context burners and
duplicates of the digest path), `suggest_frame_names` /
`apply_frame_names` (renaming is the panel button, not an agent tool).

Vision remains server-side in exactly one place: the **Rename Selected**
button in the plugin panel (`POST /api/rename/selected`).
