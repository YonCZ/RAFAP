import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectRenameTargets,
  extractJson,
  isLazyName,
  resolveVisionConfig,
  sanitizeName,
  suggestNames,
  suggestionsToRenames,
  salvagePairs,
  type RenameTarget,
  type VisionConfig,
} from "../lib/vision-rename.js";

describe("isLazyName", () => {
  it("matches Figma default names", () => {
    for (const n of ["Frame 336", "frame 12", "Group 5", "Component 1", "Instance 42", "Section 3", "Rectangle 9", "Vector 100", "Ellipse 4", "Line 7", "Polygon 2", "Star 8"]) {
      expect(isLazyName(n)).toBe(true);
    }
  });

  it("rejects deliberate names and non-names", () => {
    for (const n of ["Frame", "NavBar", "Frame A", "Frame 336 copy", "Storage Page Empty", "", undefined, null, 42, "Top Nav"]) {
      expect(isLazyName(n)).toBe(false);
    }
  });
});

describe("resolveVisionConfig", () => {
  const opencodeConfig = JSON.stringify({
    provider: {
      einfra: {
        options: { baseURL: "https://llm.example/v1", apiKey: "secret-key" },
        models: { "glm-5.3": { name: "GLM" }, "qwen3.8-27b": { name: "Qwen" } },
      },
    },
  });

  it("prefers env vars when all three are set", () => {
    const cfg = resolveVisionConfig(
      { VISION_BASE_URL: "https://x.example/v1", VISION_MODEL: "my-model", VISION_API_KEY: "k" },
      () => null,
    );
    expect(cfg).toMatchObject({ baseUrl: "https://x.example/v1", model: "my-model", apiKey: "k", source: "env VISION_*" });
  });

  it("falls back to the OpenCode config, preferring Gemma then Qwen models", () => {
    const cfg = resolveVisionConfig({}, () => opencodeConfig);
    expect(cfg).toMatchObject({ baseUrl: "https://llm.example/v1", model: "qwen3.8-27b", apiKey: "secret-key" });
    const withGemma = resolveVisionConfig(
      {},
      () => opencodeConfig.replace('"qwen3.8-27b"', '"gemma4"'),
    );
    expect(withGemma).toMatchObject({ model: "gemma4" });
  });

  it("returns null when nothing is configured", () => {
    expect(resolveVisionConfig({}, () => null)).toBeNull();
    expect(resolveVisionConfig({}, () => "not json")).toBeNull();
    expect(resolveVisionConfig({}, () => JSON.stringify({ provider: { x: { options: { baseURL: "u" } } } }))).toBeNull();
  });
});

/** Root deliberately named — only its lazy child is a rename target. */
function doc() {
  return {
    id: "1:1",
    name: "Read View",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 1200, height: 800 },
    children: [
      {
        id: "1:2",
        name: "Top Nav",
        type: "FRAME",
        absoluteBoundingBox: { width: 1200, height: 80 },
        children: [
          { id: "1:3", name: "Logo", type: "TEXT", characters: "Pohodlnë", absoluteBoundingBox: { width: 100, height: 30 } },
        ],
      },
      {
        id: "1:4",
        name: "Frame 337",
        type: "FRAME",
        absoluteBoundingBox: { width: 537, height: 700 },
        children: [
          { id: "1:5", name: "Headline", type: "TEXT", characters: "Truth score: 82%", absoluteBoundingBox: { width: 400, height: 32 } },
          { id: "1:6", name: "Body", type: "TEXT", characters: `First line\nsecond line with ${"x".repeat(100)}`, absoluteBoundingBox: { width: 400, height: 300 } },
        ],
      },
      { id: "1:7", name: "Rectangle 9", type: "RECTANGLE", absoluteBoundingBox: { width: 16, height: 16 }, children: [] },
    ],
  };
}

