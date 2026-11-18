# Acurácia com juiz — FlashAttention-4 e Fast-dLLM

Suíte de **20 casos** (10 por artigo) sobre dois papers completos:

- **FlashAttention-4** — arXiv `2603.05451v1` (20 páginas, 8.420 palavras).
- **Fast-dLLM** — arXiv `2505.22618v3` (22 páginas, 11.905 palavras).

Cada resposta usa o caminho de produção (`buildMessages` + `LlamaClient`), o
artigo inteiro sem truncamento e a política atual do plugin: resposta direta,
didática, com teto de 250 palavras e sem listas, tabelas, títulos ou blocos de
código. Os casos cobrem conceito, método, fórmula/teoria, resultados numéricos,
limitação, informação ausente e uma resposta em português por artigo.

## Método

A avaliação de conteúdo usa um juiz no estilo **FActScore** (Min et al., 2023):

1. o juiz decompõe a resposta em fatos atômicos e autossuficientes;
2. cada fato é verificado contra o texto do artigo e recebe um de quatro rótulos:
   `supported`, `contradicted`, `not_in_source` ou `irrelevant`;
3. o juiz cita o menor trecho de evidência que sustenta o rótulo;
4. `precision = supported / total` e `contradiction_rate = contradicted / total`;
5. uma passagem separada mede a **cobertura** dos keyfacts do caso, sem comparar
   a resposta com o texto de `expected`.

O juiz não vê `expected`, `evidence` nem os checks antigos; vê apenas a pergunta,
a resposta candidata e o artigo. `expected` e `evidence` servem para auditoria
humana e calibração.

Uma passagem separada avalia a **direção** da resposta, com três critérios
binários: responde à pergunta, evita conteúdo não solicitado e é didática sem ser
prolixa. Ela não julga correção factual.

A política atual exige que, quando o artigo não contém informação suficiente, a
resposta diga isso explicitamente na primeira frase e indique o que falta, sem
preencher a lacuna com conhecimento externo, suposições ou números inventados.
Os casos `fa4-absent` e `dllm-absent` medem essa abstenção.

Estes resultados foram medidos quando `responseLanguage` ainda era uma
preferência. O plugin atual segue o idioma de cada pergunta; os números abaixo
permanecem históricos e não devem ser misturados com novas execuções.

Checagens determinísticas continuam separadas:

- idioma detectado contra o idioma esperado do caso (`responseLanguage` no dataset);
- limite de 250 palavras (ou `maxWords` do caso);
- ausência de listas, tabelas, títulos e blocos de código;
- ausência de tags de raciocínio (`<think>`, `reasoning_content`);
- resposta não vazia e geração concluída.

O modelo do juiz e a versão do prompt ficam registrados no resumo. O padrão do
projeto é o `deepinfra_model` do `.env` (`deepseek-ai/DeepSeek-V4.1-Flash-1017`),
com temperatura 0 e saída JSON.

Esta matriz usa **perguntas digitadas** e o prompt padrão de 250 palavras. O
botão `Explicar trecho` usa um prompt inicial mais breve, de 120 palavras, e o
botão `Explicar com mais detalhes` usa o prompt de 250; esses dois modos não são
medidos por esta suíte.

## Executar

Requer o runtime e os pesos preparados:

```bash
python3 scripts/setup_runtime.py --model lfm2.5-8b-a1b --backend auto --precision Q4_K_M
python3 scripts/setup_runtime.py --model lfm3-1.7b --backend auto --precision Q4_K_M
```

Depois:

```bash
LFM_ACCURACY_MODELS=lfm2.5-8b-a1b,lfm3-1.7b \
LFM_ACCURACY_PRECISION=Q4_K_M \
LFM_ACCURACY_EVALUATOR=judge \
LFM_ACCURACY_DATASET=experiments/accuracy-papers.json \
LFM_ACCURACY_RESULTS_DIR=experiments/results-lfm3-direct \
LFM_ACCURACY_SUMMARY=accuracy-papers-direct-summary.json \
LFM_ACCURACY_OUTPUT=experiments/results-lfm3-direct/accuracy-papers-direct-q4.csv \
LFM_ACCURACY_CONTEXT=32768 \
LFM_ACCURACY_THINK_BUDGET=512 \
npm run test:accuracy
```

O script inicia e encerra o próprio servidor na porta `18096`, com contexto
`32.768`, reserva de geração `4.096`, temperatura `0,1`, seed `42` e
`cache_prompt:false`. O raciocínio oculto é limitado a 512 tokens. O contexto
explícito difere do padrão de uso de 64.000 tokens do plugin, como no baseline
de Attention.

