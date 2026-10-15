# RAFAP — Rest API Figma Agent Plugin

A local **drop-in replacement for the Figma REST API** (`GET /v1/files/:key`,
`GET /v1/files/:key/nodes`): a Figma plugin + loopback bridge server that
serves your open Figma file through an API-shaped surface with **no rate
limits, no tokens, and no cloud round-trips**. Point any Figma REST client at
`http://127.0.0.1:3001/v1` and it just works.

Built for AI agents and local tooling that keep hitting Figma's API rate
limits while iterating on design data.

## How it works

```
Figma desktop app ── plugin (long-poll) ──> bridge server (127.0.0.1:3001)
                                                │
REST clients / agents ── GET /v1/files/... ──────┘
```

1. The **plugin** (`plugin/`) walks the live document and serializes it into
   REST-shaped JSON, applying ~40 emission rules measured against real
   `api.figma.com` payloads (see `docs/rest-parity-deviations.md`).
2. The **bridge** (`bridge-server.ts`) exposes the `/v1` surface, caches
   extractions in a content-addressed store (`store/`), and forwards agent
   commands to the plugin.
3. `GET /v1/files/:key/nodes?ids=248:563` auto-pulls the frame live if the
   plugin is connected; otherwise the cached copy is served.

## Quick start

```bash
npm install
npm run check          # typecheck bridge + plugin
npm run build:plugin   # bundle the plugin to dist/plugin/
npm start              # bridge on 127.0.0.1:3001
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and
select `dist/plugin/manifest.json`. Open the plugin, and:

```bash
curl http://127.0.0.1:3001/v1/files/local-<key>
```

Find your file's local key via `curl http://127.0.0.1:3001/api/page-index`.

## API surface

| Endpoint | Parity |
|---|---|
| `GET /v1/files/:key` | Full document tree, `components`, `componentSets`, `styles` |
| `GET /v1/files/:key/nodes?ids=a,b` | Per-node subtrees, live auto-pull |
| `GET /v1/files/:key/components`, `/styles` | Best-effort from stored frames |
| `GET /v1/files/:key/images/:ref` | Image bytes by ref |
| `GET /v1/me` | Local identity stub |

Also: `?fresh=1` to force re-extraction (extension), and `_figmaAgent.svgBase64`
on shape nodes — inline SVG exports, which the real REST API cannot do at all.

## Fidelity

Verified against a real 2,361-node / 32-frame file via a golden-diff harness
(`tools/golden-diff.ts`): document tree structure matches **exactly** (same
ids, same order, same shapes). Remaining differences are documented plugin-API
limits — see `report.md` and `docs/rest-parity-deviations.md`.

## Security

- Bridge binds **loopback only** (`127.0.0.1`); no external interface.
- `networkAccess.allowedDomains` pins the plugin to the bridge origin.
- No secrets in the repo; the Figma REST token (if you use one for golden
  tests) lives in `~/.figma-token`, never committed.

## Development

```bash
npm run check    # tsc for bridge + plugin
npm test         # vitest unit tests (mapping rules)
npm run publish  # sync build to a dev plugin folder
```

`agent.md` is the spec of record. MIT licensed — see `LICENSE`.
