import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, GROQ_BASE_URL, validateSettings } from "../src/config.ts";
import { GroqClient, parseGroqModels } from "../src/groq.ts";
import type { FetchLike, Settings } from "../src/types.ts";

const groqSettings: Settings = {
  ...DEFAULTS,
  provider: "groq",
  model: "openai/gpt-oss-120b",
  apiKey: "gsk_test_key",
};

function sse(events: unknown[], done = true): Response {
  const text = events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

function fixture(options: { events?: unknown[]; status?: number; body?: string; done?: boolean; settings?: Settings } = {}) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (options.status && options.status >= 400) return new Response(options.body ?? "erro", { status: options.status });
    return sse(options.events ?? [
      { choices: [{ delta: { reasoning_content: "raciocínio privado" } }] },
      { choices: [{ delta: { content: "Explicação contextualizada." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 12 } },
    ], options.done ?? true);
  };
  return { client: new GroqClient(fetcher, options.settings ?? groqSettings), requests };
}
const messages = [{ role: "user" as const, content: "Artigo inteiro, inclusive referências." }];

test("Groq settings use the fixed HTTPS endpoint and require a model", () => {
  const settings = validateSettings({ ...groqSettings, baseUrl: "http://127.0.0.1:8080", apiKey: "  gsk_test_key  " });
  assert.equal(settings.provider, "groq");
  assert.equal(settings.baseUrl, GROQ_BASE_URL);
  assert.equal(settings.apiKey, "gsk_test_key");
  assert.equal(settings.model, "openai/gpt-oss-120b");
  assert.throws(() => validateSettings({ ...groqSettings, model: " " }), /modelo do Groq/);
  assert.throws(() => validateSettings({ ...groqSettings, apiKey: "chave\nquebrada" }), /caracteres inválidos/);
  assert.throws(() => validateSettings({ ...groqSettings, contextTokens: 131073 }), /131\.072/);
  assert.throws(() => validateSettings({ ...groqSettings, generationTokens: 64000 }), /reserva de geração/);
  assert.throws(() => validateSettings({ ...groqSettings, provider: "openai" as any }), /servidor local ou o Groq/);
});

test("Groq request sends only supported OpenAI-compatible fields", async () => {
  const { client, requests } = fixture();
  const result = await client.generate(messages, new AbortController().signal, () => {});
  assert.equal(result.answer, "Explicação contextualizada.");
  assert.equal(result.completionTokens, 12);
  const request = requests[0];
  assert.equal(request.url, GROQ_BASE_URL + "/chat/completions");
  assert.equal((request.init?.headers as Record<string, string>).Authorization, "Bearer gsk_test_key");
  const body = JSON.parse(String(request.init?.body));
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.max_completion_tokens, DEFAULTS.generationTokens);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, messages);
  for (const unsupported of ["top_k", "repeat_penalty", "reasoning_format", "cache_prompt", "timings_per_token"]) {
    assert.equal(unsupported in body, false);
  }
});

test("Groq only sends reasoning_effort to reasoning models", async () => {
  const { client, requests } = fixture({ settings: { ...groqSettings, model: "llama-3.3-70b-versatile" } });
  await client.generate(messages, new AbortController().signal, () => {});
  const body = JSON.parse(String(requests[0].init?.body));
  assert.equal("reasoning_effort" in body, false);
});

