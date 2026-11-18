# Splitter recursivo em artigos reais do Zotero

Data: 2026-11-18

## Objetivo

Validar, antes de integrar o RAG, se o splitter recursivo funciona no texto que o
Zotero realmente entrega ao plugin, e não apenas em texto sintético. A validação
verifica tamanho, cobertura, fronteiras naturais, headings e vazamento entre
seções.

## Método

- Texto real: `Zotero.PDFWorker.getFullText(attachmentID, null)` no perfil
  isolado `.runtime/zotero-profile`, com a biblioteca isolada.
- Artigos extraídos: Attention, RMSNorm, RoPE, LoRA e LLaDA (5 PDFs, 85 páginas,
  259.624 caracteres).
- Corpus auxiliar: os 7 arquivos `experiments/data/*.txt`, extraídos com
  `pdftotext`, incluindo Fast-dLLM e FlashAttention-4.
- Splitter: `src/chunking.ts`, `chunkSize=1200`, `chunkOverlap=160`.
- Evidência: `experiments/results/splitter-validation.json`.
- Reprodução:
  - `node --experimental-strip-types scripts/splitter_validate.ts`
  - `node --experimental-strip-types scripts/splitter_inspect.ts .runtime/zotero-splitter-corpus`
  - `scripts/zotero-splitter-corpus.js` apenas no perfil isolado.

## Resultado no texto real do Zotero

| Artigo | Páginas | Chars | Chunks | Max core | Max prompt | Parágrafo / frase / linha | Word / char | Headings |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Attention | 15 | 36.990 | 45 | 1.199 | 1.323 | 10 / 32 / 2 | 0 / 0 | 24 |
| LLaDA | 24 | 85.883 | 89 | 1.199 | 1.356 | 2 / 85 / 1 | 0 / 0 | 15 |
| LoRA | 20 | 59.938 | 64 | 1.191 | 1.349 | 11 / 51 / 1 | 0 / 0 | 16 |
| RMSNorm | 14 | 46.410 | 51 | 1.197 | 1.355 | 6 / 42 / 2 | 0 / 0 | 14 |
| RoPE | 12 | 30.403 | 35 | 1.181 | 1.305 | 3 / 26 / 5 | 0 / 0 | 18 |
| **Total** | **85** | **259.624** | **284** | **1.199** | **1.356** | **32 / 236 / 11** | **0 / 0** | **87** |

Todos os 284 chunks:

- têm no máximo 1.200 caracteres de conteúdo principal;
- têm no máximo 1.360 caracteres com o overlap;
- preservam todo o texto não-branco;
- terminam em parágrafo, frase ou linha;
- nenhum terminou no meio de uma palavra ou de um caractere;
- nenhum atravessa um heading detectado.

No corpus `pdftotext` (7 artigos, 394.474 caracteres, 420 chunks), o resultado é
o mesmo: 100% de fronteiras naturais e zero chunks cortados no meio de palavra.

## O que o teste revelou

### 1. A ordem original cortava frases em PDFs

A ordem citada era `["\n\n", "\n", ". ", " ", ""]` (parágrafo, linha, frase,
palavra, caractere). Em texto de PDF, a extração insere quebras de linha fixas a
cada ~80 caracteres. Com `\n` antes de `. `, o splitter tratava essas quebras
como fronteiras semânticas.

Na primeira execução com Fast-dLLM, **72 de 77 chunks** terminaram em quebra de
linha, e alguns cortavam a frase no meio:

```text
... for all input and output positions. In these models, the n
block, computing hidden representations in parallel ...
```

A ordem foi ajustada para:

```text
["\n\n", ". ", ".\n", "\n", " ", ""]
```

Assim, parágrafos continuam sendo a primeira fronteira, mas frases vêm antes de
quebras de linha. Com o ajuste, o mesmo Fast-dLLM passou a terminar 64 de 70
chunks em frases (antes da separação por seções). Linha, palavra e caractere
continuam como fallback para tabelas, equações e texto sem pontuação.

