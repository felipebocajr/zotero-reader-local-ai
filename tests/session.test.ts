import test from "node:test";
import assert from "node:assert/strict";
import { ReadingSession, RequestGate } from "../src/session.ts";
import { PaperCache } from "../src/paper.ts";
import { DEFAULTS } from "../src/config.ts";
import type { LlamaClient } from "../src/client.ts";
import type { Message, SaveAnswer, Settings } from "../src/types.ts";

const paper = { text: "artigo", title: "Paper", extractedPages: 1, totalPages: 1 };
function sessionWith(gate: RequestGate, generate: LlamaClient["generate"], changed = () => {}, save?: SaveAnswer, settings: () => Settings = () => DEFAULTS) {
  const cache = new PaperCache({ describe: async () => ({ path: "/a", title: "A", size: 1, modified: 1 }), extract: async () => paper });
  return new ReadingSession(1, "trecho", cache, gate, () => ({ generate }) as LlamaClient, settings, changed, save);
}
test("session reads the language for each request, including an existing conversation", async () => {
  let settings = { ...DEFAULTS };
  const requests: Message[][] = [];
  const session = sessionWith(new RequestGate(), async messages => {
    requests.push(messages); return { answer: "Original answer " + requests.length, promptTokens: 1 };
  }, () => {}, undefined, () => settings);
  await session.ask("Explain this English passage.");
  settings = { ...settings, responseLanguage: "en" };
  await session.ask("Uma continuação em português.", true);
  settings = { ...settings, responseLanguage: "pt-BR" };
  await session.ask("Outra continuação.", true);
  assert.match(requests[0][0].content, /^Answer in Brazilian Portuguese/);
  assert.match(requests[1].at(-1)!.content, /Answer in English \(en\)/);
  assert.match(requests[2].at(-1)!.content, /Answer in Brazilian Portuguese/);
  assert.deepEqual(session.state.history.map(turn => turn.question), ["Explain this English passage.", "Uma continuação em português.", "Outra continuação."]);
  assert.deepEqual(session.state.history.map(turn => turn.answer), ["Original answer 1", "Original answer 2", "Original answer 3"]);
});
test("only successful turns enter history; new questions reset it", async () => {
  let calls = 0;
  const session = sessionWith(new RequestGate(), async () => { if (++calls === 3) throw new Error("broken"); return { answer: "resposta " + calls, promptTokens: 1 }; });
  await session.ask("inicial"); await session.ask("continuação", true);
  assert.equal(session.state.history.length, 2);
  await session.ask("falha", true); assert.equal(session.state.history.length, 2); assert.equal(session.state.draft, "");
  await session.ask("outra inicial"); assert.equal(session.state.history.length, 1); assert.equal(session.state.history[0].question, "outra inicial");
});
test("a global gate prevents simultaneous inference from different popups", async () => {
  let finish!: () => void;
  const gate = new RequestGate();
  const one = sessionWith(gate, async () => { await new Promise<void>(resolve => finish = resolve); return { answer: "A", promptTokens: 1 }; });
  const two = sessionWith(gate, async () => ({ answer: "B", promptTokens: 1 }));
  const pending = one.ask("A"); await new Promise(resolve => setImmediate(resolve));
  await two.ask("B"); assert.match(two.state.error, /pedido em andamento/);
  finish(); await pending; await two.ask("B"); assert.equal(two.state.history[0].answer, "B");
});
test("closing aborts work and prevents late history/UI updates", async () => {
  let changed = 0, signal!: AbortSignal, finish!: () => void;
  const session = sessionWith(new RequestGate(), async (_messages, requestSignal) => { signal = requestSignal; await new Promise<void>(resolve => finish = resolve); return { answer: "late", promptTokens: 1 }; }, () => { changed++; });
  const pending = session.ask("A"); await new Promise(resolve => setImmediate(resolve));
  session.dispose(); const before = changed; assert.equal(signal.aborted, true); finish(); await pending;
  assert.equal(changed, before); assert.equal(session.state.history.length, 0);
});
test("saving selects one completed answer and deduplicates simultaneous or repeated clicks", async () => {
  const saved: string[] = []; let finish!: (id: number) => void;
  const session = sessionWith(new RequestGate(), async messages => ({ answer: messages.at(-1)!.content, promptTokens: 1 }), () => {},
    turn => { saved.push(turn.question); return new Promise(resolve => { finish = resolve; }); });
  await session.ask("primeira"); await session.ask("segunda", true);
  assert.equal(saved.length, 0); // Asking never persists an annotation.
  const pending = session.saveAnswer(0);
  await session.saveAnswer(0); assert.deepEqual(saved, ["primeira"]);
  assert.equal(session.state.answerSaves[0].phase, "saving");
  finish(123); await pending; await session.saveAnswer(0);
  assert.equal(session.state.answerSaves[0].annotationId, 123);
  assert.equal(session.state.answerSaves[1].phase, "idle"); assert.deepEqual(saved, ["primeira"]);
});
test("failed or streaming answers cannot be saved; save errors leave completed answers retryable", async () => {
  let calls = 0, attempts = 0;
  const session = sessionWith(new RequestGate(), async (_messages, _signal, streamed) => {
    if (++calls === 1) { streamed("rascunho incompleto"); throw new Error("interrupted"); }
    return { answer: "final", promptTokens: 1 };
  }, () => {}, async () => { if (++attempts === 1) throw new Error("write failure"); return 5; });
  await session.ask("falha"); await session.saveAnswer(0); assert.equal(attempts, 0);
  await session.ask("ok"); await session.saveAnswer(0);
  assert.equal(session.state.phase, "complete"); assert.equal(session.state.history[0].answer, "final");
  assert.equal(session.state.answerSaves[0].phase, "error"); assert.match(session.state.answerSaves[0].error!, /salvar/);
  await session.saveAnswer(0); assert.equal(session.state.answerSaves[0].phase, "saved"); assert.equal(attempts, 2);
});
test("late annotation saves after reset or close cannot update a different conversation", async () => {
  let finish!: (id: number) => void, changes = 0;
  const session = sessionWith(new RequestGate(), async () => ({ answer: "final", promptTokens: 1 }), () => { changes++; },
    () => new Promise(resolve => { finish = resolve; }));
  await session.ask("antiga"); const pending = session.saveAnswer(0);
  session.reset(); await session.ask("nova"); finish(1); await pending;
  assert.equal(session.state.answerSaves[0].phase, "idle");
  const onClose = session.saveAnswer(0); session.dispose(); const before = changes;
  finish(2); await onClose; assert.equal(changes, before); assert.equal(session.state.history.length, 0);
});