## Artefatos

- `accuracy-papers.json`: casos, keyfacts, evidência e resposta esperada.
- `results-lfm3-direct/accuracy-papers-direct-q4.csv`: uma linha por modelo/caso, com resposta,
  veredictos, evidência citada, direção, formato, tokens e tempo.
- `results-lfm3-direct/accuracy-papers-direct-summary.json`: agregado por modelo e total.
- `.runtime/accuracy-<modelo>-<precisão>.log`: log do servidor, ignorado no Git.

Colunas principais do CSV:

| Coluna | Significado |
|---|---|
| `answer` | resposta final exibida; raciocínio oculto não é armazenado |
| `status` | `ok` ou `error` |
| `claims` | fatos atômicos extraídos da resposta |
| `supported` / `contradicted` / `not_in_source` | veredictos do juiz |
| `precision_percent` | `supported / claims` |
| `coverage_percent` | keyfacts cobertos pelo juiz de cobertura |
| `format_issues` | listas, tabelas, títulos ou código detectados |
| `directness_passed` | responde à pergunta, sem excesso e didática |
| `directness_json` | os três critérios e a justificativa do juiz |
| `judge_json` | veredictos completos, com trecho de evidência e justificativa |
| `word_count` | palavras da resposta |
| `failed_checks` | fatos contraditos/fora da fonte, formato e direção |
| `prompt_tokens` / `completion_tokens` | uso do modelo avaliado |
| `total_ms` | tempo de geração da resposta |

## Rodada anterior — 150 palavras (histórico)

Esta rodada usou o prompt anterior (1–3 parágrafos, 150 palavras) e não é
comparável à rodada direta com 250 palavras.

Execução de 40 respostas (20 por modelo), Q4_K_M, contexto 32.768, juiz
`deepseek-ai/DeepSeek-V4.1-Flash-1017`, em 10/11/2026. Uma resposta do 8B
terminou em erro de separação de raciocínio; as outras 39 concluíram.

| Modelo | Casos ok | Fidelidade | Contradições | Fora da fonte | Cobertura | Palavras/resposta | ≤150 palavras | Alinhados |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `lfm2.5-8b-a1b` | 19/20 | 68,2% | 15,6% | 31 | 55,5% | 108,4 | 17/19 | 4/19 |
| `lfm3-1.7b` | 20/20 | 82,1% | 7,6% | 35 | 78,1% | 202,8 | 6/20 | 2/20 |

`Fidelidade` é `supported / claims` no total do modelo; `Alinhados` exige todos
os fatos suportados (ou irrelevantes) e o idioma correto, então é uma métrica
tudo-ou-nada e mais dura que a fidelidade média.

Por artigo:

| Artigo | Modelo | Fidelidade | Contradições | Cobertura | Palavras/resposta |
|---|---|---:|---:|---:|---:|
| FlashAttention-4 | 8B-A1B | 68,8% | 18,3% | 59,4% | 100,1 |
| FlashAttention-4 | LFM3-1.7B | 87,1% | 4,1% | 76,7% | 195,9 |
| Fast-dLLM | 8B-A1B | 67,7% | 13,1% | 52,0% | 115,9 |
| Fast-dLLM | LFM3-1.7B | 76,9% | 11,2% | 79,5% | 209,7 |

Leitura:

- O LFM3 foi mais fiel, teve menos contradições e cobriu mais keyfacts nos dois
  artigos. Também não teve erro de protocolo; o 8B teve um erro de separação de
  raciocínio.
- O LFM3 foi muito mais verbose: 202,8 palavras em média e apenas 6/20 respostas
  dentro de 150 palavras, contra 108,4 e 17/19 do 8B. Ele também usou tabelas e
  listas, apesar da instrução de 1–3 parágrafos sem listas.
- O ponto fraco do LFM3 são resultados numéricos densos: `dllm-results` 55,6% e
  `fa4-results` 63,2%, com números de comprimento/geração trocados. O 8B acertou
  menos detalhes de mecanismo (`fa4-backward-deterministic` 33,3%,
  `dllm-hyperparams` 36,8%) e inventou menos números.
- O 8B foi mais conciso e obedeceu melhor ao limite de 150 palavras; o LFM3 foi
  mais completo e mais fiel, mas não cabe no contrato atual do popup sem ajuste
  de prompt/formato.

O juiz é deliberadamente estrito. Parte dos `not_in_source` são paráfrases
razoáveis, não invenções; por isso a comparação relativa entre os modelos é mais
confiável que a precisão absoluta. A calibração humana (kappa) ainda não foi
feita.

