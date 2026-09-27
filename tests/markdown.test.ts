import test from "node:test";
import assert from "node:assert/strict";
import { markdownMarkup } from "../src/markdown.ts";

test("model Markdown renders headings, emphasis, lists, tables and code", () => {
  const html = markdownMarkup("## Resultado\n\nO artigo usa **atenção** e *contexto*.\n\n- Um ponto\n- Outro ponto\n\n| Método | Valor |\n| --- | --- |\n| Q4 | 8 |\n\n`**literal**`");
  assert.match(html, /<h2>Resultado<\/h2>/);
  assert.match(html, /<strong>atenção<\/strong>/);
  assert.match(html, /<em>contexto<\/em>/);
  assert.match(html, /<ul>[\s\S]*<li>Um ponto<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<table>[\s\S]*<td>Q4<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.doesNotMatch(html, /## Resultado|\*\*atenção\*\*/);
});

test("Markdown and LaTeX render together without changing formula syntax", () => {
  const html = markdownMarkup(String.raw`## Fórmula

**Escala:** \(\frac{QK^{\mathsf T}}{\sqrt{d_k}}\). Também \\[q_{t\mid 0}=\prod_{i=1}^{n}x_i\\].`);
  assert.match(html, /<h2>Fórmula<\/h2>/);
  assert.match(html, /<strong>Escala:<\/strong>/);
  assert.match(html, /<mfrac>/); assert.match(html, /<msqrt>/); assert.match(html, /<munderover>/);
  assert.match(html, /<msub>/); assert.match(html, /display="block"/);
  assert.doesNotMatch(html, /\\\\\[|\\\(/);
});

test("streaming prefixes, code and invalid formulas remain readable", () => {
  const source = String.raw`## Fórmula

**Texto** \[\frac{x_t}{\sqrt{d_k}}\]`;
  for (let end = 0; end <= source.length; end++) {
    const html = markdownMarkup(source.slice(0, end));
    assert.ok(html.length > 0 || end === 0);
    assert.doesNotMatch(html, /<script|<img|<iframe/);
  }
  assert.match(markdownMarkup(String.raw`Incompleta: \[x_t`), /\\\[x_t/);
  assert.match(markdownMarkup(String.raw`Incorreta: \[\frac{a}{\]`), /\\\[\\frac\{a\}\{\\\]/);
  const code = markdownMarkup("`\\(x_t\\)`\n\n```tex\n\\[x_t\\]\n```");
  assert.doesNotMatch(code, /<math/);
  assert.match(code, /<code>\\\(x_t\\\)<\/code>/);
});

test("untrusted Markdown cannot inject HTML or load remote images", () => {
  const html = markdownMarkup('**Seguro** <script>alert(1)</script> <img src="https://example.com/a.png" onerror="bad()">\n\n![Figura](https://example.com/a.png) [Clique](javascript:alert(1)) [Fonte](https://example.com)');
  assert.match(html, /<strong>Seguro<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Figura/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)(?:\s|>)/i);
  assert.doesNotMatch(html, /<[^>]+\s(?:src|href|onerror)=/i);
});
