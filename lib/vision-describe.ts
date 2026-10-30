// Round 14 — vision-driven structural description of frames.
//
// Non-multimodal agents reason about designs from bounding-box arithmetic
// and invent theories ("the layout must be ratio-scaled") because they never
// SEE the design. This module is their eyes: render the frame, send the
// PNG plus the main layer facts (id, name, type, size, text inside) to a
// vision LLM, and get back a markdown description of the VISUAL structure
// that references layer ids — so it joins with get_outline's exact tree.
//
// Security: the API key comes from resolveVisionConfig (env or the user's
// OpenCode config) and is NEVER logged, returned, or committed. It stays
// server-side in the bridge process.

import { appendVisionLog, type VisionConfig } from "./vision-rename.js";

export interface DescribeFact {
  id: string;
  name: string;
  type: string;
  /** "WxH" in pixels. */
  size: string;
  /** Up to 4 text snippets inside the subtree (the content signal). */
  textInside: string[];
}

const DESCRIBABLE_TYPES = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "SECTION",
  "TEXT",
]);

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
 * Collect the main structural layers of a frame for the vision model:
 * structural types + TEXT nodes, down to `maxDepth` levels below the
 * frame itself, capped at `maxFacts` entries. Deep trees degrade
 * gracefully — the image still shows what the facts omit.
 */
export function collectStructuralFacts(
  document: unknown,
  opts: { maxDepth?: number; maxFacts?: number } = {},
): DescribeFact[] {
  const maxDepth = opts.maxDepth ?? 2;
  const maxFacts = opts.maxFacts ?? 60;
  const facts: DescribeFact[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (facts.length >= maxFacts || !node || typeof node !== "object") return;
    const n = node as WalkNode;
    if (typeof n.id === "string" && DESCRIBABLE_TYPES.has(String(n.type))) {
      const isText = String(n.type) === "TEXT";
      const textInside: string[] = [];
      if (isText && typeof n.characters === "string" && n.characters.trim()) {
        const t = n.characters.replace(/\s+/g, " ").trim().slice(0, 60);
        if (t) textInside.push(t);
      } else if (!isText) {
        collectText(n, textInside, 4);
      }
      facts.push({
        id: n.id,
        name: typeof n.name === "string" ? n.name : "",
        type: String(n.type),
        size: `${Math.round(n.absoluteBoundingBox?.width ?? 0)}x${Math.round(n.absoluteBoundingBox?.height ?? 0)}`,
        textInside,
      });
    }
    if (depth < maxDepth && Array.isArray(n.children)) {
      for (const c of n.children) visit(c, depth + 1);
    }
  };
  visit(document, 0);
  return facts;
}

/**
 * Ask the vision model to describe the visual structure of the rendered
 * frame — markdown prose referencing the layer ids from `facts`, so the
 * description joins with the outline/tree. Retries once on an empty
 * reply or a 429/5xx (mirroring the renamer). Throws with the
 * endpoint's message on HTTP error.
 */
export async function describeFrame(
  cfg: VisionConfig,
  imageBase64: string,
  facts: DescribeFact[],
  fetchImpl: typeof fetch = fetch,
  logPath?: string,
): Promise<string> {
  const prompt = [
    "You describe a Figma design for an engineer who will rebuild it in code.",
    "The image is a screenshot of the frame. The JSON lists its main layers:",
    "id, name, type, pixel size, and text content found inside.",
    "",
    "Write a markdown description of the VISUAL structure so the design can be",
    "reproduced: the overall layout (regions and each region's role), visual",
    "hierarchy (what dominates, what is secondary), alignment and grouping,",
    "spacing patterns, and notable visual details. Reference layer ids inline",
    'like "the game board (101:1561)" so the description joins with the layer tree.',
    "Describe only what is visible — do not invent behavior, responsiveness, or",
    "scaling that is not drawn. Be specific and concise (max ~350 words).",
    "",
    JSON.stringify(facts),
  ].join("\n");

  const logEvent = (e: Record<string, unknown>) => {
    if (!logPath) return;
    appendVisionLog(logPath, {
      op: "describe",
      model: cfg.model,
      source: cfg.source,
      baseUrlHost: new URL(cfg.baseUrl).host,
      factCount: facts.length,
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
          max_tokens: 2000,
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
        const err = new Error(`vision endpoint ${res.status}: ${body.slice(0, 300)}`) as Error & { httpStatus?: number };
        err.httpStatus = res.status;
        throw err;
      }
      const data: any = await res.json();
      const message = data?.choices?.[0]?.message ?? {};
      // Empty-string content is not nullish — check reasoning_content too.
      const content: string = typeof message.content === "string" ? message.content : "";
      const reasoning: string = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
      const description = (content.trim() || reasoning.trim()).trim();
      logEvent({
        attempt,
        ok: description.length > 0,
        httpStatus: res.status,
        descriptionChars: description.length,
        contentExcerpt: content.slice(0, 300),
        reasoningExcerpt: reasoning.slice(0, 300),
        durationMs: Date.now() - t0,
      });
      if (description) return description;
      lastError = new Error("vision model returned no description");
    } catch (e) {
      const status = (e as Error & { httpStatus?: number }).httpStatus;
      logEvent({ attempt, ok: false, httpStatus: status, error: (e as Error).message.slice(0, 300), durationMs: Date.now() - t0 });
      // Auth/bad-request errors will not get better with a retry.
      if (typeof status === "number" && status !== 429 && status < 500) throw e;
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error("vision describe failed");
}
