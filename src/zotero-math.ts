import { markdownMarkup } from "./markdown.ts";

// Keep generated markup outside the native editor and the saved comment.
export function installAnnotationMath(doc: Document): () => void {
  const win = doc.defaultView as Window & typeof globalThis;
  const entries = new Map<HTMLElement, { preview: HTMLElement; source: string }>();
  let frame = 0, stopped = false;
  function scan(): void {
    frame = 0;
    if (stopped) return;
    for (const [comment, entry] of entries) {
      if (!comment.isConnected || !entry.preview.isConnected) {
        entry.preview.remove(); comment.classList.remove("reader-local-ai-math-comment", "reader-local-ai-editing"); entries.delete(comment);
      }
    }
    for (const content of doc.querySelectorAll<HTMLElement>(".comment .editor > .content")) {
      const comment = content.closest<HTMLElement>(".comment")!;
      const source = content.innerText;
      const old = entries.get(comment);
      if (old?.source === source) continue;
      // Keep legacy single-answer annotations readable after the transcript change.
      if (!source.startsWith("Conversa da IA\n") && !source.startsWith("Resposta da IA\n")) {
        old?.preview.remove(); entries.delete(comment);
        comment.classList.remove("reader-local-ai-math-comment", "reader-local-ai-editing"); continue;
      }
      const preview = old?.preview ?? doc.createElement("div");
      preview.className = "reader-local-ai-annotation-math";
      preview.setAttribute("data-reader-local-ai", "annotation-math");
      preview.dataset.readerLocalAiSource = source;
      preview.innerHTML = markdownMarkup(source);
      if (!old) comment.append(preview);
      comment.classList.add("reader-local-ai-math-comment");
      entries.set(comment, { preview, source });
    }
  }
  // :focus-within can fail while the Zotero window itself is unfocused.
  // Track the native editor explicitly so focusing it always reveals the source.
  const editing = (event: Event): HTMLElement | null =>
    (event.target as Element | null)?.closest?.(".reader-local-ai-math-comment") ?? null;
  const focusIn = (event: Event) => editing(event)?.classList.add("reader-local-ai-editing");
  const focusOut = (event: Event) => {
    const comment = editing(event);
    if (!comment) return;
    const next = (event as FocusEvent).relatedTarget as Element | null;
    if (!next || !comment.contains(next)) comment.classList.remove("reader-local-ai-editing");
  };
  // Zotero opens the editor on a comment click; mirror that even when the
  // window is not focused, because :focus-within does not apply then.
  const click = (event: Event) => editing(event)?.classList.add("reader-local-ai-editing");
  const input = () => schedule();
  doc.addEventListener("focusin", focusIn, true);
  doc.addEventListener("focusout", focusOut, true);
  doc.addEventListener("click", click, true);
  doc.addEventListener("input", input, true);
  const schedule = () => { if (!stopped && !frame) frame = win.requestAnimationFrame(scan); };
  const observer = new win.MutationObserver(schedule);
  // DOM dictionaries must belong to the reader's compartment in privileged Gecko.
  const options = new win.Object() as MutationObserverInit;
  options.subtree = true; options.childList = true; options.characterData = true;
  observer.observe(doc.body, options);
  schedule();
  return () => {
    stopped = true; observer.disconnect(); if (frame) win.cancelAnimationFrame(frame);
    doc.removeEventListener("focusin", focusIn, true);
    doc.removeEventListener("focusout", focusOut, true);
    doc.removeEventListener("click", click, true);
    doc.removeEventListener("input", input, true);
    for (const [comment, entry] of entries) {
      entry.preview.remove(); comment.classList.remove("reader-local-ai-math-comment", "reader-local-ai-editing");
    }
    entries.clear();
  };
}