describe("collectRenameTargets", () => {
  it("takes lazy-named structural nodes only — never deliberate names or non-structural leaves", () => {
    expect(collectRenameTargets(doc()).map((t) => t.id)).toEqual(["1:4"]);
  });

  it("includes the root when its own name is lazy", () => {
    const targets = collectRenameTargets({ ...doc(), name: "Frame 336" });
    expect(targets.map((t) => t.id)).toEqual(["1:1", "1:4"]);
  });

  it("collects text inside each target, whitespace-normalized and truncated to 60", () => {
    const targets = collectRenameTargets(doc());
    const expectedBody = `First line second line with ${"x".repeat(100)}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    expect(targets[0].textInside).toEqual(["Truth score: 82%", expectedBody]);
    expect(targets[0]).toMatchObject({ currentName: "Frame 337", type: "FRAME", width: 537, height: 700 });
  });

  it("returns nothing for an all-named subtree", () => {
    expect(collectRenameTargets({ ...doc(), children: [{ ...doc().children![0] }] })).toEqual([]);
  });
});

describe("sanitizeName", () => {
  it("collapses whitespace, strips wrapping quotes, caps length", () => {
    expect(sanitizeName('  "Top\n Nav"  ')).toBe("Top Nav");
    expect(sanitizeName("x".repeat(80)).length).toBe(48);
  });
  it("rejects junk", () => {
    expect(sanitizeName("")).toBe("");
    expect(sanitizeName(null)).toBe("");
    expect(sanitizeName(42)).toBe("");
    expect(sanitizeName('""')).toBe("");
  });
});

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"1:1": "Top Nav"}')).toEqual({ "1:1": "Top Nav" });
  });
  it("parses fenced JSON with prose around it", () => {
    const t = "Here you go:\n```json\n{\"a\": \"B\"}\n```\nhope that helps";
    expect(extractJson(t)).toEqual({ a: "B" });
  });
  it("returns null when there is no object", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("suggestNames", () => {
  const cfg: VisionConfig = { baseUrl: "https://llm.example/v1", model: "test-model", apiKey: "k", source: "test" };
  const targets: RenameTarget[] = [
    { id: "1:1", currentName: "Frame 336", type: "FRAME", width: 1200, height: 800, textInside: ["Pohodlnë"] },
    { id: "1:4", currentName: "Frame 337", type: "FRAME", width: 537, height: 700, textInside: [] },
  ];

  const okReply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it("sends an OpenAI-compatible image request and maps ids to sanitized names", async () => {
    let captured: { url: string; body: any } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return okReply('{"1:1": "Top Nav", "1:4": "Summary Panel"}');
    }) as unknown as typeof fetch;
    const names = await suggestNames(cfg, "aGVsbG8=", targets, f);
    expect(names).toEqual({ "1:1": "Top Nav", "1:4": "Summary Panel" });
    expect(captured!.url).toBe("https://llm.example/v1/chat/completions");
    expect(captured!.body.model).toBe("test-model");
    const content = captured!.body.messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Frame 336");
    expect(content[1].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("drops unknown ids, unsanitizable names, and no-op renames", async () => {
    const f = (async () => okReply('{"9:9": "X", "1:1": "  ", "1:4": ""}')) as unknown as typeof fetch;
    expect(await suggestNames(cfg, "aGVsbG8=", targets, f)).toEqual({});
  });

  it("handles fenced replies and reasoning-style content", async () => {
    const f = (async () =>
      okReply('thinking about it…```json\n{"1:1": "Read View"}\n```')) as unknown as typeof fetch;
    expect(await suggestNames(cfg, "aGVsbG8=", targets, f)).toEqual({ "1:1": "Read View" });
  });

  it("throws with endpoint detail on HTTP error", async () => {
    const f = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(suggestNames(cfg, "aGVsbG8=", targets, f)).rejects.toThrow(/401/);
  });

  it("throws when the reply contains no JSON", async () => {
    const f = (async () => okReply("I cannot see images")) as unknown as typeof fetch;
    await expect(suggestNames(cfg, "aGVsbG8=", targets, f)).rejects.toThrow(/no JSON/);
  });
});

describe("suggestNames — Round 13 hardening (chunking, retry, salvage, logs)", () => {
  const cfg: VisionConfig = { baseUrl: "https://llm.example/v1", model: "test-model", apiKey: "sk-secret-abc123", source: "test" };
  const mkTargets = (n: number): RenameTarget[] =>
    Array.from({ length: n }, (_, i) => ({ id: `1:${i + 1}`, currentName: `Frame ${i + 1}`, type: "FRAME", width: 100, height: 100, textInside: [] }));
  const reply = (message: Record<string, unknown>) =>
    new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  const contentReply = (content: string) => reply({ content });

  it("splits large batches into chunks of ≤ MAX_TARGETS_PER_VISION_CALL", async () => {
    const calls: number[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const facts = JSON.parse(body.messages[0].content[0].text.split("\n\n")[1] ?? "[]");
      calls.push(facts.length);
      const names = Object.fromEntries(facts.map((t: any) => [t.id, "Named " + t.id]));
      return contentReply(JSON.stringify(names));
    }) as unknown as typeof fetch;
    const out = await suggestNames(cfg, "aGVsbG8=", mkTargets(95), f);
    expect(calls).toEqual([40, 40, 15]);
    expect(Object.keys(out)).toHaveLength(95);
  });

  it("parses reasoning-only replies (content is empty string, not null)", async () => {
    const f = (async () => reply({ content: "", reasoning_content: '{"1:1": "Top Nav"}' })) as unknown as typeof fetch;
    expect(await suggestNames(cfg, "aGVsbG8=", mkTargets(1), f)).toEqual({ "1:1": "Top Nav" });
  });

  it("retries once on a no-JSON reply and succeeds on the second attempt", async () => {
    let n = 0;
    const f = (async () => contentReply(++n === 1 ? "hmm I cannot" : '{"1:1": "Top Nav"}')) as unknown as typeof fetch;
    expect(await suggestNames(cfg, "aGVsbG8=", mkTargets(1), f)).toEqual({ "1:1": "Top Nav" });
    expect(n).toBe(2);
  });

  it("does not retry auth errors (4xx)", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response("denied", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(suggestNames(cfg, "aGVsbG8=", mkTargets(1), f)).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });

  it("salvages complete pairs from a truncated reply instead of failing", async () => {
    const truncated = '{"1:1": "Top Nav", "1:2": "Summ'; // cut at max_tokens
    const f = (async () => contentReply(truncated)) as unknown as typeof fetch;
    expect(await suggestNames(cfg, "aGVsbG8=", mkTargets(2), f)).toEqual({ "1:1": "Top Nav" });
  });

  it("logs each attempt as JSONL without the API key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-log-"));
    const logPath = path.join(dir, "vision-rename.jsonl");
    const f = (async () => contentReply('{"1:1": "Top Nav"}')) as unknown as typeof fetch;
    await suggestNames(cfg, "aGVsbG8=", mkTargets(1), f, logPath);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ model: "test-model", ok: true, parsedCount: 1, chunkIndex: 0, chunkCount: 1 });
    expect(lines[0].contentExcerpt).toContain("Top Nav");
    expect(fs.readFileSync(logPath, "utf8")).not.toContain("sk-secret-abc123");
  });
});

