# Agent Instructions: Figma Agent Bridge

You are an agent using or developing this bridge. Read the rules first —
other agent sessions may depend on running infrastructure at any moment.

## Operating rules (critical)

1. **Port 3001 and the `Agent Plugin/` folder are production (legacy).**
   Never kill, restart, or edit them without explicit human permission.
2. All development and testing happens here, on **port 3002** (this repo's
   default) with the **Figma Agent** dev plugin.
3. Plugin source edits happen only in `figma-bridge/plugin/`. They reach
   the dev plugin folder exclusively via `npm run publish` (human-approved),
   after which a human reopens the plugin in Figma.
4. Humans run shared processes. AI sessions ask; they never manage servers.

## Layout

```
Programming/Figma/
├── Agent Plugin/       # LIVE legacy plugin (port 3001 flow) — do not edit
├── Figma Agent/        # DEV plugin (this repo's target) — port 3002
└── figma-bridge/       # this repo
    ├── bridge-server.ts  # express on :3002 + command queue + MCP + /v1 routes
    ├── lib/stitch.ts     # pure envelope stitching (tested)
    ├── plugin/           # canonical plugin source (code.ts, ui.html, lib/)
    ├── store/            # received data, keyed by real Figma file key
    │   └── <fileKey>/    # pages.json · frames/<id>.json · assets/
    ├── tools/            # golden-diff harness (normalize + compare)
    └── docs/
```

Run the bridge: `cd figma-bridge && npm start` (binds 127.0.0.1:3002).
The plugin must be open in Figma (Plugins → Development → Figma Agent).

## REST-parity API (v3 — drop-in for api.figma.com clients)

Point any Figma REST SDK client at `http://127.0.0.1:3002` with a dummy
bearer token and it works unchanged:

- `GET /v1/me`
- `GET /v1/files/:key` — full REST envelope; `?ids=` filters top-level
  frames, `?depth=N` prunes, `?fresh=1` re-pulls everything from the open
  plugin (page-index, then each frame, ≤3 concurrent)
- `GET /v1/files/:key/nodes?ids=1:2,1:3` — each tree nested at
  `nodes[id].document` with its own component/style maps; missing frames
  are pulled live if the plugin is open
- `GET /v1/images/:key?ids=…&format=png|jpg|svg|pdf&scale=N` — plugin
  `exportAsync` behind REST shapes; images served from
  `http://127.0.0.1:3002/assets/…` and cached on disk
- `GET /v1/files/:key/components` · `GET /v1/files/:key/styles`

The file `:key` is the **real Figma file key** (`figma.fileKey`). Data
arrives either via the plugin's push buttons or the pull commands below;
`?fresh=1` is the simplest "just get everything" option.

Deviations from api.figma.com are documented in
[rest-parity-deviations.md](rest-parity-deviations.md) and verified by
`npm run golden-diff` (agent.md §9).

## Pull-mode commands (agent-initiated)

The open plugin long-polls the bridge (~10s holds, near-instant dispatch):

```bash
curl -s localhost:3002/api/agent/status                       # plugin open?
curl -s -X POST localhost:3002/api/agent/commands -H 'Content-Type: application/json' \
  -d '{"type":"page-index"}'                                  # all pages + top-level frames
  -d '{"type":"frame","id":"247:448"}'                         # full REST-shaped tree
  -d '{"type":"selection"}'                                    # current selection
  -d '{"type":"export","ids":["247:448"],"format":"PNG","scale":2}'
# → {"requestId":"cmd_…","status":"pending"}
curl -s localhost:3002/api/agent/commands/<requestId>          # poll to success/error/timeout
```

Results of `frame`/`selection` persist to `store/<fileKey>/frames/`.

## Read endpoints (legacy agent flow, still working)

- `GET /api/frames` — index of all stored frames (all files)
- `GET /api/frames/<node-id>` — one stored REST-shaped payload
- `GET /api/latest` — most recent frame
- `GET /api/page-index` — last stored page structure
- `GET /api/health`, `GET /api/agent/status`

## Security posture

Loopback-only bind (127.0.0.1), Host-header allowlist, CORS restricted to
the Figma plugin iframe (`Origin: null`) + loopback. Bearer tokens are
accepted and ignored (SDK compatibility). Never disable these.

## Testing

- `npm run check` — typecheck (bridge + plugin projects)
- `npm test` — vitest unit tests (mapping rules, text edge cases, stitching)
- `npm run golden-diff` — parity proof against cached/live REST fixtures
  (see agent.md §9 for the rate-limit discipline)
