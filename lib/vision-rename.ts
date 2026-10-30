// Round 11 — vision-driven frame renaming.
//
// Frame names are the cheapest, highest-signal context a non-multimodal
// agent gets from a design ("Frame 336" carries no intent; "Top Nav" is a
// component contract). This module renames lazy default names using a
// vision LLM: render the selected frame, send the PNG plus the layer
// facts the store already knows (type, size, text content inside), get
// descriptive names back.
//
// Security: the API key is resolved from env vars or the user's OpenCode
// config and NEVER logged, returned, or committed. It stays server-side
// in the bridge process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Where the config came from — safe to log (no secrets). */
  source: string;
}

/**
 * Resolve the vision LLM endpoint. Priority:
 *  1. env: VISION_BASE_URL + VISION_MODEL + VISION_API_KEY (any
 *     OpenAI-compatible endpoint)
 *  2. the user's OpenCode provider config (~/.config/opencode/opencode.json):
 *     first provider with a baseURL+apiKey, preferring a Gemma-family model
 *     (empirically the most JSON-compliant and accurate at naming — see
 *     Round 11 comparison), then Qwen, then any vision-likely family
 *     (vl/vision/glm), then the first model.
 * Returns null when nothing usable is configured.
 */
export function resolveVisionConfig(
  env: Record<string, string | undefined> = process.env,
  readConfigFile: (p: string) => string | null = defaultReadConfigFile,
): VisionConfig | null {
  if (env.VISION_BASE_URL && env.VISION_MODEL && env.VISION_API_KEY) {
    return { baseUrl: env.VISION_BASE_URL, model: env.VISION_MODEL, apiKey: env.VISION_API_KEY, source: "env VISION_*" };
  }
  const raw = readConfigFile(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  if (!raw) return null;
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  const providers = cfg?.provider ?? {};
  for (const [provId, prov] of Object.entries<any>(providers)) {
    const baseUrl: string | undefined = prov?.options?.baseURL;
    const apiKey: string | undefined = prov?.options?.apiKey;
    const models: string[] = Object.keys(prov?.models ?? {});
    if (!baseUrl || !apiKey || !models.length) continue;
    const pick =
      models.find((m) => /gemma/i.test(m)) ??
      models.find((m) => /qwen/i.test(m)) ??
      models.find((m) => /(vl|vision|glm)/i.test(m)) ??
      models[0];
    return { baseUrl, model: pick, apiKey, source: `opencode provider ${provId}` };
  }
  return null;
}

function defaultReadConfigFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Figma's lazy default names: "Frame 336", "Group 5", "Component 1"… */
export function isLazyName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    /^(frame|group|component|instance|section|rectangle|ellipse|vector|line|polygon|star)\s*\d+$/i.test(name.trim())
  );
}

/** Node types worth renaming — structural containers an agent reasons about. */
const RENAMEABLE_TYPES = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
]);

export interface RenameTarget {
  id: string;
  currentName: string;
  type: string;
  width: number;
  height: number;
  /** Up to 6 text snippets inside the subtree (the intent signal). */
  textInside: string[];
}

interface WalkNode {
  id?: string;
  name?: string;
  type?: string;
  children?: unknown;
  characters?: string;
  absoluteBoundingBox?: { width: number; height: number };
}

function collectText(node: WalkNode, out: string[], budget: number): void {
  if (out.length >= budget) return;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (out.length >= budget) return;
      if (c && typeof c === "object") {
        const cn = c as WalkNode;
        if (cn.type === "TEXT" && typeof cn.characters === "string" && cn.characters.trim()) {
          const t = cn.characters.replace(/\s+/g, " ").trim().slice(0, 60);
          if (t) out.push(t);
        } else {
          collectText(cn, out, budget);
        }
      }
    }
  }
}

/**
 * Collect rename candidates from a design subtree (the selection): every
 * node with a lazy default name and a structural type — the root itself
 * included only if its own name is lazy. Deliberately-named nodes are
 * never touched.
 */
