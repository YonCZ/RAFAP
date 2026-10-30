import { describe, expect, it } from "vitest";
import {
  collectRenameTargets,
  extractJson,
  isLazyName,
  resolveVisionConfig,
  sanitizeName,
  suggestNames,
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

  it("falls back to the OpenCode config, preferring Qwen models", () => {
    const cfg = resolveVisionConfig({}, () => opencodeConfig);
    expect(cfg).toMatchObject({ baseUrl: "https://llm.example/v1", model: "qwen3.8-27b", apiKey: "secret-key" });
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
