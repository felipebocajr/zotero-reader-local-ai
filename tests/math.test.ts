import test from "node:test";
import assert from "node:assert/strict";
import { mathMarkup, splitMath } from "../src/math.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";

test("conditional probability formula keeps subscripts and product limits", () => {
  const formula = String.raw`\[q_{t\mid 0}(x_t\mid x_0)=\prod_{i=1}^{n}q_{t\mid 0}(\xi_t^{(i)}\mid\xi_0^{(i)})\]`;
  const rendered = mathMarkup(formula);
  assert.equal(rendered.formulas, 1);
  assert.match(rendered.html, /<msub>/); assert.match(rendered.html, /<munderover>/);
  assert.match(rendered.html, /<msubsup>/); assert.match(rendered.html, /display="block"/);
  assert.match(rendered.html, /<annotation encoding="application\/x-tex">/);
  assert.equal(splitMath(formula).map(part => part.source).join(""), formula);
});
test("inline and display delimiters render fractions, roots and multiline expressions", () => {
  const text = String.raw`Texto \(x_t^2\), $\sqrt{d_k}$ e $$\frac{a}{b}$$. \[\begin{aligned}a&=b\\c&=d\end{aligned}\]`;
  const result = mathMarkup(text);
  assert.equal(result.formulas, 4);
  assert.match(result.html, /<mfrac>/); assert.match(result.html, /<msqrt>/); assert.match(result.html, /<mtable(?:\s|>)/);
  assert.equal(splitMath(text).map(part => part.source).join(""), text);
});
test("currency, escaped dollars and code remain literal", () => {
  const text = String.raw`Custou $5 e $10; \$20. Código: ` + "`$x_t$` e ```latex\n\\[x^2\\]\n```; " + String.raw`\(y_t\).`;
  const result = mathMarkup(text);
  assert.equal(result.formulas, 1);
  assert.ok(result.html.includes("Custou $5 e $10")); assert.ok(result.html.includes("`$x_t$`"));
  assert.equal(mathMarkup(String.raw`Custa $10; defina \(x_0\).`).formulas, 1);
});
test("double-escaped model delimiters decode only their formula for display", () => {
  const text = String.raw`Literal C:\\dados; \\(Q\\) e \\[\\frac{QK^T}{\\sqrt{d_k}}\\].`;
  const result = mathMarkup(text);
  assert.equal(result.formulas, 2); assert.match(result.html, /<mfrac>/); assert.match(result.html, /<msqrt>/);
  assert.ok(result.html.includes(String.raw`C:\\dados`));
  assert.equal(splitMath(text).map(part=>part.source).join(""), text);
  const aligned = String.raw`\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]`;
  assert.match(mathMarkup(aligned).html, /<mtable(?:\s|>)/);
});
test("incomplete streaming prefixes and invalid LaTeX remain readable", () => {
  const formula = String.raw`Antes \[\frac{x_t}{\sqrt{d_k}}\] depois`;
  for (let end = 0; end <= formula.length; end++) {
    const prefix = formula.slice(0, end);
    assert.equal(splitMath(prefix).map(part => part.source).join(""), prefix);
  }
  for (const text of [String.raw`\[\frac{a}{\]`, String.raw`\(\undefinedcommand{x}\)`, String.raw`\[x_t`]) {
    const result = mathMarkup(text); assert.equal(result.formulas, 0); assert.equal(result.html, text);
  }
});
test("model prose and unsafe LaTeX cannot insert HTML or external resources", () => {
  const text = String.raw`<img src="https://example.com" onerror="bad()"> & <script>bad()</script> \(\href{javascript:bad()}{x}\) \(\includegraphics{https://example.com/a.png}\)`;
  const result = mathMarkup(text);
  assert.match(result.html, /&lt;img/); assert.match(result.html, /&lt;script/);
  assert.doesNotMatch(result.html, /<(?:img|script|iframe|a|mglyph)(?:\s|>)/);
  assert.doesNotMatch(result.html, /(?:href|src)="(?:https?:|javascript:)/);
});
test("recursive macros are bounded and cannot affect another expression", () => {
  const result = mathMarkup(String.raw`\(\def\loop{\loop}\loop\) e \(x_t\)`);
  assert.equal(result.formulas, 1); assert.ok(result.html.includes(String.raw`\def\loop`));
  assert.ok(SYSTEM_PROMPT.includes(String.raw`\( ... \)`));
  assert.ok(SYSTEM_PROMPT.includes(String.raw`\[ ... \]`));
});