export function collectRenameTargets(document: unknown): RenameTarget[] {
  const targets: RenameTarget[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as WalkNode;
    if (typeof n.id === "string" && RENAMEABLE_TYPES.has(String(n.type)) && isLazyName(n.name)) {
      const textInside: string[] = [];
      collectText(n, textInside, 6);
      targets.push({
        id: n.id,
        currentName: typeof n.name === "string" ? n.name : "",
        type: String(n.type ?? "NODE"),
        width: Math.round(n.absoluteBoundingBox?.width ?? 0),
        height: Math.round(n.absoluteBoundingBox?.height ?? 0),
        textInside,
      });
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) visit(c);
    }
  };
  visit(document);
  return targets;
}

/**
 * Smart render scale for vision endpoints: they reject images below
 * ~512px, so small frames are upscaled (max 4×). Large frames are fine
 * at 1×. Shared by the renamer and the describe tool (Round 14).
 */
export function computeRenderScale(width: number, height: number): number {
  const minDim = Math.min(Number(width) || 0, Number(height) || 0) || 512;
  return Math.max(1, Math.min(4, Math.ceil(512 / minDim)));
}

/** Clean a model-suggested name; empty result means "reject". */
export function sanitizeName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim().replace(/^["'\u201c]+|["'\u201d]+$/g, "").slice(0, 48).trim();
}

/**
 * Round 13 — turn dry-run suggestions into an apply-ready rename list:
 * keep only entries with a usable suggested name. Shared by the
 * apply_frame_names MCP tool and the one-click panel button
 * (POST /api/rename/selected) so both paths filter identically.
 */
export function suggestionsToRenames(
  suggestions: Array<{ id: unknown; suggestedName: unknown }>,
): Array<{ id: string; name: string }> {
  const renames: Array<{ id: string; name: string }> = [];
  for (const s of suggestions ?? []) {
    const id = String(s?.id ?? "");
    const name = sanitizeName(s?.suggestedName);
    if (id && name) renames.push({ id, name });
  }
  return renames;
}

/** Pull the first JSON object out of a model reply (handles prose + fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(c.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Round 13 — salvage complete "id": "name" pairs from a truncated reply.
 * A reply cut off by max_tokens fails JSON.parse but usually contains
 * many usable entries; recover them instead of discarding the whole
 * batch. Only ids we asked about are kept, names sanitized.
 */
export function salvagePairs(
  text: string,
  knownIds: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([^"\n]{1,60})"\s*:\s*"([^"\n]{1,80})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (!knownIds.has(id)) continue;
    const clean = sanitizeName(m[2]);
    if (clean && !(id in out)) out[id] = clean;
  }
  return out;
}

/**
 * Max targets per vision call. Larger batches make the model's JSON
 * reply exceed max_tokens and truncate mid-object (Round 13 field
 * report: a 131-target frame returned perfectly good names that cut
 * off at the token limit). The same image is resent per chunk, so a
 * 131-target frame costs 4 calls instead of 1 — reliability first.
 */
export const MAX_TARGETS_PER_VISION_CALL = 40;

/** Append one JSONL line to the vision-rename log; never throws and
 *  never receives the API key — call sites pass safe fields only. */
export function appendVisionLog(logPath: string, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // logging must never break the rename flow
  }
}

/** HTTP error carrying the status, so retries can skip auth errors. */
class VisionHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function filterKnownNames(
  parsed: Record<string, unknown>,
  targets: RenameTarget[],
): Record<string, string> {
  const known = new Set(targets.map((t) => t.id));
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(parsed)) {
    const clean = sanitizeName(name);
    if (known.has(id) && clean && clean !== targets.find((t) => t.id === id)?.currentName) {
      out[id] = clean;
    }
  }
  return out;
}

/**
 * Ask the vision model to name the targets, given the rendered frame PNG
 * (base64, no data: prefix) — returns id → name, sanitized and filtered
 * to known target ids. Batches larger than MAX_TARGETS_PER_VISION_CALL
 * are split into chunks (same image resent); each chunk retries once on
 * a no-JSON reply or a 429/5xx, and a truncated reply is salvaged for
 * its complete pairs. Throws with the endpoint's message on HTTP error.
 */
