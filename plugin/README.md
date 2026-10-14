# Agent Plugin (Figma dev plugin)

Two files that make up the enhanced Figma plugin: `code.ts` + `ui.html`.

## Install (one-time, per machine)

1. In the **Figma Desktop App**: Plugins → Development → **New Plugin…** →
   Manifest + UI → name it `Agent Figma Exporter` → save it into a folder
   of your choice (e.g. `Programming/Figma/Agent_Plugin` — it does NOT
   need to live in the webapp repo).
2. Copy `code.ts` and `ui.html` from this folder **over the generated
   ones** in that folder (Figma compiles `code.ts` automatically).
3. **Required**: edit the generated `manifest.json` in that folder and
   add network access for the bridge — without this Figma blocks the
   plugin's fetch to localhost:

   ```json
   "networkAccess": {
     "allowedDomains": ["http://localhost:3001"],
     "reasoning": "Sends selected design trees to the local agent bridge during development."
   }
   ```

   (Keep the `"id"` Figma generated; add `"networkAccess"` next to it.
   Note: the field is called `reasoning` — Figma's schema rejects
   `allowedDomainsReasoning`, and localhost requires the `reasoning`
   field to be present.)
4. Make sure `manifest.json` still has `"main": "code.js"` and
   `"ui": "ui.html"` (the default).

## Run

- The bridge server must be running: `cd webapp/figma-bridge && npm start`
  (or `npx tsx bridge-server.ts`).
- In Figma: open the plugin and **leave it open** — it connects to the
  bridge (`🟢 connected`) and automatically executes the agent's
  on-demand requests: page index, any frame by node id, or the current
  selection. No clicking required.
- The manual buttons (**Send Selected Frame(s)** / **Send Page Index**)
  remain as a fallback.
