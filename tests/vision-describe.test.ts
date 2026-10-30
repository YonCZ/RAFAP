// Round 14 — vision-driven structural description (describe_frames tool).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStructuralFacts, describeFrame } from "../lib/vision-describe.js";
import type { VisionConfig } from "../lib/vision-rename.js";

const cfg: VisionConfig = { baseUrl: "https://llm.example/v1", model: "test-model", apiKey: "sk-secret-abc123", source: "test" };

const doc = {
  id: "1:1",
  name: "Board Screen",
  type: "FRAME",
  absoluteBoundingBox: { width: 1440, height: 900 },
  children: [
    {
      id: "1:2",
      name: "Left Sidebar",
      type: "FRAME",
      absoluteBoundingBox: { width: 377, height: 900 },
      children: [
        { id: "1:3", name: "Score Label", type: "TEXT", characters: "Score: 12", absoluteBoundingBox: { width: 100, height: 20 } },
      ],
    },
    { id: "1:4", name: "Frame 99", type: "FRAME", absoluteBoundingBox: { width: 650, height: 900 }, children: [] },
    { id: "1:5", name: "Fill 1", type: "RECTANGLE", absoluteBoundingBox: { width: 10, height: 10 } }, // not describable
  ],
};

describe("collectStructuralFacts", () => {
  it("collects structural + TEXT layers with ids, names, sizes, and text content", () => {
    const facts = collectStructuralFacts(doc);
    expect(facts.map((f) => f.id)).toEqual(["1:1", "1:2", "1:3", "1:4"]); // RECTANGLE excluded, TEXT grandchild included
    expect(facts[1]).toMatchObject({ id: "1:2", name: "Left Sidebar", type: "FRAME", size: "377x900" });
    // text below depth cap still surfaces inside the container's facts
    expect(facts[1].textInside).toContain("Score: 12");
  });

  it("includes TEXT nodes with their characters as the fact's text", () => {
    const facts = collectStructuralFacts(doc, { maxDepth: 2 });
    const text = facts.find((f) => f.id === "1:3");
    expect(text).toMatchObject({ id: "1:3", type: "TEXT" });
    expect(text!.textInside).toEqual(["Score: 12"]);
  });

  it("caps facts at maxFacts and depth at maxDepth", () => {
    expect(collectStructuralFacts(doc, { maxDepth: 0 })).toHaveLength(1); // just the frame
    const wide = { ...doc, children: Array.from({ length: 99 }, (_, i) => ({ id: `2:${i}`, name: `F${i}`, type: "FRAME" })) };
    expect(collectStructuralFacts(wide, { maxFacts: 10 })).toHaveLength(10);
  });
});

describe("describeFrame", () => {
  const reply = (message: Record<string, unknown>) =>
    new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });

  it("sends the image + facts and returns the markdown description", async () => {
    let captured: { url: string; body: any } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return reply({ content: "## Layout\n\nThe board (1:4) dominates the center." });
    }) as unknown as typeof fetch;
    const out = await describeFrame(cfg, "aGVsbG8=", collectStructuralFacts(doc), f);
    expect(out).toContain("The board (1:4)");
    expect(captured!.url).toBe("https://llm.example/v1/chat/completions");
    expect(captured!.body.model).toBe("test-model");
    const content = captured!.body.messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Left Sidebar"); // facts included
    expect(content[0].text).toContain("do not invent behavior"); // grounding instruction
    expect(content[1].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("falls back to reasoning_content when content is empty", async () => {
    const f = (async () => reply({ content: "", reasoning_content: "The sidebar (1:2) holds the score." })) as unknown as typeof fetch;
    expect(await describeFrame(cfg, "aGVsbG8=", [], f)).toContain("The sidebar (1:2)");
  });

  it("retries once on an empty reply and logs attempts without the API key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "describe-log-"));
    const logPath = path.join(dir, "vision-rename.jsonl");
    let n = 0;
    const f = (async () => reply({ content: ++n === 1 ? "" : "Center column description." })) as unknown as typeof fetch;
    expect(await describeFrame(cfg, "aGVsbG8=", [], f, logPath)).toBe("Center column description.");
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ op: "describe", attempt: 1, ok: false });
    expect(lines[1]).toMatchObject({ op: "describe", attempt: 2, ok: true });
    expect(fs.readFileSync(logPath, "utf8")).not.toContain("sk-secret-abc123");
  });

  it("does not retry auth errors", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response("denied", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(describeFrame(cfg, "aGVsbG8=", [], f)).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });

  it("throws when both attempts return nothing", async () => {
    const f = (async () => reply({ content: "" })) as unknown as typeof fetch;
    await expect(describeFrame(cfg, "aGVsbG8=", [], f)).rejects.toThrow(/no description/);
  });
});
