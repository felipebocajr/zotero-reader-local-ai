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
        entry.preview.remove(); comment.classList.remove("reader-local-ai-math-comment"); entries.delete(comment);
      }
    }
    for (const content of doc.querySelectorAll<HTMLElement>(".comment .editor > .content")) {
      const comment = content.closest<HTMLElement>(".comment")!;
      const source = content.innerText;
      const old = entries.get(comment);
      if (old?.source === source) continue;
      if (!source.startsWith("Resposta da IA\n")) {
        old?.preview.remove(); entries.delete(comment); comment.classList.remove("reader-local-ai-math-comment"); continue;
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
  const schedule = () => { if (!stopped && !frame) frame = win.requestAnimationFrame(scan); };
  const observer = new win.MutationObserver(schedule);
  // DOM dictionaries must belong to the reader's compartment in privileged Gecko.
  const options = new win.Object() as MutationObserverInit;
  options.subtree = true; options.childList = true; options.characterData = true;
  observer.observe(doc.body, options);
  schedule();
  return () => {
    stopped = true; observer.disconnect(); if (frame) win.cancelAnimationFrame(frame);
    for (const [comment, entry] of entries) { entry.preview.remove(); comment.classList.remove("reader-local-ai-math-comment"); }
    entries.clear();
  };
}