describe("salvagePairs (truncated-reply recovery)", () => {
  it("keeps only known ids with complete, sanitizable pairs", () => {
    const text = 'junk ```json\n{"1:1": "Top Nav", "1:2": "Half", "1:3": "Ignored Pair"';
    const out = salvagePairs(text, new Set(["1:1", "1:2"]));
    // 1:3 not in known set; "1:3" pair IS complete in text so it is filtered by id
    expect(out).toEqual({ "1:1": "Top Nav", "1:2": "Half" });
  });

  it("returns empty when nothing usable is present", () => {
    expect(salvagePairs("no pairs here", new Set(["1:1"]))).toEqual({});
  });
});

describe("suggestionsToRenames (Round 13 — one-click button path)", () => {
  it("keeps only suggestions with a usable name, sanitized", () => {
    const out = suggestionsToRenames([
      { id: "1:1", suggestedName: "  \"Top Nav\"  " },
      { id: "1:4", suggestedName: null },
      { id: "1:7", suggestedName: "" },
      { id: "1:9", suggestedName: "Footer Links" },
      { id: "", suggestedName: "no id" },
    ]);
    expect(out).toEqual([
      { id: "1:1", name: "Top Nav" },
      { id: "1:9", name: "Footer Links" },
    ]);
  });

  it("handles empty/absent input", () => {
    expect(suggestionsToRenames([])).toEqual([]);
    expect(suggestionsToRenames(undefined as unknown as [])).toEqual([]);
  });
});
