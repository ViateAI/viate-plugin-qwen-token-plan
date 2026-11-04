import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chatCompletions, imageGenerations, normalizeCredentials } from "./index.js";
import { imageEdits, listModels } from "./index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("qwen token plan", () => {
  it("defaults to the Beijing compatible-mode host", () => {
    const normalized = normalizeCredentials({ apiKey: "sk-test" });
    assert.equal(normalized.displayLabel, "token-plan.cn-beijing.maas.aliyuncs.com (china-beijing)");
  });

  it("posts chat to the regional compatible-mode endpoint", async () => {
    let seen = "";
    globalThis.fetch = async (input, init) => {
      seen = String(input);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-test");
      return Response.json({ id: "c1", choices: [] });
    };
    const result = await chatCompletions(
      { body: { model: "deepseek-v4.1-flash", messages: [] }, headers: {} },
      connection({ apiKey: "sk-test", region: "china-beijing" }),
    );
    assert.equal(result.status, 200);
    assert.equal(
      seen,
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    assert.equal(typeof result.parseUsage, "function");
  });

  it("maps Wan image generation onto the multimodal endpoint", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body));
      return Response.json({
        output: { choices: [{ message: { content: [{ image: "https://cdn.example/wan.png" }] } }] },
      });
    };
    const result = await imageGenerations(
      { body: { model: "wan2.7-image-pro", prompt: "A horse", size: "2048x2048", n: 1 }, headers: {} },
      connection({ apiKey: "sk-test" }),
    );
    assert.equal(
      seenUrl,
      "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    assert.deepEqual(seenBody, {
      model: "wan2.7-image-pro",
      input: { messages: [{ role: "user", content: [{ text: "A horse" }] }] },
      parameters: { size: "2048*2048", n: 1 },
    });
    const payload = JSON.parse(await new Response(result.body).text()) as { data: Array<{ url: string }> };
    assert.deepEqual(payload.data, [{ url: "https://cdn.example/wan.png" }]);
  });

  it("edits Wan images with the reference bytes and extra parameters", async () => {
    let seenBody: unknown;
    globalThis.fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body));
      return Response.json({
        output: { choices: [{ message: { content: [{ image: "https://cdn.example/edit.png" }] } }] },
      });
    };
    const result = await imageEdits(
      {
        body: {
          model: "wan2.7-image",
          prompt: "blue horse",
          negative_prompt: "text",
          images: [{ b64_json: "cG5n", media_type: "image/png" }],
        },
        headers: {},
      },
      connection({ apiKey: "sk-test" }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(seenBody, {
      model: "wan2.7-image",
      input: {
        messages: [{
          role: "user",
          content: [
            { image: "data:image/png;base64,cG5n" },
            { text: "blue horse" },
          ],
        }],
      },
      parameters: { negative_prompt: "text" },
    });
  });

  it("publishes Wan models missing from the text catalog", async () => {
    globalThis.fetch = async () => Response.json({ data: [{ id: "qwen3.8-flash", object: "model" }] });
    const listed = await listModels({ headers: {} }, connection({ apiKey: "sk-test" }));
    assert.deepEqual(listed.data.map((model) => model.id), [
      "qwen3.8-flash",
      "wan2.7-image",
      "wan2.7-image-pro",
    ]);
  });
});

function connection(credentials: unknown) {
  return { connectionId: "c1", providerId: "qwen-cloud-token-plan", credentials };
}