export async function suggestNames(
  cfg: VisionConfig,
  imageBase64: string,
  targets: RenameTarget[],
  fetchImpl: typeof fetch = fetch,
  logPath?: string,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  const chunkCount = Math.max(1, Math.ceil(targets.length / MAX_TARGETS_PER_VISION_CALL));
  for (let c = 0; c < chunkCount; c++) {
    const chunk = targets.slice(c * MAX_TARGETS_PER_VISION_CALL, (c + 1) * MAX_TARGETS_PER_VISION_CALL);
    Object.assign(merged, await suggestNamesForChunk(cfg, imageBase64, chunk, fetchImpl, logPath, c, chunkCount));
  }
  return merged;
}

async function suggestNamesForChunk(
  cfg: VisionConfig,
  imageBase64: string,
  targets: RenameTarget[],
  fetchImpl: typeof fetch,
  logPath: string | undefined,
  chunkIndex: number,
  chunkCount: number,
): Promise<Record<string, string>> {
  const facts = targets.map((t) => ({
    id: t.id,
    current_name: t.currentName,
    type: t.type,
    size: `${t.width}x${t.height}`,
    text_inside: t.textInside,
  }));
  const prompt = [
    "You rename layers in a Figma design. The image is a screenshot of the selected frame.",
    "The JSON below lists its unnamed layers (default names like \"Frame 336\"): their id, type,",
    "pixel size, and the text content found inside each. For every id, propose a concise",
    "descriptive English name (1-4 words, like \"Top Nav\", \"Reel Video Player\", \"Save Dialog\").",
    "Use the layer's size and position in the image plus its text content. Keep names specific",
    "to what the layer visibly is, not generic (not \"Container\", \"Frame\", \"Section\").",
    "Respond with ONLY a JSON object mapping id to name, no other text:",
    "",
    JSON.stringify(facts),
  ].join("\n");
  const logEvent = (e: Record<string, unknown>) => {
    if (!logPath) return;
    appendVisionLog(logPath, {
      model: cfg.model,
      source: cfg.source,
      baseUrlHost: new URL(cfg.baseUrl).host,
      chunkIndex,
      chunkCount,
      chunkTargets: targets.length,
      imageBytes: imageBase64.length,
      ...e,
    });
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 3000,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new VisionHttpError(res.status, `vision endpoint ${res.status}: ${body.slice(0, 300)}`);
      }
      const data: any = await res.json();
      const message = data?.choices?.[0]?.message ?? {};
      // Empty-string content is NOT nullish — check reasoning_content too
      // (some endpoints reply reasoning-only with content: "").
      const content: string = typeof message.content === "string" ? message.content : "";
      const reasoning: string = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      const parsed = extractJson(content) ?? extractJson(reasoning);
      const names = parsed
        ? filterKnownNames(parsed, targets)
        : salvagePairs(content || reasoning, new Set(targets.map((t) => t.id)));
      logEvent({
        attempt,
        ok: Object.keys(names).length > 0,
        httpStatus: res.status,
        parsedCount: Object.keys(names).length,
        contentExcerpt: content.slice(0, 300),
        reasoningExcerpt: reasoning.slice(0, 300),
        durationMs: Date.now() - t0,
      });
      if (Object.keys(names).length > 0) return names;
      if (parsed && Object.keys(names).length === 0) {
        // usable JSON, but nothing survived filtering — nothing to retry
        return names;
      }
      lastError = new Error(`vision model returned no JSON object (${(content || reasoning).slice(0, 200)})`);
    } catch (e) {
      // Auth/bad-request errors will not get better with a retry.
      if (e instanceof VisionHttpError && e.status !== 429 && e.status < 500) {
        logEvent({ attempt, ok: false, httpStatus: e.status, error: e.message.slice(0, 300), durationMs: Date.now() - t0 });
        throw e;
      }
      lastError = e as Error;
      logEvent({ attempt, ok: false, error: (e as Error).message.slice(0, 300), durationMs: Date.now() - t0 });
    }
  }
  throw lastError ?? new Error("vision model failed");
}
