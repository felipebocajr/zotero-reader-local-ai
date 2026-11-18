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
  ask(question: string, followup: boolean): void; explainDetail(): void; cancel(): void; closed(): void; reset(): void;
  saveAnswer(index: number): void;
}): PopupView {
  const win = doc.defaultView as Window & typeof globalThis;
  const root = doc.createElement("div");
  // The native reader recognizes selection-popup as an interactive region, preserving focus.
  root.className = "selection-popup reader-local-ai-popup";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Assistente local de leitura");
  root.setAttribute("data-reader-local-ai", "popup");
  const header = doc.createElement("header");
  header.title = "Arraste para mover o popup";
  const title = doc.createElement("strong"); title.textContent = "Assistente local";
  const expand = button("Expandir", "reader-local-ai-expand");
  expand.title = "Aumentar o popup"; expand.setAttribute("aria-label", expand.title); expand.setAttribute("aria-pressed", "false");
  const closeButton = button("×", "reader-local-ai-close"); closeButton.setAttribute("aria-label", "Fechar");
  const headerActions = doc.createElement("div"); headerActions.className = "reader-local-ai-header-actions";
  headerActions.append(expand, closeButton);
  header.append(title, headerActions);
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
  const resize = doc.createElement("div"); resize.className = "reader-local-ai-resize";
  resize.title = "Arraste para redimensionar"; resize.setAttribute("aria-hidden", "true");
  root.append(header, quote, history, status, error, form, footer, resize);
  doc.body.append(root);
  let followup = false, closed = false;
  let frame = 0;
  let expanded = false;
  let manual = false;
  let resizing: { pointerId: number; startX: number; startY: number; width: number; height: number; left: number; top: number } | null = null;
  let moving: { pointerId: number; startX: number; startY: number; left: number; top: number } | null = null;

  function button(text: string, className = ""): HTMLButtonElement {
    const el = doc.createElement("button"); el.type = "button"; el.textContent = text;
    el.className = className; el.setAttribute("data-tabstop", "1"); return el;
  }
  function position(): void {
    if (closed) return;
    const bounds = root.getBoundingClientRect();
    const point = placePopup(anchor, bounds.width, bounds.height, { width: win.innerWidth, height: win.innerHeight });
    root.style.left = point.left + "px"; root.style.top = point.top + "px";
  }
  function clampPosition(): void {
    if (closed) return;
    const bounds = root.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(bounds.left, win.innerWidth - bounds.width - margin));
    const top = Math.max(margin, Math.min(bounds.top, win.innerHeight - bounds.height - margin));
    root.style.left = `${left}px`; root.style.top = `${top}px`;
  }
  function clampManual(): void {
    if (closed) return;
    const bounds = root.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(bounds.width, win.innerWidth - margin);
    const height = Math.min(bounds.height, win.innerHeight - margin);
    const left = Math.max(margin, Math.min(bounds.left, win.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(bounds.top, win.innerHeight - height - margin));
    root.style.width = `${width}px`; root.style.height = `${height}px`;
    root.style.left = `${left}px`; root.style.top = `${top}px`;
  }
  function reposition(): void {
    if (closed || frame || resizing || moving) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (closed || resizing || moving) return;
      if (manual) clampManual(); else position();
    });
  }
  function placeNow(): void {
    if (closed) return;
    if (manual) clampManual(); else position();
  }
  function setExpanded(value: boolean): void {
    expanded = value;
    root.classList.toggle("reader-local-ai-expanded", expanded);
    expand.textContent = expanded ? "Restaurar" : "Expandir";
    expand.title = expanded ? "Restaurar tamanho" : "Aumentar o popup";
    expand.setAttribute("aria-label", expand.title);
    expand.setAttribute("aria-pressed", String(expanded));
  }
  function toggleExpanded(): void {
    root.style.width = ""; root.style.height = ""; root.style.maxWidth = ""; root.style.maxHeight = "";
    setExpanded(!expanded);
    if (manual) clampPosition(); else position();
  }
  function startMove(event: PointerEvent): void {
    if (event.button !== 0 || moving || resizing) return;
    const target = event.target as Element | null;
    if (target?.closest("button")) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = root.getBoundingClientRect();
    manual = true;
    moving = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top };
    try { header.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer or unsupported capture. */ }
    win.addEventListener("pointermove", moveMove);
    win.addEventListener("pointerup", endMove);
    win.addEventListener("pointercancel", endMove);
  }
  function moveMove(event: PointerEvent): void {
    if (!moving || event.pointerId !== moving.pointerId) return;
    event.preventDefault();
    const margin = 12;
    const bounds = root.getBoundingClientRect();
    const maxLeft = Math.max(margin, win.innerWidth - bounds.width - margin);
    const maxTop = Math.max(margin, win.innerHeight - bounds.height - margin);
    const left = Math.min(maxLeft, Math.max(margin, moving.left + event.clientX - moving.startX));
    const top = Math.min(maxTop, Math.max(margin, moving.top + event.clientY - moving.startY));
    root.style.left = `${left}px`; root.style.top = `${top}px`;
  }
  function endMove(event: PointerEvent): void {
    if (!moving || (event.pointerId !== undefined && event.pointerId !== moving.pointerId)) return;
    moving = null;
    win.removeEventListener("pointermove", moveMove);
    win.removeEventListener("pointerup", endMove);
    win.removeEventListener("pointercancel", endMove);
    clampPosition();
  }
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || resizing) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = root.getBoundingClientRect();
    root.style.maxWidth = `${win.innerWidth - 12}px`;
    root.style.maxHeight = `${win.innerHeight - 12}px`;
    if (expanded) {
      root.style.width = `${bounds.width}px`;
      root.style.height = `${bounds.height}px`;
      setExpanded(false);
    }
    manual = true;
    resizing = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top };
    try { resize.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer or unsupported capture. */ }
    win.addEventListener("pointermove", moveResize);
    win.addEventListener("pointerup", endResize);
    win.addEventListener("pointercancel", endResize);
  }
  function moveResize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== resizing.pointerId) return;
    event.preventDefault();
    const margin = 12;
    const maxWidth = Math.max(240, win.innerWidth - resizing.left - margin);
    const maxHeight = Math.max(200, win.innerHeight - resizing.top - margin);
    const width = Math.min(maxWidth, Math.max(320, resizing.width + event.clientX - resizing.startX));
    const height = Math.min(maxHeight, Math.max(240, resizing.height + event.clientY - resizing.startY));
    root.style.width = `${width}px`; root.style.height = `${height}px`;
    root.style.maxWidth = `${win.innerWidth - margin}px`; root.style.maxHeight = `${win.innerHeight - margin}px`;
  }
  function endResize(event: PointerEvent): void {
    if (!resizing || (event.pointerId !== undefined && event.pointerId !== resizing.pointerId)) return;
    resizing = null;
    win.removeEventListener("pointermove", moveResize);
    win.removeEventListener("pointerup", endResize);
    win.removeEventListener("pointercancel", endResize);
    reposition();
  }
  const resized = new win.ResizeObserver(reposition); resized.observe(root);
  win.addEventListener("resize", reposition);
  function question(isFollowup: boolean): void {
    followup = isFollowup; form.hidden = false; more.hidden = true;
    field.value = ""; field.placeholder = isFollowup ? "Pergunte sobre a resposta…" : "O que você quer entender sobre este trecho?";
    field.focus(); placeNow(); reposition();
  }
  function close(): void {
    if (closed) return;
    closed = true; handlers.closed(); resized.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    if (resizing) {
      resizing = null;
      win.removeEventListener("pointermove", moveResize);
      win.removeEventListener("pointerup", endResize);
      win.removeEventListener("pointercancel", endResize);
    }
    if (moving) {
      moving = null;
      win.removeEventListener("pointermove", moveMove);
      win.removeEventListener("pointerup", endMove);
      win.removeEventListener("pointercancel", endMove);
    }
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
  header.addEventListener("pointerdown", startMove);
  resize.addEventListener("pointerdown", startResize);
  expand.addEventListener("click", toggleExpanded);
  expand.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); toggleExpanded();
    }
  });
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
          if (state.showDetail && index === state.history.length - 1) {
            const detail = button("Explicar com mais detalhes", "reader-local-ai-detail");
            const activate = () => { if (!detail.disabled) handlers.explainDetail(); };
            detail.addEventListener("click", activate);
            // Reader shortcuts can suppress a button's default keyboard activation.
            detail.addEventListener("keydown", event => {
              if ((event.key === "Enter" || event.key === " ") && !event.isComposing) {
                event.preventDefault(); event.stopPropagation(); activate();
              }
            });
            container.append(detail);
          }
          if (saved?.error) {
            const message = doc.createElement("div"); message.className = "reader-local-ai-save-error reader-local-ai-error";
            message.setAttribute("role", "alert"); message.textContent = saved.error; container.append(message);
          }
        }
        history.append(container);
      }
      history.scrollTop = history.scrollHeight;
      if (!busy) placeNow();
      reposition();
    },
  };
}
