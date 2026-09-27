import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerAnnotationWriter } from "../src/zotero-annotations.ts";

const selection = () => ({ text: "Texto do PDF", position: { pageIndex: 2, rects: [[10, 20, 30, 40]], nextPageRects: [[1, 2, 3, 4]] },
  pageLabel: "iii", sortIndex: "00002|000010|00000", key: "EXISTING" });
function host() {
  const writes: any[] = [];
  let generated = 0;
  const attachment = { id: 9, libraryID: 1, deleted: false, parentItem: { deleted: false }, isPDFAttachment: () => true, isEditable: () => true };
  const zotero = { Items: { getAsync: async () => attachment, getByLibraryAndKey: (_library: number, _key: string) => null as any },
    DataObjectUtilities: { generateKey: () => "NEW" + ++generated }, logError: () => {},
    Annotations: { saveFromJSON: async (item: any, json: any) => { writes.push({ item, json }); return { id: writes.length }; } } };
  return { zotero, writes, attachment };
}
test("one native highlight contains only the chosen final answer and preserves the captured PDF location", async () => {
  const { zotero, writes, attachment } = host(); const original = selection();
  const save = createAnswerAnnotationWriter(zotero, 9, original);
  original.position.rects[0][0] = 999; original.text = "Seleção alterada";
  assert.equal(await save({ question: "Por quê?", answer: "Resposta escolhida." }), 1);
  assert.equal(writes[0].item, attachment);
  const json = writes[0].json;
  assert.equal(json.type, "highlight"); assert.equal(json.key, "NEW1");
  assert.equal(json.text, "Texto do PDF"); assert.equal(json.pageLabel, "iii");
  assert.deepEqual(json.position, selection().position);
  assert.equal(json.comment, "Resposta da IA\n\nPergunta: Por quê?\n\nResposta escolhida.");
});
test("a retry reuses its own key; separate answers never overwrite the selection's existing annotation", async () => {
  const { zotero, writes } = host(); let attempts = 0;
  const actual = zotero.Annotations.saveFromJSON;
  zotero.Annotations.saveFromJSON = async (item, json) => { writes.push({ item, json }); if (++attempts === 1) throw new Error("write error"); return { id: 42 }; };
  const save = createAnswerAnnotationWriter(zotero, 9, selection()); const first = { question: "Q1", answer: "A1" };
  await assert.rejects(save(first)); assert.equal(await save(first), 42);
  await save({ question: "Q2", answer: "A2" });
  assert.deepEqual(writes.map(write => write.json.key), ["NEW1", "NEW1", "NEW2"]);
  zotero.Annotations.saveFromJSON = actual;
});
test("saving preserves the original LaTeX, never rendered markup", async () => {
  const { zotero, writes } = host();
  const answer = String.raw`A distribuição é \[q_{t\mid 0}(x_t\mid x_0)=\prod_{i=1}^{n}q_{t\mid 0}(x_t^{(i)}\mid x_0^{(i)})\].`;
  await createAnswerAnnotationWriter(zotero, 9, selection())({ question: "Explique a fórmula.", answer });
  assert.equal(writes[0].json.comment, "Resposta da IA\n\nPergunta: Explique a fórmula.\n\n" + answer);
  assert.doesNotMatch(writes[0].json.comment, /<math|<span/);
});
test("read-only, deleted PDFs, missing coordinates and incomplete answers fail before any write", async () => {
  for (const failure of ["readonly", "deleted", "position", "answer"]) {
    const { zotero, writes, attachment } = host(); const input = selection();
    if (failure === "readonly") attachment.isEditable = () => false;
    if (failure === "deleted") attachment.parentItem.deleted = true;
    if (failure === "position") input.position.rects = [[NaN, 0, 1, 2]];
    const save = createAnswerAnnotationWriter(zotero, 9, input);
    await assert.rejects(save({ question: "Q", answer: failure === "answer" ? " " : "A" }));
    assert.equal(writes.length, 0);
  }
});
