# Figma plugin

The plugin reader and UI live in this folder. Figma runs `plugin/code.js`, built from `plugin/code.ts`. The panel is `plugin/ui.html`.

## Install

1. Run `npm install` and `npm run build:plugin` in the repo root.
2. In the Figma desktop app, open Plugins, then Development, then Import plugin from manifest.
3. Select `plugin/manifest.json` from this repo.
4. Run the plugin from Plugins, then Development, then Figma Agent.
5. Keep the panel open. It connects to the bridge and handles agent requests.

`manifest.json` already allows `http://localhost:3002`. If you copy the plugin to another folder, keep that network access entry.

## Run

- Start the bridge from the repo root with `npm start`, or run `npx tsx bridge-server.ts`.
- The panel shows the connection state and executes agent requests: page index, a frame by node ID, or the current selection.
- The Send Selected Frame(s) and Send Page Index buttons remain as a fallback.
