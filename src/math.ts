import katex from "katex";

export type MathSegment = { kind: "text"; source: string } | { kind: "math"; source: string; tex: string; display: boolean };
const delimiters = [
  { open: "\\\\[", close: "\\\\]", display: true, decode: true },
  { open: "\\\\(", close: "\\\\)", display: false, decode: true },
  { open: "$$", close: "$$", display: true }, { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false }, { open: "$", close: "$", display: false },
];
const escaped = (text: string, index: number) => {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
};

// Keep prose, code, unmatched delimiters and the original TeX untouched.
export function splitMath(text: string): MathSegment[] {
  const parts: MathSegment[] = [];
  let plain = 0, index = 0;
  while (index < text.length) {
    if (text[index] === "`" && !escaped(text, index)) {
      const ticks = text.slice(index).match(/^`+/)![0];
      const end = text.indexOf(ticks, index + ticks.length);
      index = end < 0 ? text.length : end + ticks.length; continue;
    }
    const delimiter = !escaped(text, index) && delimiters.find(d => text.startsWith(d.open, index));
    if (!delimiter) { index++; continue; }
    const start = index + delimiter.open.length;
    let end = text.indexOf(delimiter.close, start);
    while (end >= 0 && escaped(text, end)) end = text.indexOf(delimiter.close, end + delimiter.close.length);
    if (end < 0) { index = delimiter.open === "$" ? index + 1 : text.length; continue; }
    const rawTex = text.slice(start, end);
    const tex = "decode" in delimiter ? rawTex.replaceAll("\\\\", "\\") : rawTex;
    if (!tex.trim() || (delimiter.open === "$" && (/^\s|\s$|\n|`/.test(tex) || /\d/.test(text[end + 1] ?? "")))) {
      index++; continue;
    }
    if (index > plain) parts.push({ kind: "text", source: text.slice(plain, index) });
    const source = text.slice(index, end + delimiter.close.length);
    parts.push({ kind: "math", source, tex, display: delimiter.display });
    plain = index = end + delimiter.close.length;
  }
  if (plain < text.length) parts.push({ kind: "text", source: text.slice(plain) });
  return parts;
}

export const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export function mathMarkup(text: string): { html: string; formulas: number } {
  let formulas = 0;
  const html = splitMath(text).map(part => {
    if (part.kind === "text") return escapeHTML(part.source);
    try {
      if (part.tex.length > 20000) throw new Error("Expression too long");
      // Gecko renders MathML natively: no remote assets, CSS or web fonts.
      const math = katex.renderToString(part.tex, { output: "mathml", displayMode: part.display,
        throwOnError: true, trust: false, strict: "ignore", maxExpand: 500, maxSize: 10, macros: {} });
      formulas++;
      return `<span class="reader-local-ai-math${part.display ? " reader-local-ai-math-block" : ""}">${math}</span>`;
    } catch {
      return escapeHTML(part.source);
    }
  }).join("");
  return { html, formulas };
}

export function renderMathText(element: HTMLElement, text: string): void {
  element.dataset.readerLocalAiSource = text;
  element.innerHTML = mathMarkup(text).html;
}
