# Figma Community listing — draft copy

For publishing RAFAP ("Figma Agent") to the Figma Community. The listing
plugin ships `dist/plugin/` — no bridge code, no tokens, network access
restricted to `http://localhost:3002` (see `plugin/manifest.json`).

## Tagline

Your open file as a local REST API — for your own AI tools.

## Description

**Figma Agent** turns the file you have open into a REST-shaped JSON API
served from *your own machine* — point a tool at
`http://127.0.0.1:3002/v1/files/...` and it just works. No tokens, no
upload, no rate limits, always exactly in sync with what's on your canvas.

It exists because the official REST API can't see drafts: un-published
files (the ones you're actually working on) are invisible to it. This
plugin closes that gap — for local AI agents, scripts, exporters, and
anything else that wants design data as data.

**What you get**

- `GET /v1/files/:key` — the whole document tree, component maps, styles
- `GET /v1/files/:key/nodes?ids=…` — any subtree by id, live
- `GET /v1/images/:key` — PNG/JPG/**SVG/PDF** renders (SVG beats the REST
  API, which can't do it at all)
- MCP server — the same data as tools for AI agents (works with OpenCode
  out of the box), plus extras REST doesn't have: search the design by
  name/text/type, and grab the current selection

**Verified parity.** The JSON matches the official REST API's shapes and —
wherever the data is derivable at all — its exact values, measured against
real REST responses with a diff harness (≈99% semantic parity; every
remaining difference is a documented plugin-API limit, listed in the
README).

**Privacy.** Nothing leaves your machine. The plugin's only network access
is to a bridge process on your own localhost. There is no account, no
token, no telemetry.

## How it works (support-page copy)

1. Run the bridge: `npm start` (from the GitHub repo)
2. Open this plugin in your file — keep its panel open
3. `curl http://127.0.0.1:3002/api/page-index` to find your file's key
4. `curl "http://127.0.0.1:3002/v1/files/<key>?fresh=1"`

AI users: the repo's `scripts/setup.sh` sets everything up and registers
the MCP server with OpenCode in one go.

## Notes for the reviewer

- The plugin runs entirely client-side; its `networkAccess` is scoped to
  `http://localhost:3002` (the bridge must run separately from the GitHub
  repo — this listing is the plugin half of a two-part open-source tool).
- No remote fetches, no storage, no keys. The bridge it talks to is MIT-
  licensed at github.com/YonCZ/RAFAP.
