# Human Guide: Figma Agent Bridge

## What lives where

```
Programming/Figma/
├── Agent Plugin/       ← LEGACY production plugin (port 3001 flow) — frozen
├── Figma Agent/        ← DEV plugin (loaded in Figma; wired to port 3002)
└── figma-bridge/       ← the tool repo (this project)
```

- **`Agent Plugin/` is frozen production.** Another agent session reads
  design data through it. Never edit it; never stop port 3001 without
  checking that session is idle.
- **`Figma Agent/` is the dev plugin.** This is the playground for v3
  development. Breaking it is fine — that's what it's for.
- **`figma-bridge/plugin/` is the canonical source.** All plugin edits
  happen there; they reach `Figma Agent/` only via `npm run publish`,
  followed by you reopening the plugin in Figma.

## Daily workflow

1. Run the bridge and keep the terminal open:
   ```bash
   cd Programming/Figma/figma-bridge
   npm start        # → "listening on http://127.0.0.1:3002"
   ```
2. In Figma, open **Plugins → Development → Figma Agent** and leave it
   open — it shows `🟢 connected — listening for agent` and executes agent
   requests automatically (long-polled, near-instant).
3. Agents read data via REST-parity routes (`/v1/...`), the pull commands,
   or the push buttons in the plugin UI (manual fallback).

Everything ever received persists to `store/<fileKey>/` — pages, frames,
exported images — so old designs can be re-read anytime without re-sending.

## When the plugin code changes

1. The change is made in `figma-bridge/plugin/` and verified with
   `npm run check` + `npm test`.
2. When you approve it: `npm run publish` — copies the source into
   `Figma Agent/` and builds there (typecheck + esbuild bundle).
3. **Reopen the plugin in Figma** (close the window, re-run it) to load
   the new build.

## Two instances, two ports

| Instance | Port | Plugin folder | Status |
|---|---|---|---|
| Production (legacy webapp session) | 3001 | `Agent Plugin/` | frozen — ask before touching |
| Development (this repo) | 3002 | `Figma Agent/` | the playground |

This repo's `npm start` defaults to **3002** and binds `127.0.0.1` only,
so it can never collide with production by accident.

## Verifying REST parity (golden diff)

When you want proof that our output matches api.figma.com:

```bash
# once per frame — caches the REST response in golden/ and diffs against us
npx tsx tools/golden-diff.ts "247:448" --file-key <your-file-key>
```

Token: put your Figma personal access token in `~/.figma-token` or set
`$FIGMA_TOKEN`. The tool makes **at most one** REST call per run and stops
on 429 (never loops). Results land in `docs/golden-diff-report.md`.

## Optional: MCP registration

Not required — agents use HTTP or disk. If you want formal MCP tools:

```json
{
  "mcp": {
    "figma-agent-bridge": {
      "type": "local",
      "command": ["npx", "tsx", "/absolute/path/to/Programming/Figma/figma-bridge/bridge-server.ts"]
    }
  }
}
```
