import { placePopup } from "./position.ts";
import { renderFormattedText } from "./markdown.ts";
import type { SessionState } from "./session.ts";

export interface PopupView {
  render(state: SessionState): void;
  question(followup: boolean): void;
  close(): void;
  element: HTMLDivElement;
}

export function createPopup(doc: Document, anchor: DOMRect, selection: string, handlers: {
  ask(question: string, followup: boolean): void; cancel(): void; closed(): void; reset(): void;
  saveAnswer(index: number): void;
}): PopupView {
  const win = doc.defaultView as Window & typeof globalThis;
  const root = doc.createElement("div");
  // The native reader recognizes selection-popup as an interactive region, preserving focus.
  root.className = "selection-popup reader-local-ai-popup";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Assistente local de leitura");
  root.setAttribute("data-reader-local-ai", "popup");
  const header = doc.createElement("header");
  const title = doc.createElement("strong"); title.textContent = "Assistente local";
  const closeButton = button("×", "reader-local-ai-close"); closeButton.setAttribute("aria-label", "Fechar");
  header.append(title, closeButton);
  const quote = doc.createElement("blockquote"); quote.textContent = selection; quote.title = selection;
  const history = doc.createElement("div"); history.className = "reader-local-ai-history";
  const status = doc.createElement("div"); status.className = "reader-local-ai-status"; status.setAttribute("role", "status");
  const error = doc.createElement("div"); error.className = "reader-local-ai-error"; error.setAttribute("role", "alert");
  const form = doc.createElement("form"); form.hidden = true;
  const label = doc.createElement("label"); label.textContent = "Sua pergunta";
  const field = doc.createElement("textarea"); field.placeholder = "O que você quer entender sobre este trecho?";
  field.setAttribute("data-tabstop", "1");
  // Zotero recognizes input[type=text] and [contenteditable=true] as text editors.
  // Preserve native textarea editing instead of reader navigation/annotation shortcuts.
  field.setAttribute("contenteditable", "true");
  field.setAttribute("aria-label", "Sua pergunta"); label.append(field);
  const send = button("Enviar", "reader-local-ai-primary"); send.type = "submit";
  form.append(label, send);
  const footer = doc.createElement("div"); footer.className = "reader-local-ai-footer";
  const more = button("Continuar perguntando"); more.hidden = true;
  const fresh = button("Nova pergunta"); fresh.hidden = true;
  const cancel = button("Cancelar"); cancel.hidden = true;
  footer.append(more, fresh, cancel);
  root.append(header, quote, history, status, error, form, footer);
  doc.body.append(root);
  let followup = false, closed = false;
  let frame = 0;

  function button(text: string, className = ""): HTMLButtonElement {
    const el = doc.createElement("button"); el.type = "button"; el.textContent = text;
    el.className = className; el.setAttribute("data-tabstop", "1"); return el;
  }
  function position(): void {
    frame = 0;
    if (closed) return;
    const bounds = root.getBoundingClientRect();
    const point = placePopup(anchor, bounds.width, bounds.height, { width: win.innerWidth, height: win.innerHeight });
    root.style.left = point.left + "px"; root.style.top = point.top + "px";
  }
  function reposition(): void { if (!closed && !frame) frame = win.requestAnimationFrame(position); }
  const resized = new win.ResizeObserver(reposition); resized.observe(root);
  win.addEventListener("resize", reposition);
  function question(isFollowup: boolean): void {
    followup = isFollowup; form.hidden = false; more.hidden = true;
    field.value = ""; field.placeholder = isFollowup ? "Pergunte sobre a resposta…" : "O que você quer entender sobre este trecho?";
    field.focus(); reposition();
  }
  function close(): void {
    if (closed) return;
    closed = true; handlers.closed(); resized.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", reposition); win.removeEventListener("pagehide", close);
    doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", escape, true);
    root.remove();
  }
  function outside(event: Event): void { if (!root.contains(event.target as Node)) close(); }
  function escape(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
  }
  root.addEventListener("pointerdown", event => event.stopPropagation());
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape") event.stopPropagation();
  });
  field.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener("submit", event => { event.preventDefault(); handlers.ask(field.value, followup); });
  closeButton.addEventListener("click", close); cancel.addEventListener("click", handlers.cancel);
  more.addEventListener("click", () => question(true));
  fresh.addEventListener("click", () => { handlers.reset(); question(false); });
  doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", escape, true);
  win.addEventListener("pagehide", close);
  position();

  return {
    element: root, close, question,
    render(state) {
      if (closed) return;
      const busy = ["extracting", "preparing", "generating"].includes(state.phase);
      send.disabled = busy; field.disabled = busy; cancel.hidden = !busy;
      fresh.hidden = busy || !state.history.length;
      more.hidden = busy || !state.history.length || (!form.hidden && followup);
      if (busy || state.phase === "complete") form.hidden = true;
      if (state.phase === "error") { form.hidden = false; field.value = state.question || field.value; }
      status.textContent = { idle: "", extracting: "Lendo o artigo completo…", preparing: "Conferindo o contexto…", generating: state.draft ? "Respondendo…" : "Preparando a explicação…", complete: "", error: "" }[state.phase];
      status.hidden = !status.textContent; error.textContent = state.error; error.hidden = !state.error;
      history.replaceChildren();
      const turns = [...state.history];
      if (state.draft) turns.push({ question: state.question, answer: state.draft });
      for (const [index, turn] of turns.entries()) {
        const container = doc.createElement("div"); container.className = "reader-local-ai-turn";
        const q = doc.createElement("div"); q.className = "reader-local-ai-question"; q.textContent = turn.question;
        const a = doc.createElement("div"); a.className = "reader-local-ai-answer"; renderFormattedText(a, turn.answer);
        container.append(q, a);
        if (index < state.history.length) {
          const saved = state.answerSaves[index];
          const save = button(saved?.phase === "saved" ? "Salvo nas anotações" : saved?.phase === "saving" ? "Salvando…" : "Salvar nas anotações", "reader-local-ai-save-answer");
          save.disabled = saved?.phase === "saving" || saved?.phase === "saved";
          save.addEventListener("click", () => handlers.saveAnswer(index));
          // Reader shortcuts can suppress a button's default keyboard activation.
          save.addEventListener("keydown", event => {
            if ((event.key === "Enter" || event.key === " ") && !event.isComposing) {
              event.preventDefault(); event.stopPropagation();
              if (!save.disabled) handlers.saveAnswer(index);
            }
          });
          container.append(save);
          if (saved?.error) {
            const message = doc.createElement("div"); message.className = "reader-local-ai-save-error reader-local-ai-error";
            message.setAttribute("role", "alert"); message.textContent = saved.error; container.append(message);
          }
        }
        history.append(container);
      }
      history.scrollTop = history.scrollHeight;
      reposition();
    },
  };
}
