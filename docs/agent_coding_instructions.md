# Agent Instructions: Local Figma Bridge

You are an agent using or developing this bridge. Read the rules first —
other agent sessions may depend on the running infrastructure at any
moment.

## Operating rules (important)

1. **Port 3001 may be in use by another session's bridge.** Never kill
   or restart a process on port 3001 without asking the human first —
   another session may be mid-extraction.
2. **`../Agent Plugin/` is the LIVE plugin folder** — it is loaded in
   the Figma desktop app and other sessions depend on its data flow.
   Never edit files in it directly.
3. All plugin development happens in `plugin/` (the dev copy). Only
   `npm run publish` (human-approved) syncs it to the live folder —
   after which the human must reopen the plugin in Figma.
4. To test server changes without touching the shared port:
   `npm run start:dev` (port 3002). Point a dev-copy plugin's
   `BRIDGE` URL at `http://localhost:3002` if you need an end-to-end
   test.

## Layout

```
Programming/Figma/
├── Agent Plugin/       # LIVE plugin (loaded in Figma) — do not edit
└── figma-bridge/       # this repo
    ├── bridge-server.ts  # express on :3001 (BRIDGE_PORT overrides) + MCP
    ├── frames/           # every frame ever received, one JSON per frame
    ├── plugin/           # dev copy of the plugin (code.ts, ui.html)
    └── docs/
```

Run the bridge: `cd figma-bridge && npm start`.

## How frames arrive

The Figma plugin has two commands (buttons in its UI):

- **Send Selected Frame(s)** — full design trees of everything selected
  (multi-select works). Each node exports: layout skeleton (x/y/size,
  render bounds), auto-layout (mode/spacing/padding/alignment/wrap,
  per-child layoutAlign/layoutGrow), fills and strokes as hex
  (+opacity, gradient stops), corner radius (incl. per-corner +
  smoothing), rotation, dashed + per-side strokes, blend mode,
  clipping, text content + typography (per-range when styles vary
  inside one node), effects (shadows + blurs), and **real SVG markup**
  for vector/icon nodes.
- **Send Page Index** — names, ids and sizes of every top-level frame
  on the current page (cheap map, no trees).

The bridge stores every received frame permanently as
`frames/<id>.json` — nothing is overwritten by later sends of other
frames; re-sending the same frame id refreshes its snapshot.

## Pull mode (agent-initiated)

The plugin polls the bridge for commands every ~1.5s while open. Queue
a command and poll for the answer:

```bash
# 0. Is the plugin open?
curl -s localhost:3001/api/agent/status          # → pluginConnected

# 1. Ask for something:
curl -s -X POST localhost:3001/api/agent/commands -H 'Content-Type: application/json' \
  -d '{"type":"page-index"}'                      # top-level frames of current page
  -d '{"type":"frame","id":"247:448"}'            # full tree of one node id
  -d '{"type":"selection"}'                       # whatever the user has selected
# → {"requestId":"cmd_...","status":"pending"}

# 2. Poll until success/error/timeout (plugin answers within ~2s):
curl -s localhost:3001/api/agent/commands/<requestId>
```

- Results of `frame`/`selection` commands are also persisted to
  `frames/*.json`.
- Commands time out after 20s — usually meaning the plugin is closed.
  Tell the user to open it (Plugins → Development → Agent Plugin).

## Push mode (manual)

Read stored frames directly from `frames/`, or:

- `GET /api/frames` — index of all frames
- `GET /api/frames/<figma-node-id>` — one full tree (ids contain
  colons, e.g. `247:448`)
- `GET /api/page-index` — the last page index
- `GET /api/latest` — most recently stored frame
- `GET /api/health` — status + plugin connection state

Optional MCP tools (stdio, when spawned by an MCP client):
`list_figma_frames`, `get_figma_frame {id}`, `get_latest_figma_frame`,
`request_from_figma {type, id?}`.
