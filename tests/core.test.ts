import test from "node:test";
import assert from "node:assert/strict";
import { validateSettings, DEFAULTS } from "../src/config.ts";
import { buildMessages } from "../src/prompt.ts";
import type { ResponseLanguage } from "../src/types.ts";
import { PaperCache } from "../src/paper.ts";
import { placePopup } from "../src/position.ts";
import { FinalTextFilter, readSSE } from "../src/sse.ts";

const paper = { text: "INTRODUÇÃO\nTudo que se sabe\nREFERÊNCIAS\nÚltima página", title: "Paper", totalPages: 2, extractedPages: 2 };
test("full article appears once, including final page, across follow-ups", () => {
  const messages = buildMessages(paper, "trecho", "E o resultado?", [{ question: "O que significa?", answer: "Explicação." }, { question: "Por quê?", answer: "Motivo." }]);
  assert.equal(messages.map(m => m.content).join("\n").split(paper.text).length - 1, 1);
  assert.ok(messages[1].content.includes("Última página"));
  assert.deepEqual(messages.slice(2).map(m => [m.role, m.content.split("\n\nRESPONSE LANGUAGE")[0]]), [["assistant", "Explicação."], ["user", "Por quê?"], ["assistant", "Motivo."], ["user", "E o resultado?"]]);
  assert.equal(buildMessages(paper, "trecho", "Independente").length, 2);
});
test("English is the default regardless of article and question language", () => {
  const article = { ...paper, text: "O trecho selecionado descreve a arquitetura do modelo.\n".repeat(3000) };
  const messages = buildMessages(article, "arquitetura do modelo", "Explique este trecho.");
  assert.equal(DEFAULTS.responseLanguage, "en");
  assert.match(messages[0].content, /Answer in English \(en\)/);
  assert.ok(messages[1].content.includes(article.text));
  assert.ok(messages[1].content.indexOf("RESPONSE LANGUAGE") > messages[1].content.indexOf("</artigo>"));
  assert.match(messages.at(-1)!.content, /Explique este trecho\.\n\nRESPONSE LANGUAGE[\s\S]*Answer in English/);
});
test("language changes apply to follow-ups without altering stored turns or copying the article", () => {
  const history = [{ question: "Primeira?", answer: "Resposta original." }, { question: "Segunda?", answer: "Another original answer." }];
  const before = JSON.stringify(history);
  for (const language of ["en", "pt-BR"] as const) {
    const messages = buildMessages(paper, "trecho", "Mais detalhes?", history, language);
    const instruction = language === "en" ? "Answer in English (en)" : "Answer in Brazilian Portuguese (pt-BR)";
    assert.ok(messages[0].content.startsWith(instruction));
    for (const message of messages.filter(message => message.role === "user")) assert.ok(message.content.includes(instruction));
    assert.equal(messages.map(message => message.content).join("\n").split(paper.text).length - 1, 1);
    assert.deepEqual(messages.filter(message => message.role === "assistant").map(message => message.content), history.map(turn => turn.answer));
    assert.ok(messages.at(-1)!.content.startsWith("Mais detalhes?\n\nRESPONSE LANGUAGE"));
  }
  assert.equal(JSON.stringify(history), before);
});
test("only supported language preferences are accepted and explicit requests remain possible", () => {
  assert.equal(validateSettings({ ...DEFAULTS, responseLanguage: "en" }).responseLanguage, "en");
  assert.equal(validateSettings({ ...DEFAULTS, responseLanguage: "pt-BR" }).responseLanguage, "pt-BR");
  assert.throws(() => validateSettings({ ...DEFAULTS, responseLanguage: "fr" as ResponseLanguage }), /idioma das respostas/);
  assert.throws(() => buildMessages(paper, "trecho", "Pergunta", [], "fr" as ResponseLanguage), /idioma das respostas/);
  const messages = buildMessages(paper, "trecho", "Responda em inglês, por favor.");
  assert.ok(messages[1].content.includes("Responda em inglês, por favor."));
  assert.match(messages[0].content, /Change language only if the user explicitly requests it/);
});
test("blank questions and selections are rejected", () => {
  assert.throws(() => buildMessages(paper, "trecho", " "));
  assert.throws(() => buildMessages(paper, " ", "pergunta"));
});
test("runtime cannot send article to remote host or via redirectable URL", () => {
  for (const baseUrl of ["https://example.com", "http://localhost:8080", "http://127.0.0.1.evil/", "http://127.0.0.1/a", "http://user@127.0.0.1", "http://127.0.0.1?redirect=evil"]) assert.throws(() => validateSettings({ ...DEFAULTS, baseUrl }));
  assert.equal(validateSettings({ ...DEFAULTS, baseUrl: "http://127.0.0.1:18080/" }).baseUrl, "http://127.0.0.1:18080");
});
test("context respects the selected model's limit without changing defaults", () => {
  assert.equal(validateSettings(DEFAULTS).model, "lfm2.5-8b-a1b");
  assert.equal(validateSettings({ ...DEFAULTS, model: "lfm2.5-2.6b", contextTokens: 131072 }).contextTokens, 131072);
  assert.equal(validateSettings({ ...DEFAULTS, model: "lfm2.5-8b-a1b", contextTokens: 128000 }).contextTokens, 128000);
  assert.throws(() => validateSettings({ ...DEFAULTS, model: "lfm2.5-8b-a1b", contextTokens: 131072 }), /128\.000/);
  assert.equal(validateSettings({ ...DEFAULTS, model: "lfm3-1.7b", contextTokens: 262144 }).contextTokens, 262144);
  assert.throws(() => validateSettings({ ...DEFAULTS, model: "lfm3-1.7b", contextTokens: 262145 }), /262\.144/);
  assert.throws(() => validateSettings({ ...DEFAULTS, model: "unknown" }), /modelos disponíveis/);
});
test("prompt requires an explicit insufficient-information statement", () => {
  const messages = buildMessages(paper, "trecho", "Pergunta");
  assert.match(messages[0].content, /does not contain enough information/);
  assert.match(messages[0].content, /first sentence/);
  assert.match(messages[0].content, /Do not fill the gap/);
  assert.match(messages[0].content, /clearly mark the rest as not reported/);
  const brief = buildMessages(paper, "trecho", "Explique", [], "en", "explain");
  assert.match(brief[0].content, /does not contain enough information/);
});
test("explain and detail modes use different instruction budgets", () => {
  const brief = buildMessages(paper, "trecho", "Explique brevemente.", [], "en", "explain");
  const detail = buildMessages(paper, "trecho", "Explique melhor.", [], "en", "detail");
  const typed = buildMessages(paper, "trecho", "Pergunta.", [], "en");
  assert.match(brief[0].content, /under 120 words/);
  assert.doesNotMatch(brief[0].content, /under 250 words/);
  assert.match(detail[0].content, /under 250 words/);
  assert.match(typed[0].content, /under 250 words/);
});
test("paper cache invalidates on file revision and refuses partial extraction", async () => {
  let modified = 1, extractions = 0;
  const source = { describe: async () => ({ path: "/paper.pdf", title: "Paper", modified, size: 10 }), extract: async () => { extractions++; return paper; } };
  const cache = new PaperCache(source);
  const signal = new AbortController().signal;
  await cache.get(1, signal); await cache.get(1, signal); assert.equal(extractions, 1);
  modified++; await cache.get(1, signal); assert.equal(extractions, 2);
  const partial = new PaperCache({ ...source, extract: async () => ({ ...paper, extractedPages: 1 }) });
  await assert.rejects(partial.get(1, signal), /todas as páginas/);
  const scan = new PaperCache({ ...source, extract: async () => ({ ...paper, text: " " }) });
  await assert.rejects(scan.get(1, signal), /OCR/);
});
test("file mutation during extraction never yields mixed context", async () => {
  let modified = 1;
  const cache = new PaperCache({ describe: async () => ({ path: "/a", title: "A", modified, size: 1 }), extract: async () => { modified++; return paper; } });
  await assert.rejects(cache.get(1, new AbortController().signal), /mudou durante/);
});
test("reasoning tags split at every character boundary stay hidden", () => {
  const filter = new FinalTextFilter(); let output = "";
  for (const c of "<think>segredo</think>Resposta final.") output += filter.push(c);
  output += filter.finish(); assert.equal(output, "Resposta final.");
  const unfinished = new FinalTextFilter(); assert.equal(unfinished.push("<think>segredo"), ""); assert.throws(() => unfinished.finish(), /resposta final/);
});
test("SSE preserves split UTF-8, CRLF boundaries, comments and multiline data", async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\ndata: {"texto":\r\ndata: "explicação"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const events = []; for await (const event of readSSE(stream, new AbortController().signal)) events.push(event);
  assert.deepEqual(events, ['{"texto":\n"explicação"}', "[DONE]"]);
});
test("canceling a pending SSE read reports cancellation even when read resolves done", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  const events = readSSE(stream, controller.signal);
  const pending = events.next();
  controller.abort();
  await assert.rejects(pending, /cancelado/);
});
test("popup placement stays inside all viewport edges", () => {
  for (const left of [0, 100, 995]) for (const top of [0, 400, 790]) {
    const point = placePopup({ left, top, bottom: top + 10, width: 10 }, 400, 300, { width: 1000, height: 800 });
    assert.ok(point.left >= 12 && point.left + 400 <= 988);
    assert.ok(point.top >= 12 && point.top + 300 <= 788);
  }
});
