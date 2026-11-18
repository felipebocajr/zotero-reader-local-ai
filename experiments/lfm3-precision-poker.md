# LFM3-1.7B F16 × Q4 — exemplo “sem poker”

Comparação pontual da qualidade do LFM3-1.7B em F16 (pesos originais) e Q4_K_M,
usando o mesmo artigo, o mesmo trecho e o mesmo prompt de produção.

## Setup

- Modelo: `lfm3-1.7b`, revisão fixada em `runtime.lock.json`.
- Pesos: `LFM3-1.7B-F16.gguf` (3,3 GiB) e `LFM3-1.7B-Q4_K_M.gguf` (1,10 GB).
- Runtime: llama.cpp `b12250`; contexto 32.768; K/V `f16`; `--jinja`;
  `--reasoning-format deepseek`; `LLAMA_ARG_THINK_BUDGET=512`.
- GPU: RTX 3070 8 GB; ambos carregados com todas as camadas na GPU
  (“GPU inteira”), sem offload para CPU.
- Prompt: `buildMessages` em modo `default`, artigo completo
  (`experiments/data/fastdllm.txt`), trecho
  “The list of poker hands that consist of two English words”,
  `responseLanguage: en`.
- Cliente: temperatura 0,1, top_k 50, repeat_penalty 1,1, seed 42,
  `cache_prompt:false`.
- Prompt real: 21.844–21.846 tokens em todos os casos.
- Uma geração por configuração. Não é um benchmark estatístico; é uma
  comparação pareada de respostas.

## Perguntas

- PT: `me de um outro exemplo sem ser sobre poker.`
- EN: `Can you give me another example that is not about poker?`

## Resultados

| Run | Palavras | Tokens gerados | t/s | Avaliação |
|---|---:|---:|---:|---|
| Q4 — PT | 307 | 944 | 159,0 | Fora do tema; foi para similaridade de KV-cache |
| F16 — PT | 104 | 658 | 93,3 | No tema, mas ainda cita poker e não mostra combinação inválida |
| Q4 — EN | 135 | 719 | 175,5 | No tema, fórmula LaTeX correta, exemplo abstrato |
| F16 — EN | 66 | 604 | 83,4 | Curto, mas “big cat/small dog” não demonstra o mecanismo |

## Respostas

### Q4 — PT (307 palavras)

In the section on masked diffusion models (MDMs) the authors illustrate how independent sampling can produce undesirable token combinations, using the example of two English words in a poker hand such as “high card” and “two pair.” To show why this matters for parallel decoding they contrast it with other word pairs. A different illustration appears earlier when they discuss high cosine similarity among KV‑cache activations: Figure 3 displays heatmaps that highlight the strong diagonal similarity of key–value (KV) activation vectors across adjacent inference steps, while showing low similarity between distant blocks. This demonstrates how caching can be safely reused without losing accuracy.

Thus another concrete example from the paper is the **high cosine‑similarity pattern among KV‑cache activations** shown in Figure 3a and Figure 3b. The heatmap (Figure 3) reveals that for each block, the activation vectors of neighboring steps have cosine similarity values ranging from about 0.84 to 0.98 near the diagonal, indicating that the cached key–value states change only slightly between consecutive decoding steps. This high similarity allows the authors’ approximate KV‑cache mechanism (block‑wise generation and DualCache) to reuse previously computed activations with negligible error.

**Key terms:**
- *Masked Diffusion Model (MDM)* – a discrete diffusion model that replaces tokens one‑by‑one with a special `[MASK]` token.
- *KV Cache* – stores past key and value vectors from previous decoding steps so the attention computation can reuse them instead of recomputing.
- *Block‑wise generation* – splits the output into blocks; before each block, the KV cache for earlier blocks is computed and stored, then after finishing a block it is refreshed for all tokens.
- *DualCache* – extends prefix caching to also store suffix (masked) tokens, further reducing redundant work.

These examples illustrate how the authors address two major bottlenecks in diffusion LLMs: lack of KV cache and quality loss when decoding multiple tokens at once.

### F16 — PT (104 palavras)

The passage you quoted mentions “high card,” “two pair,” “full house,” or “straight flush” as examples of two‑word poker hand names that can appear together in a list. To give another illustration without referring to cards, consider the phrase **“early morning”** and **“late afternoon.”** In the article’s discussion of conditional dependencies it notes that such word pairs can be correlated (e.g., “high house” was cited as an undesirable combination when two tokens are sampled independently). Here, “early morning” and “late afternoon” share a temporal relationship—one is before the other—so they exhibit a dependency similar to the poker‑hand example but for time rather than cards.

### Q4 — EN (135 palavras)

The passage you referenced mentions a **list of poker hands** (e.g., “high card,” “two pair,” “full house,” or “straight flush”). An alternative, non‑poker example from the same article appears in the discussion of conditional independence: consider two token positions \(i\) and \(j\). The article states that MDMs sample these tokens jointly as

\[
p(x_i, x_j \mid E) = p(x_i \mid E)\,p(x_j \mid E, x_i),
\]

which differs from the independent‑sampling assumption used in many parallel decoding schemes. This illustrates a dependency between token positions rather than treating them as independent draws.

Thus, instead of listing poker hands, an example of inter‑token dependence is given by the joint distribution \(p(x_i, x_j \mid E)\) for two masked tokens \(x_i\) and \(x_j\). The article notes that this discrepancy can cause quality degradation when multiple tokens are unmasked simultaneously.

### F16 — EN (66 palavras)

Sure—here’s a different pair of English words that could appear in such a list, unrelated to poker:

**“big cat” and “small dog.”**

These two word pairs illustrate how the choice of adjacent terms can create unexpected or contradictory meanings (e.g., “big cat” vs. “small dog”), which is why independent sampling of each token’s distribution can produce undesirable combinations like “high house” in the diffusion model context.

## Leitura

- F16 não melhorou a obediência à restrição negativa. Nas duas línguas ele
  continua mencionando poker e não produz uma combinação inválida de fato.
- F16 foi mais conciso e, em português, permaneceu no conceito de dependência
  entre tokens; Q4 em português saiu completamente do tema (KV-cache).
- Q4 em inglês foi a melhor resposta das quatro: ficou no tema, usou LaTeX
  correto e citou a condicional conjunta. Ainda assim, deu uma formulação
  abstrata em vez de um exemplo concreto novo.
- O problema principal não é a quantização: é a granularidade pedida
  (“outro exemplo”) e a restrição negativa. Um prompt estrutural com
  “preserve o padrão palavra × palavra, use um nome que não está no artigo,
  dê uma combinação inválida e não mencione poker” continua necessário.
- Comparações futuras devem fixar o número de camadas na GPU para medir
  throughput; aqui ambos rodaram com todas as camadas e os tempos servem
  apenas como referência.