### 2. Headings precisam ser fronteiras forçadas

Sem separar seções, um chunk podia terminar dentro da seção seguinte e receber o
heading errado. O splitter agora detecta headings e trata cada seção como um
segmento independente. Um chunk nunca atravessa um heading.

O Zotero às vezes cola o número ao título. O LoRA, por exemplo, entrega
`5.1Baselines` e `6.1Which Weight Matrices...`, não `5.1. Baselines`. O detector
aceita os dois formatos.

### 3. O Zotero insere form feeds entre páginas

A extração real usa `\f` entre páginas (14 no Attention). O splitter normaliza
`\f` para quebra de linha; nenhum chunk contém form feed. Não é tratado como
parágrafo porque, em vários artigos, a frase continua na página seguinte.

### 4. Cabeçalhos e números de página continuam no texto

O texto do PDF inclui títulos correntes, números de página e, no LLaDA, ligaduras
corrompidas. O splitter não remove esses trechos, porque isso seria descartar
conteúdo. Eles podem aparecer em chunks e serão tratados depois na recuperação.

## Caracteres, tokens e o que "preserva o parágrafo" significa

`1.200` é o **tamanho máximo do conteúdo principal em caracteres**, não em
tokens. Em inglês e português, a estimativa conservadora é 3,5 caracteres por
token:

- 1.200 caracteres ≈ 343 tokens;
- com 160 caracteres de overlap, o chunk pode chegar a 1.360 caracteres ≈ 389
  tokens.

O splitter não corta todo parágrafo em 1.200 caracteres. Ele tenta, nesta ordem:

1. **Parágrafo** (`\n\n`): se o parágrafo inteiro couber, fica inteiro; dois
   parágrafos curtos podem ser unidos se a soma couber.
2. **Frase** (`. ` ou `.\n`): se o parágrafo for maior que 1.200, ele é dividido
   em frases completas.
3. **Linha** (`\n`): usado quando não há frase pontuada, como tabelas e
   equações.
4. **Palavra** (` `): usado quando uma única frase é maior que 1.200.
5. **Caractere** (`""`): último recurso, para um token contínuo maior que 1.200
   (por exemplo, uma URL ou base64).

Exemplo real do Attention, seção `4 Why Self-Attention`:

```text
chunk 18 termina: "... One is the total computational complexity per layer."
chunk 19 começa:  "Another is the amount of computation that can be parallelized ..."
```

O parágrafo era maior que 1.200 caracteres e foi dividido entre duas frases
completas, não no caractere 1.200.

Exemplo de parágrafos curtos unidos: o chunk 18 do Attention contém o heading
`4 Why Self-Attention`, o parágrafo de abertura e a legenda da Tabela 1, porque
a soma coube no orçamento.

## Limitações

- A detecção de headings é heurística. Linhas de afiliação, equações numeradas e
  notas de rodapé chegaram a ser classificadas como heading na primeira versão;
  filtros para múltiplos números, símbolos matemáticos e números colados a
  minúsculas removeram esses casos nos 12 arquivos testados. O risco não é zero
  em artigos com formatação atípica; uma fronteira extra não perde texto nem
  corta palavras.
- O texto do PDF pode interromper uma frase com cabeçalho de página, número de
  página ou legenda. O splitter não consegue reconstruir a leitura humana.
- Fast-dLLM e FlashAttention-4 não têm PDF no corpus local; foram validados
  apenas pelo texto `pdftotext`, não pelo `PDFWorker` do Zotero.
- O LLaDA tem ligaduras corrompidas na extração; o splitter as preserva.

## Próximo passo

Com o splitter validado, o RAG pode ser integrado como padrão para **todos** os
provedores. No local, o orçamento de recuperação será maior que no Groq; o modo
"Artigo completo" continuará disponível como opção explícita. (Removido da interface na 0.2.15; o caminho interno permanece apenas no benchmark de precisão.)
