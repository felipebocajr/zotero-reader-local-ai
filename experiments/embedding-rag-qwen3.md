# RAG com Qwen3-Embedding-0.6B

Data: 2026-11-18

## Decisão

O contexto padrão do plugin passou a ser RAG com **apenas embeddings locais**. Não há BM25, busca híbrida nem reranker nesta versão. Os chunks e vetores ficam em memória; não há banco vetorial.

O modo **Artigo completo** continua explícito nas preferências e é o caminho usado pelo benchmark de precisão entregue.

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
| Com instrução | 10 | 9 | 9 | 10 | 10 | 0,727 |
| Sem instrução | 10 | 9 | 10 | 10 | 10 | 0,712 |

O único caso fora do top 5 foi `rope-cross-section`, em 10º com instrução e 8º sem instrução. Como o chunk correto já aparece no top 12 nos dois modos, não há evidência de que um reranker seja necessário. O `Qwen3-Reranker-0.6B` não foi implementado.

A diferença entre instrução e pergunta pura é pequena e dentro do ruído de 10 casos. A implementação mantém a instrução porque é a recomendação do model card e teve MRR ligeiramente maior; ela é uma constante, não um prompt de conversa. Se o benchmark ampliado mostrar o contrário, a constante pode ser removida sem mudar a arquitetura.

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
- aviso no popup: **24 de 45 trechos · ~7.168 tokens**;
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
- O modo local usa 16.000 tokens e até 24 chunks; essa escolha deve ser comparada com o artigo completo em qualidade de resposta, não apenas em hit@k.
- A quantização Q8_0 do embedding foi fixada; não compare resultados entre precisões sem um novo fingerprint.
