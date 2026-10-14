# Figma Agent

Local, rate-limit-free design-data pipeline from the Figma desktop app to
AI coding agents — with **REST API parity**: point any Figma REST SDK
client at `http://127.0.0.1:3002` with a dummy token and it works
unchanged.

```
Figma desktop app
  └── Figma Agent plugin (extracts REST-shaped design trees:
      fills as {r,g,b} floats, characterStyleOverrides + styleOverrideTable,
      auto-layout, per-corner radii, effects, components — plus SVG markup
      for vectors, which the real API cannot do)
        │  push (buttons) and pull (agent commands, long-polled)
        ▼
      bridge (express, loopback-only)
        │  /v1/files/:key · /v1/files/:key/nodes · /v1/images/:key · /v1/me
        │  agent command queue · optional MCP tools
        ▼
      store/<fileKey>/ — permanent local cache (pages, frames, assets)
```

Why not the Figma REST API? Rate-limited (429s on file-content
endpoints in practice on the free tier), needs a personal access token,
and cannot export SVG or per-range text styles. The plugin runs inside
the live document — strictly more capable, zero rate limits.

- **Push mode**: select frames → plugin sends full trees
- **Pull mode**: agent queues `page-index` / `frame {id}` / `selection` /
  `export {ids}` — the open plugin executes and returns fresh data
  (`?fresh=1` on `/v1/files/:key` pulls the whole document)
- REST parity verified by a **golden diff** against api.figma.com
  responses (normalized deep-compare)
- No cloud, no tokens for our own usage, loopback-only by construction

## Install

See [docs/human_setup_connection_guide.md](docs/human_setup_connection_guide.md)
— Figma Desktop plugin wizard, one manifest patch, `npm install`.

## Use

See [docs/agent_coding_instructions.md](docs/agent_coding_instructions.md)
— routes, the pull-mode command flow, operating rules for agents.

Deviations from api.figma.com are documented and intentional:
[docs/rest-parity-deviations.md](docs/rest-parity-deviations.md).

## Repo layout

```
bridge-server.ts      express (127.0.0.1:3002) + /v1 routes + command queue + MCP
lib/stitch.ts         pure envelope stitching (unit-tested)
plugin/               canonical plugin source (code.ts, ui.html, lib/rest-mapping.ts)
tools/                golden-diff harness (normalize + compare vs REST)
tests/                vitest unit tests (mapping rules, text edge cases, stitching)
store/                received data, keyed by real Figma file key (gitignored)
docs/                 human + agent guides, parity deviations
agent.md              full project context + spec (read this first)
```

## Development

```bash
npm start             # bridge on 127.0.0.1:3002 (dev default)
npm run check         # typecheck both projects (bridge + plugin)
npm test              # vitest unit tests
npm run golden-diff   # parity proof vs api.figma.com fixtures
npm run publish       # sync plugin/ into ../Figma Agent/ + build (human-approved)
```

The live plugin folder (`../Figma Agent/`, loaded in Figma) is treated as
production: edits happen in `plugin/` and reach it only via
`npm run publish`, followed by reopening the plugin in Figma.

## License

MIT (see LICENSE when published).
