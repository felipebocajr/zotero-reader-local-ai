import { ReaderError } from "./errors.ts";
import type { SaveAnswer, Turn } from "./types.ts";

export interface SelectionAnnotation { text?: string; position?: unknown; pageLabel?: string; sortIndex?: string }

// Isolate native annotation APIs and retain the selection's original PDF coordinates.
export function createAnswerAnnotationWriter(zotero: any, attachmentId: number, selection: SelectionAnnotation): SaveAnswer {
  const snapshot: SelectionAnnotation = JSON.parse(JSON.stringify(selection));
  const keys = new WeakMap<Turn, string>();
  return async turn => {
    const attachment = await zotero.Items.getAsync(attachmentId);
    if (!attachment?.isPDFAttachment() || attachment.deleted || attachment.parentItem?.deleted) {
      throw new ReaderError("annotation", "O PDF não está mais disponível para salvar esta resposta.");
    }
    if (!attachment.isEditable()) {
      throw new ReaderError("annotation", "Este PDF está em uma biblioteca sem permissão para editar anotações.");
    }
    const position = snapshot.position as { pageIndex?: number; rects?: number[][]; nextPageRects?: number[][] } | undefined;
    const validRects = (rects: unknown): rects is number[][] => Array.isArray(rects) && rects.length > 0
      && rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite));
    if (!position || !Number.isInteger(position.pageIndex) || position.pageIndex! < 0
      || !validRects(position.rects) || (position.nextPageRects && !validRects(position.nextPageRects))
      || !snapshot.sortIndex || !snapshot.text?.trim()) {
      throw new ReaderError("annotation", "Não foi possível localizar o trecho no PDF. Selecione-o novamente antes de salvar uma resposta.");
    }
    if (!turn.question.trim() || !turn.answer.trim()) throw new ReaderError("annotation", "Aguarde uma resposta completa antes de salvar.");
    if (typeof zotero.Annotations?.saveFromJSON !== "function") {
      throw new ReaderError("annotation", "Esta versão do Zotero não oferece a API de anotações necessária.");
    }
    let key = keys.get(turn);
    if (!key) {
      do { key = zotero.DataObjectUtilities.generateKey(); }
      while (zotero.Items.getByLibraryAndKey(attachment.libraryID, key));
      keys.set(turn, key!);
    }
    try {
      // Do not reuse the selection's native annotation key or mutate existing highlights.
      // saveFromJSON owns its transaction and sends notifications to all open readers.
      const annotation = await zotero.Annotations.saveFromJSON(attachment, {
        key, type: "highlight", text: snapshot.text,
        comment: `Resposta da IA\n\nPergunta: ${turn.question}\n\n${turn.answer}`,
        color: "#a28ae5", pageLabel: snapshot.pageLabel || String(position.pageIndex! + 1),
        sortIndex: snapshot.sortIndex, position,
      });
      return annotation.id;
    } catch (error) {
      zotero.logError(error);
      throw error;
    }
  };
}