## Rodada direta — 250 palavras

Execução de 40 respostas (20 por modelo), Q4_K_M, contexto 32.768, juiz
`deepseek-ai/DeepSeek-V4.1-Flash-1017` (`factscore-2`), em 10/11/2026. Uma
resposta do 8B terminou em erro de separação de raciocínio (`dllm-results`); as
outras 39 concluíram.

| Modelo | Casos ok | Fidelidade | Contradições | Fora da fonte | Cobertura | Palavras/resposta | ≤250 | Direção | Formato | Alinhados | Todos os checks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `lfm2.5-8b-a1b` | 19/20 | 76,7% | 9,8% | 29 | 63,1% | 140,7 | 18/19 | 52,6% | 5 falhas | 4/19 | 3/19 |
| `lfm3-1.7b` | 20/20 | 84,7% | 5,1% | 30 | 74,5% | 187,9 | 16/20 | 20,0% | 12 falhas | 4/20 | 1/20 |

Por artigo:

| Artigo | Modelo | Fidelidade | Contradições | Cobertura | Palavras/resposta | ≤250 | Direção |
|---|---|---:|---:|---:|---:|---:|---:|
| FlashAttention-4 | 8B-A1B | 81,7% | 8,7% | 68,3% | 131,5 | 9/10 | 5/10 |
| FlashAttention-4 | LFM3-1.7B | 85,9% | 4,3% | 70,8% | 194,5 | 7/10 | 2/10 |
| Fast-dLLM | 8B-A1B | 72,1% | 10,8% | 57,2% | 150,9 | 9/9 | 5/9 |
| Fast-dLLM | LFM3-1.7B | 83,3% | 6,1% | 78,2% | 181,3 | 9/10 | 2/10 |

Comparação com a rodada de 150 palavras (prompt anterior):

| Métrica | 8B antes | 8B direto | LFM3 antes | LFM3 direto |
|---|---:|---:|---:|---:|
| Fidelidade | 68,2% | **76,7%** | 82,1% | **84,7%** |
| Contradições | 15,6% | **9,8%** | 7,6% | **5,1%** |
| Cobertura | 55,5% | **63,1%** | 78,1% | 74,5% |
| Palavras/resposta | 108,4 | 140,7 | 202,8 | **187,9** |
| Direção | n/d | 52,6% | n/d | 20,0% |
| Falhas de formato | n/d | 5 | n/d | 12 |
| Alinhados | 4/19 | 4/19 | 2/20 | **4/20** |
| Todos os checks | 4/19 | 3/19 | 2/20 | 1/20 |

Leitura:

- O prompt direto melhorou a fidelidade e reduziu contradições nos dois modelos.
  O 8B ganhou 8,5 pontos de fidelidade e perdeu 5,8 pontos de contradição; o
  LFM3 ganhou 2,6 e perdeu 2,5.
- O 8B ficou mais completo (cobertura 55,5% → 63,1%), mas também mais longo
  (108,4 → 140,7 palavras). Ainda assim, 18/19 respostas ficaram dentro de 250.
- O LFM3 encurtou (202,8 → 187,9) e melhorou a fidelidade, mas continua usando
  listas/tabelas em 12/20 casos e falhou em direção em 16/20. O problema não é
  mais só extensão: é formato e excesso de conteúdo não solicitado.
- O 8B obedece melhor à política (direção 52,6%, 5 falhas de formato), mas ainda
  inventa detalhes em casos de mecanismo e resultados numéricos.
- O `all_checks_passed` caiu porque agora exige também direção e formato; ele é
  mais informativo que o `content_aligned` isolado, mas não substitui a
  fidelidade por fato.

O erro intermitente de separação de raciocínio apareceu de novo no 8B
(`dllm-results`), em um caso diferente da rodada anterior. É um problema de
robustez do cliente/servidor, não do prompt.

## Limitações

- São 20 casos de dois artigos; não representam a acurácia geral dos modelos.
- O juiz é um LLM e pode ser estrito demais com explicações gerais ou
  paráfrases; a evidência fica no CSV para revisão.
- `not_in_source` não distingue uma inferência razoável de uma invenção; ambos
  contam como falha de fidelidade.
- A cobertura usa keyfacts escritos por humano e não substitui uma avaliação
  independente de correção científica.
- A dimensão de direção é um julgamento do juiz; ela mede aderência ao pedido e
  ausência de excesso, não qualidade literária.
- O resultado usa Q4_K_M e contexto 32.768; tempos não são comparáveis ao
  benchmark de precisões.
- A calibração juiz×humano (kappa) ainda precisa ser registrada para esta suíte.
