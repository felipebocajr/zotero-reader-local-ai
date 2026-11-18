# RAG com Qwen3-Embedding-0.6B

Data: 2026-11-18

## Decisão

O contexto padrão do plugin passou a ser RAG com **apenas embeddings locais**. Não há BM25, busca híbrida nem reranker nesta versão. Os chunks e vetores ficam em memória; não há banco vetorial.

A interface usa apenas trechos. O caminho interno de artigo completo permanece no benchmark de precisão entregue e não é exposto nas preferências.

## Modelo e runtime

- Modelo: `Qwen/Qwen3-Embedding-0.6B-GGUF`, Q8_0, 639.150.592 bytes.
- SHA-256: `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`.
- 1.024 dimensões, contexto de 32k, 100+ idiomas, Apache 2.0.
- llama.cpp b12250: `--embedding --pooling last --embd-normalize 2`.
- Servidor separado em `127.0.0.1:18081`; o chat continua em seu próprio processo.
- Instrução fixa apenas na pergunta; documentos usam heading + texto do chunk, sem instrução.
- Vetores em `Float32Array`, normalizados, similaridade de cosseno. ~320 KB para 80 chunks.
- Download e pin em `runtime.lock.json`; `scripts/setup_runtime.py` baixa o modelo por padrão.

Referências oficiais:
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF>

## Benchmark de recuperação

Corpus: texto real de `Zotero.PDFWorker.getFullText` para Attention, RMSNorm, RoPE, LoRA e LLaDA, no perfil isolado. 284 chunks. Dez casos não-ausentes de `experiments/cases.json`; os cinco casos “artigo completo” foram excluídos.

| Modo | Casos | hit@5 | hit@8 | hit@12 | hit@20 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| Com instrução | 10 | 9 | 9 | 10 | 10 | 0,777 |
| Sem instrução | 10 | 9 | 10 | 10 | 10 | 0,729 |

Medição com o servidor de embeddings em GPU, o caminho usado em produção. Em CPU, pequenas diferenças de ponto flutuante podem reordenar chunks com scores próximos; os números não devem ser misturados entre backends.

O único caso fora do top 5 foi `rope-cross-section`, em 10º com instrução e 8º sem instrução. Como o chunk correto já aparece no top 12 nos dois modos, não há evidência de que um reranker seja necessário. O `Qwen3-Reranker-0.6B` não foi implementado.

A diferença entre instrução e pergunta pura é pequena e dentro do ruído de 10 casos. A implementação mantém a instrução porque é a recomendação do model card e teve MRR ligeiramente maior; ela é uma constante, não um prompt de conversa. Se o benchmark ampliado mostrar o contrário, a constante pode ser removida sem mudar a arquitetura.

### Seleção adaptativa por score

O teto fixo de 12 foi substituído por um critério relativo: manter chunks com similaridade de cosseno de pelo menos **75% do melhor chunk**, com mínimo de **4** e máximo de **12**. O orçamento de tokens continua sendo o limite final.

Simulação nos 10 casos:

| Política | Média de chunks | Cobertura de todas as seções |
|---|---:|---:|
| Teto fixo de 12 | 11,5 | 10/10 |
| Score ≥75% do melhor | ~9,2 | 10/10 |

O corte absoluto não é usado: similaridade de cosseno não é probabilidade calibrada e varia com consulta, idioma e backend. O limite relativo preserva o caso `rope-cross-section`, que fica em 10º e seria perdido com um piso de 80%.

### Comparação com Adaptive-k da Megagon Labs

As duas políticas foram executadas nos mesmos 10 casos, com o mesmo modelo, chunking, trecho selecionado, instrução e remoção de referências. O Adaptive-k usa o maior gap entre scores ordenados, busca restrita aos 90% melhores e buffer de 5 chunks, como no paper. A seleção foi medida sem truncamento; os tokens são o prompt completo estimado, e a coluna de orçamento indica quem passaria de 5.500.

