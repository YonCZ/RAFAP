# figma-bridge

Local, rate-limit-free design-data pipeline from the Figma desktop app
to AI coding agents.

```
Figma dev plugin (extracts full design trees: fills as hex, per-range
text styles, auto-layout, radii, SVG for vectors …)
   │ push (buttons)  and  pull (agent commands, plugin polls)
   ▼
bridge (express, port 3001)  ──  frames/<id>.json (permanent disk store)
   ▲                                      
agents: HTTP endpoints, disk reads, or optional MCP tools
```

Why not the Figma REST API? It's rate-limited (429s on file-content
endpoints), needs a personal access token, and can't export SVG or
per-range text styles. The plugin runs inside the live document —
strictly more capable, zero rate limits.

- **Push mode**: user selects frames → plugin sends full trees
- **Pull mode**: agent queues a command (`page-index`, `frame {id}`,
  `selection`) → the open plugin executes it and returns fresh data
- Every frame ever received persists to `frames/` — re-readable anytime
- No cloud, no tokens, fully local

## Install

See [docs/human_setup_connection_guide.md](docs/human_setup_connection_guide.md)
— Figma Desktop plugin wizard, one manifest patch, `npm install`.

## Use

See [docs/agent_coding_instructions.md](docs/agent_coding_instructions.md)
— endpoints, the pull-mode command flow, operating rules for agents.

## Repo layout

```
bridge-server.ts   express server (port 3001, BRIDGE_PORT overrides) + MCP
plugin/            dev copy of the Figma plugin (code.ts, ui.html)
docs/              human + agent guides
frames/            received design trees (gitignored)
```

## Development

```bash
npm start          # run the bridge (port 3001)
npm run start:dev  # run a second bridge on port 3002 — never disturbs 3001
npm run check      # typecheck
npm run publish    # sync plugin/ into the live ../Agent Plugin folder + build
```

The live plugin folder (`../Agent Plugin/`, loaded in Figma) is
treated as production: edits happen in `plugin/` and reach it only
via `npm run publish`, followed by reopening the plugin in Figma.

## License

MIT (see LICENSE when published).
