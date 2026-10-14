# Human Guide: The Figma ↔ Agent Bridge

## What lives where

```
Programming/Figma/
├── Agent Plugin/       ← the LIVE plugin loaded in Figma (created via
│                         Figma's wizard; the repo syncs into it)
└── figma-bridge/       ← the tool repo (this project)
```

- **`Agent Plugin/` is production.** Other agent sessions read their
  design data through it. Files in it are only ever updated by
  `npm run publish` from the repo.
- **`figma-bridge/plugin/` is development.** All plugin edits happen
  here; they reach the live folder only when you say so.

## One-time setup (already done on this machine)

1. Figma Desktop → Plugins → Development → New Plugin… → saved as
   `Agent Plugin/` in this folder.
2. The plugin files were replaced by the repo's (`npm run publish`)
   and `manifest.json` was patched with:
   `"networkAccess": { "allowedDomains": ["http://localhost:3001"],
   "reasoning": "…" }`.
3. `cd figma-bridge && npm install`.

## Daily workflow

1. Run the bridge and keep the terminal open:
   ```bash
   cd Programming/Figma/figma-bridge
   npm start        # → "Figma Bridge active on port 3001"
   ```
2. In Figma, open the plugin (**Plugins → Development → Agent Plugin**)
   and leave it open — it shows `🟢 connected — listening for agent`
   and executes agent requests automatically.
3. Just tell your agent what you want, e.g. *"Build the page whose
   mockup is named 'Storage Page'"* — no clicking needed. The manual
   buttons in the plugin still work as a fallback.

Every frame ever sent or fetched stays stored in `figma-bridge/frames/`,
so old designs can be re-read anytime without re-sending.

## When the plugin code changes

1. The change is made in `figma-bridge/plugin/` (dev copy) and
   type-checked (`npm run check`).
2. When you approve it: `npm run publish` — copies `code.ts` +
   `ui.html` into `../Agent Plugin/` and compiles there.
3. **Reopen the plugin in Figma** (close the window, re-run it) to
   load the new build. Brief moment of downtime for other sessions —
   do it between their extractions.

## Dev testing without disturbing anyone

`npm run start:dev` runs a second bridge on **port 3002**. Point a
dev copy of the plugin at it by changing the `BRIDGE` constant in its
`ui.html`. Port 3001 stays untouched.

## Optional: MCP registration

Not required — agents read frames from disk or via curl. If you want
formal MCP tools, add to the OpenCode config:

```json
{
  "mcp": {
    "figma-local-bridge": {
      "type": "local",
      "command": ["npx", "tsx", "/absolute/path/to/Programming/Figma/figma-bridge/bridge-server.ts"]
    }
  }
}
```