| Caso | 75% chunks | 75% tokens | Megagon chunks | Megagon tokens |
|---|---:|---:|---:|---:|
| attention-definition | 4 | 1.636 | 7 | 2.291 |
| attention-cross-section | 12 | 3.841 | 7 | 2.673 |
| rmsnorm-definition | 5 | 2.127 | 7 | 2.725 |
| rmsnorm-cross-section | 11 | 3.641 | 6 | 2.011 |
| rope-definition | 11 | 3.548 | 9 | 2.959 |
| rope-cross-section | 11 | 3.514 | 25 | **7.000** |
| lora-definition | 12 | 4.101 | 37 | **10.715** |
| lora-cross-section | 12 | 4.139 | 7 | 2.731 |
| llada-definition | 12 | 4.344 | 36 | **10.498** |
| llada-cross-section | 4 | 1.814 | 6 | 2.290 |
| **Média** | **9,4** | **3.271** | **14,7** | **4.589** |

As duas atingiram **10/10** de cobertura de evidência. O Adaptive-k usou menos chunks em 4 casos, mas estourou o orçamento de 5.500 tokens em **3 de 10** (rope-cross-section, lora-definition e llada-definition), chegando a 10.715 tokens. O 75% não estourou em nenhum caso.

Os tokens foram remedidos com o idioma automático; a seleção de chunks não mudou.

Motivo: o maior gap pode ocorrer perto da cauda quando os scores são comprimidos, e o buffer de 5 amplia o corte. Em um corpus com 45–89 chunks, isso seleciona 25–37 chunks. Para usar Adaptive-k no plugin, seria necessário um teto rígido e provavelmente ajustar o buffer; o 75% é mais estável para o orçamento do Groq.

Artefato: `experiments/results/retrieval-policy-comparison.json`.

Artefato: `experiments/results/embedding-retrieval-qwen3-0.6b-zotero.json`.

Reprodução:

```bash
python3 scripts/serve_embedding.py
node --experimental-strip-types scripts/embedding_benchmark.ts \
  --papers-dir .runtime/zotero-splitter-corpus \
  --out experiments/results/embedding-retrieval-qwen3-0.6b-zotero.json
```

## Validação nativa

`scripts/zotero-embedding-tests.js` no perfil isolado:

- servidor gerenciado pronto, processo próprio, modelo `qwen3-embedding-0.6b`;
- dois vetores de 1.024 dimensões;
- similaridade de cosseno **0,825** entre “Como o cache KV funciona na decodificação em blocos?” e um trecho em inglês sobre Key-Value Cache;
- parada do servidor gerenciado.

`scripts/zotero-rag-tests.js`:

- popup com pergunta em português;
- prompt com `TRECHOS RECUPERADOS DO ARTIGO`;
- artigo completo ausente do prompt;
- regra de insuficiência específica para trechos;
- aviso no popup: **11 de 45 trechos · ~3.500 tokens**;
- resposta renderizada pelo mock, sem erro.

Evidências:

- `experiments/results/native-embedding.json`
- `experiments/results/native-rag.json`
- `experiments/splitter-zotero-validation.md`
- `experiments/results/splitter-validation.json`

## Limitações

- Dez casos de recuperação é uma amostra pequena; o benchmark deve crescer com os casos de Fast-dLLM e FlashAttention-4.
- O corpus real deste teste tem 5 PDFs; Fast-dLLM e FlashAttention-4 só existem no corpus `pdftotext`.
- A detecção de headings é heurística e depende da extração do PDF.
- A avaliação nativa foi feita em Linux; Windows e a instalação de produção ainda precisam de validação separada.
- A seleção usa similaridade relativa: chunks com score ≥75% do melhor, entre 4 e 12, limitados pelo orçamento. O corte absoluto não é usado porque o cosine não é uma probabilidade calibrada. A média caiu de 11,5 (teto fixo de 12) para ~9,2 chunks, mantendo 10/10 na cobertura de evidência. O modo local usa 16.000 tokens; essa escolha deve ser comparada com o artigo completo em qualidade de resposta, não apenas em hit@k.
- A quantização Q8_0 do embedding foi fixada; não compare resultados entre precisões sem um novo fingerprint.