test("Groq never displays reasoning fields or inline think tags", async () => {
  const { client } = fixture({
    events: [
      { choices: [{ delta: { reasoning_content: "privado" } }] },
      { choices: [{ delta: { content: "<think>privado</think>Resposta final." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ],
  });
  let displayed = "";
  const result = await client.generate(messages, new AbortController().signal, text => { displayed += text; });
  assert.equal(result.answer, "Resposta final.");
  assert.equal(displayed, "Resposta final.");
  assert.ok(!displayed.includes("privado"));
});

test("Groq model list keeps chat models and merges metadata", () => {
  const models = parseGroqModels({ data: [
    { id: "openai/gpt-oss-120b", owned_by: "OpenAI", context_window: 131072, max_completion_tokens: 65536, active: true },
    { id: "llama-3.3-70b-versatile", active: true },
    { id: "custom/chat-model", owned_by: "Custom", context_window: "64000", max_completion_tokens: "8192", active: true },
    { id: "openai/gpt-oss-safeguard-20b", active: true },
    { id: "whisper-large-v3", active: true },
    { id: "inactive-model", active: false },
  ] });
  const byId = new Map(models.map(model => [model.id, model]));
  assert.equal(byId.has("openai/gpt-oss-safeguard-20b"), false);
  assert.equal(byId.has("whisper-large-v3"), false);
  assert.equal(byId.has("inactive-model"), false);
  assert.equal(byId.get("openai/gpt-oss-120b")?.contextWindow, 131072);
  assert.equal(byId.get("openai/gpt-oss-120b")?.maxCompletionTokens, 65536);
  assert.equal(byId.get("openai/gpt-oss-120b")?.reasoning, true);
  assert.equal(byId.get("llama-3.3-70b-versatile")?.contextWindow, 131072);
  assert.equal(byId.get("llama-3.3-70b-versatile")?.maxCompletionTokens, 32768);
  assert.equal(byId.get("custom/chat-model")?.contextWindow, 64000);
  assert.equal(byId.get("custom/chat-model")?.maxCompletionTokens, 8192);
  assert.equal(models[0].id, "openai/gpt-oss-120b");
});

test("Groq model list accepts an empty or malformed payload", () => {
  assert.deepEqual(parseGroqModels(null), []);
  assert.deepEqual(parseGroqModels({ data: "not-an-array" }), []);
  assert.deepEqual(parseGroqModels({ data: [null, 1, { id: "" }] }), []);
});

test("Groq maps common provider errors without exposing credentials", async () => {
  for (const [status, pattern] of [
    [401, /chave da API do Groq/],
    [403, /chave da API do Groq/],
    [429, /limitou os pedidos/],
    [404, /modelo não foi encontrado/],
    [500, /indisponível/],
  ] as const) {
    const { client } = fixture({ status, body: "upstream error" });
    await assert.rejects(client.generate(messages, new AbortController().signal, () => {}), pattern);
  }
  const rateLimited = fixture({ status: 429, body: "service tier on_demand on input tokens per minute (ITPM): Limit 7000, Requested 22682" });
  await assert.rejects(rateLimited.client.generate(messages, new AbortController().signal, () => {}), /7000.*22682/);
  const { client } = fixture({ settings: { ...groqSettings, apiKey: "" } });
  await assert.rejects(client.generate(messages, new AbortController().signal, () => {}), /Informe a chave da API do Groq/);
});

test("Groq rejects oversized prompts before sending the article", async () => {
  const { client, requests } = fixture();
  const huge = [{ role: "user" as const, content: "x".repeat(DEFAULTS.contextTokens * 4) }];
  await assert.rejects(client.generate(huge, new AbortController().signal, () => {}), /artigo não será cortado/);
  assert.equal(requests.length, 0);
});

test("Groq refuses incomplete or filtered answers", async () => {
  await assert.rejects(fixture({ events: [{ choices: [{ delta: { content: "Parcial" }, finish_reason: "length" }] }] })
    .client.generate(messages, new AbortController().signal, () => {}), /limite de tokens/);
  await assert.rejects(fixture({ events: [{ choices: [{ delta: { content: "Bloqueado" }, finish_reason: "content_filter" }] }] })
    .client.generate(messages, new AbortController().signal, () => {}), /política de conteúdo/);
  await assert.rejects(fixture({ events: [{ choices: [{ delta: { content: "Sem fim" } }] }], done: false })
    .client.generate(messages, new AbortController().signal, () => {}), /encerrou a conexão/);
});
