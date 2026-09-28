import test from "node:test";
import assert from "node:assert/strict";
import { LlamaClient } from "../src/client.ts";
import { DEFAULTS } from "../src/config.ts";
import type { FetchLike } from "../src/types.ts";

function fixture(options: { tokenCount?: number; runtimeContext?: number; slots?: number; events?: unknown[]; abrupt?: boolean; model?: string; loadedModel?: string } = {}) {
  const requests: { path: string; body: any }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    if (path === "/health") return json({ status: "ok" });
    if (path === "/props") return json({ default_generation_settings: { n_ctx: options.runtimeContext ?? DEFAULTS.contextTokens }, total_slots: options.slots ?? 1 });
    if (path === "/v1/models") return json({ data: [{ id: options.loadedModel ?? DEFAULTS.model }] });
    if (path === "/apply-template") return json({ prompt: "TEMPLATE COMPLETO" });
    if (path === "/tokenize") return json({ tokens: Array((options.tokenCount ?? 100) + (body.add_special ? 1 : 0)).fill(1) });
    const events = options.events ?? [
      { choices: [{ delta: { reasoning_content: "raciocínio privado" } }] },
      { choices: [{ delta: { content: "Explicação contextualizada." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 12 } },
    ];
    const text = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("") + (options.abrupt ? "" : "data: [DONE]\n\n");
    return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
  };
  return { client: new LlamaClient(fetcher, { ...DEFAULTS, model: options.model ?? DEFAULTS.model }), requests };
}
const messages = [{ role: "user" as const, content: "Artigo inteiro, inclusive referências." }];
test("real token budget prevents generation before any context can be dropped", async () => {
  const { client, requests } = fixture({ tokenCount: DEFAULTS.contextTokens - DEFAULTS.generationTokens });
  await assert.rejects(client.generate(messages, new AbortController().signal, () => {}), /artigo não será cortado/);
  assert.ok(!requests.some(r => r.path === "/v1/chat/completions"));
  assert.deepEqual(requests.find(r => r.path === "/apply-template")!.body.messages, messages);
  assert.equal(requests.find(r => r.path === "/tokenize")!.body.add_special, true);
  assert.equal(requests.find(r => r.path === "/tokenize")!.body.parse_special, true);
});
test("initial model token is included at the exact context boundary", async () => {
  const signal = new AbortController().signal;
  const inputBudget = DEFAULTS.contextTokens - DEFAULTS.generationTokens;
  assert.equal(await fixture({ tokenCount: inputBudget - 1 }).client.prepare(messages, signal), inputBudget);
  await assert.rejects(fixture({ tokenCount: inputBudget }).client.prepare(messages, signal), /excedem/);
});
test("uses actual server context and refuses multiple slots", async () => {
  await assert.rejects(fixture({ runtimeContext: 8192, tokenCount: 5000 }).client.prepare(messages, new AbortController().signal), /excedem/);
  await assert.rejects(fixture({ slots: 2 }).client.prepare(messages, new AbortController().signal), /único slot/);
});
test("model selection refuses a different server before sending the paper", async () => {
  const { client, requests } = fixture({ model: "lfm2.5-8b-a1b" });
  await assert.rejects(client.generate(messages, new AbortController().signal, () => {}), /Reinicie-o com --model lfm2\.5-8b-a1b/);
  assert.deepEqual(requests.map(request => request.path), ["/health", "/props", "/v1/models"]);
});
test("larger model uses its own template and keeps reasoning out of the answer", async () => {
  const model = "lfm2.5-8b-a1b";
  const { client, requests } = fixture({ model, loadedModel: model }); let displayed = "";
  const result = await client.generate(messages, new AbortController().signal, text => displayed += text);
  assert.equal(requests.at(-1)!.body.model, model);
  assert.deepEqual(requests.find(request => request.path === "/apply-template")!.body.messages, messages);
  assert.equal(result.answer, displayed);
  assert.ok(!displayed.includes("raciocínio"));
});
test("displays only final content and records cold prompt setting", async () => {
  const { client, requests } = fixture(); let displayed = "";
  const result = await client.generate(messages, new AbortController().signal, text => displayed += text, false);
  assert.equal(displayed, "Explicação contextualizada."); assert.equal(result.answer, displayed);
  assert.equal(result.completionTokens, 12);
  assert.equal(requests.at(-1)!.body.cache_prompt, false);
});
test("interrupted and token-limited responses are not successful answers", async () => {
  await assert.rejects(fixture({ abrupt: true }).client.generate(messages, new AbortController().signal, () => {}), /conexão terminou/i);
  await assert.rejects(fixture({ events: [{ choices: [{ delta: { content: "Parcial" }, finish_reason: "length" }] }] }).client.generate(messages, new AbortController().signal, () => {}), /limite/);
  await assert.rejects(fixture({ events: [{ choices: [{ delta: { reasoning_content: "pensamento" }, finish_reason: "stop" }] }] }).client.generate(messages, new AbortController().signal, () => {}), /sem uma resposta final/);
});
test("connection error and cancellation remain distinguishable", async () => {
  const client = new LlamaClient(async () => { throw new TypeError("socket unavailable"); });
  await assert.rejects(client.prepare(messages, new AbortController().signal), /conectar/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.prepare(messages, abort.signal), /cancelado/);
});
