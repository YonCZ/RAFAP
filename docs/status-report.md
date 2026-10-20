# RAFAP status report — 2026-10-20

**RAFAP** ("REST-API-Figma-plugin") replaces `GET /v1/files/:key` for local
files: a Figma plugin extracts the open file through the plugin API, and a
local bridge serves it as REST-shaped JSON — no tokens, no upload, no rate
limits, exact live data. Rounds 0–8 are complete; the project is
open-sourced (MIT) and every claim below is verified by a diff harness, not
asserted.

## Architecture

```
Figma (plugin, open file)  ──ws──▶  bridge (localhost)  ──▶  REST /v1/*  +  MCP stdio
                                        │
                                        └── store/  (frames, pages, assets,
                                                     font metrics, library join)
```

- **Plugin** (dev-published, v3.7.0): serializes the current file into REST's
  node shapes (paints, type styles, instance overrides, export settings,
  prototyping transitions…), answers on-demand commands (pull frame, pull
  selection, export PNG/JPG/SVG/PDF, font-metrics probe).
- **Bridge**: an Express server exposing the REST surface (`/v1/files/:key`,
  `/nodes`, `/images`, `/components`, `/styles`, `/me`) plus the same seven
  tools over MCP stdio. Persisted frames make cached reads instant; the
  command queue live-pulls anything not yet stored.
- **Determinism layer**: server-side rewrites the plugin cannot perform —
  font-metric line heights, library style-id joins, prototype transition
  tables — so the served tree matches REST byte-for-byte wherever the data
  is live-derivable at all.

## Verification methodology

A golden-diff harness (`tools/golden-diff.ts`) compares our served trees
against real REST API responses, node by node, at two layers:

- **byte parity** — every leaf value must match at 4-decimal rounding;
- **semantic parity** — a canonicalizing layer first absorbs provably
  equivalent encodings (e.g. which mixed-text range is "base" vs "override",
  `{} ≡ absent`), so it measures document equivalence, not spelling.

Residue is classified by root cause, and **no fix ships without a rule that
fits ≥99% of the measured corpus** — anything below the bar is documented as
a limit instead of guessed at.

## Fidelity

| File | Nodes | Byte parity | Semantic parity |
|---|---|---|---|
| Corpus (product file, Inter) | 2,361 / 32 frames | **98.901%** | **99.234%** |
| Second file (community template, Space Grotesk, remote styles) | 3,593 / 35 frames | **95.4%** | **96.5%** |

Document structure matches exactly in both cases — same ids, same order,
same shapes. The second file (never seen during development) reproduced the
same residue classes and produced **no new systemic class**: the
generalization gate held.

Where the data is live-derivable, parity is *bit-exact*, not approximately
equal: `lineHeightPx` for probe-verified fonts reproduces REST's
`float32(fontSize × float32(m))` arithmetic exactly (150/150 nodes on the
second file's Space Grotesk), and node ids, ordering, component maps and
instance tables carry over unchanged.

## Residue classes (all measured, all documented)

| Class | Paths (2nd file) | Root cause |
|---|---|---|
| G5 instance overrides | 991 | REST stores instance-table records the plugin API does not expose |
| G3 server history | 786 | `layoutVersion` and similar server-side bookkeeping |
| G4 text base-style | 741 / 51 | REST's base-style choice on mixed text is stored edit history — measured 8/9 last-segment, below the 99% bar; the semantic layer absorbs it |
| G2 font metrics | 98 / 80 | `fontPostScriptName` (plugin API exposes none) and unprobed families |
| G1 cross-file library | 13 | library data outside the pulled file |

Details: `docs/rest-parity-deviations.md`.

## Degradation ladder (honest limits, pinned by tests)

- **INTRINSIC line heights** — tier 1: probe-snapped exact rationals
  (bit-exact); tier 2: corpus-fitted multipliers (≤1 ulp); tier 3: unprobed
  families get the plugin's estimate or an honest omission.
  `probe-fonts` promotes a family to tier 1 at runtime.
- **Library style ids** — token-free by default (local aliases); an optional
  one-time cached REST call upgrades them to the real library node ids.
- **Tokens** — none required, none stored, by design.

## MCP surface (Round 8)

The bridge process doubles as an MCP stdio server:

`get_file` · `get_nodes` · `get_images` · `get_metadata` · `get_selection` ·
`search_nodes` · `request_from_figma`

All REST-shaped, all with optional `fileKey` (defaults to the most recently
pulled file). `get_images` exports PNG/JPG/**SVG/PDF** (the real REST API
cannot do SVG); `search_nodes` (name/text/type index over the stored design)
has no REST equivalent at all; `get_selection` returns what is selected in
Figma right now. Verified end-to-end over stdio: 24/24 smoke checks, and a
protocol bug fixed on the way — diagnostics now go to stderr so they can
never corrupt the JSON-RPC channel.

## What changed in the last two rounds

- **Round 7** — runtime font probing with certified exact rationals; the
  degradation ladder; the token stance; second-file acceptance (three real
  defects found and fixed on a never-seen file: stale library index, harness
  phantom diffs, zero-valued image-filter keys; one emission gap closed:
  inherited line-height groups on mixed-size text ranges).
- **Round 8** — the parity-grade MCP surface above.

## Next

Round 9 — DX and open-source hardening: one-command setup, CI running the
golden-diff suite as the regression gate, README for new users, community
listing.
