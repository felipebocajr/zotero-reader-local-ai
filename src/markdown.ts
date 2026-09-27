import MarkdownIt from "markdown-it";
import { escapeHTML, mathMarkup, splitMath } from "./math.ts";

// Model prose is untrusted. Markdown-it escapes raw HTML; images and links are
// rendered as text so a response cannot load a remote resource or open a URL.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.renderer.rules.image = (tokens, index) => escapeHTML(tokens[index].content);
markdown.renderer.rules.link_open = () => "";
markdown.renderer.rules.link_close = () => "";

// Parse TeX before Markdown escapes backslashes or interprets underscores and
// asterisks inside a formula. Code spans/fences are handled by Markdown-it.
markdown.inline.ruler.before("escape", "reader_local_ai_math", (state, silent) => {
  const first = state.src[state.pos];
  if (first !== "\\" && first !== "$") return false;
  const part = splitMath(state.src.slice(state.pos, state.posMax))[0];
  if (part?.kind === "math") {
    if (!silent) state.push("reader_local_ai_math", "span", 0).content = part.source;
    state.pos += part.source.length;
    return true;
  }
  // Keep an unfinished delimiter visible as the answer streams in.
  const opener = ["\\\\(", "\\\\[", "\\(", "\\["].find(value => state.src.startsWith(value, state.pos));
  if (!opener) return false;
  if (!silent) state.push("text", "", 0).content = opener;
  state.pos += opener.length;
  return true;
});
markdown.renderer.rules.reader_local_ai_math = (tokens, index) => mathMarkup(tokens[index].content).html;

export function markdownMarkup(source: string): string { return markdown.render(source); }

export function renderFormattedText(element: HTMLElement, source: string): void {
  element.dataset.readerLocalAiSource = source;
  element.innerHTML = markdownMarkup(source);
}
