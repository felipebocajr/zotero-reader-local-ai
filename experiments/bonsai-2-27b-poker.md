# Ternary Bonsai 2 27B — exemplo “sem poker”

Teste pontual do `prism-ml/Ternary-Bonsai-2-27B-gguf` no packing **PTQ1_0**
(ternário, 1,75 bits/peso, 5,95 GB) com o mesmo artigo, trecho e pergunta usados
na comparação LFM3 F16 × Q4.

## Setup

- Pesos: `Ternary-Bonsai-2-27B-PTQ1_0.gguf`, SHA-256
  `53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3`
  (confere com o LFS do repositório).
- Runtime: build da PrismML `prism-b12128-d7b2896` (CUDA 12.8), necessário
  porque `PTQ1_0` não carrega no llama.cpp padrão. O runtime de produção
  continua no `b12250`; este build foi usado só no experimento.
- Contexto 32.768; K/V `f16`; `--jinja`; `--reasoning-format deepseek`;
  `--reasoning-effort medium`; `--reasoning-budget 3072`; `--flash-attn on`.
- GPU RTX 3070 8 GB: auto-fit, aproximadamente 7,3 GB de VRAM em uso durante
  a inferência, com o restante na CPU.
- Prompt: `buildMessages` em modo `default`, artigo completo
  (`experiments/data/fastdllm.txt`), trecho
  “The list of poker hands that consist of two English words”,
  `responseLanguage: en`.
- Amostragem recomendada pelo modelo: temperatura 1,0, top_p 0,95, top_k 20,
  min_p 0,05, presence 0,0, repeat 1,0, seed 42, `max_tokens` 10.240.
- Pergunta: `me de um outro exemplo sem ser sobre poker.`

## Resultado

| Métrica | Valor |
|---|---:|
| Palavras da resposta final | 183 |
| Tokens de prompt | 22.610 |
| Tokens gerados (raciocínio + resposta) | 1.120 |
| Caracteres de raciocínio oculto | 3.912 |
| Prefill | 61,4 s (368 t/s) |
| Geração | 292,8 s (3,82 t/s) |
| Tempo total | 354,4 s |
| `finish_reason` | `stop` |

## Resposta

The article uses the poker-hand example to illustrate the core problem of parallel decoding: when the model samples interdependent token positions independently under the conditional independence assumption, it can produce incoherent combinations (e.g., "high house" instead of "high card" or "two pair").

Another example: consider filling two blanks in the sentence "The ___ of a ___ is its head." If the model independently samples the two positions given only the surrounding context, it might generate "The tail of a tree is its head" or "The trunk of a river is its head," both of which are semantically invalid. A dependency-aware generation would produce a valid pairing such as "The top of a tree is its head" or "The front of a ship is its bow." In both the poker example and this one, the issue is identical: the true joint distribution requires that the second token be conditioned on the first (\(p(x_i, x_j \mid x_t) = p(x_i \mid x_t)\cdot p(x_j \mid x_t, x_i)\)), whereas independent parallel sampling approximates this with \(p(x_i \mid x_t)\cdot p(x_j \mid x_t)\), discarding the dependency between the two positions.

## Avaliação

| Critério | Resultado |
|---|---|
| Respeita “sem poker” | Parcial — cita o exemplo original na abertura, mas o exemplo novo não é de poker |
| Exemplo concreto novo | **Sim** — “The ___ of a ___ is its head” |
| Combinação inválida | **Sim** — “The tail of a tree is its head”, “The trunk of a river is its head” |
| Mecanismo de amostragem independente | **Sim** — explica a diferença entre a conjunta e o produto das marginais |
| LaTeX | Sim — fórmulas inline corretas |
| Formato | Sem listas, tabelas, títulos ou código; 183 palavras |
| Didática | Boa, embora o template “is its head” e o exemplo “front of a ship is its bow” não sejam perfeitamente consistentes |

Overall aproximado: **4/5**. Foi a melhor resposta das cinco testadas para esse
caso: produziu um exemplo não-poker, duas combinações inválidas e a explicação
do mecanismo, dentro do limite de palavras.

## Comparação com o LFM3

| Run | Palavras | Resultado |
|---|---:|---|
| LFM3 Q4 — PT | 307 | Fora do tema; foi para similaridade de KV-cache |
| LFM3 F16 — PT | 104 | No tema, mas ainda cita poker e não dá combinação inválida |
| LFM3 Q4 — EN | 135 | No tema, fórmula correta, mas exemplo abstrato |
| LFM3 F16 — EN | 66 | “big cat / small dog” não demonstra o mecanismo |
| **Bonsai PTQ1_0 — PT** | **183** | **Exemplo concreto, inválido e não-poker** |

Ressalvas: o Bonsai usou a amostragem recomendada (temperatura 1,0), enquanto
os LFM3 usaram a amostragem de produção (temperatura 0,1, top_k 50); o prompt e
o artigo são idênticos. O Bonsai é muito mais lento nesta máquina (3,8 t/s,
cerca de 6 minutos por resposta), porque 5,95 GB de pesos e 32k de contexto
quase enchem os 8 GB de VRAM. Não é um benchmark estatístico: uma geração por
configuração.

## Nota de ambiente

Para liberar RAM, um modelo ocioso do Ollama foi descarregado antes do teste;
o daemon o recarrega sob demanda na próxima utilização.
