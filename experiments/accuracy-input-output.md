# Acurácia de entrada/saída — Attention Is All You Need

Suíte de 11 perguntas sobre o artigo real **Attention Is All You Need** (arXiv
`1706.03762v1`). O texto completo já fixado em `experiments/data/attention.txt`
é enviado em todas as perguntas, sem resumo ou truncamento. Cada resposta usa o
prompt de produção (`buildMessages`) e o cliente do plugin (`LlamaClient`).

O objetivo é medir fatos recuperados do artigo, fórmulas, recusas, aderência ao
idioma e ao limite de extensão — separando conteúdo de instruções. Não é uma
avaliação humana geral nem substitui o benchmark de precisões já entregue.

> **Baseline histórico.** Esta suíte usa o prompt anterior (1–3 parágrafos,
> 150 palavras). O prompt atual do produto pede resposta direta e didática, com
> teto de 250 palavras e sem listas/tabelas. Os números desta página não são
> comparáveis à rodada `accuracy-papers` feita com a política nova.

## Dataset

`experiments/accuracy-attention.json` contém os casos, a resposta esperada e as
verificações. Cada caso tem:

- `selectionPhrase`: trecho selecionado, como no popup;
- `question`: pergunta independente, sem histórico;
- `responseLanguage`: `en` (padrão) ou `pt-BR`;
- `expected`: resposta de referência para revisão;
- `checks`: verificações objetivas de conteúdo, instrução e idioma.

Tipos de verificação:

- `required`: pelo menos um padrão precisa aparecer na resposta;
- `forbidden`: nenhum padrão pode aparecer (por exemplo, nota de MMLU inventada);
- `language`: o detector de palavras funcionais precisa reconhecer o idioma pedido;
- `max_words`: limite de 150 palavras do prompt, aplicado sem tolerância.

Os 11 casos cobrem definição, escala, múltiplas cabeças, arquitetura, máscara,
codificação posicional, treinamento, resultados, ausência de MMLU, fórmula e uma
resposta em português. O caso de MMLU verifica também que o modelo não inventa
um número ausente no artigo.

## Executar

Requer o runtime e os pesos preparados, como no restante do projeto:

```bash
python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
npm run test:accuracy
```

Para comparar os dois modelos:

```bash
LFM_ACCURACY_MODELS=lfm2.5-2.6b,lfm2.5-8b-a1b npm run test:accuracy
```

O script inicia e encerra o próprio servidor na porta `18096`, com contexto
`32.768`, reserva de geração `4.096`, temperatura `0,1`, seed `42` e
`cache_prompt:false`. O servidor é usado com `LLAMA_ARG_THINK_BUDGET=512` para
limitar o raciocínio oculto; esse limite é uma configuração do ensaio e pode ser
alterado com `LFM_ACCURACY_THINK_BUDGET` (`-1` remove o limite). O prompt e o
cliente continuam sendo os do plugin.

Variáveis úteis:

| Variável | Padrão | Efeito |
|---|---|---|
| `LFM_ACCURACY_MODELS` | `lfm2.5-2.6b` | modelos separados por vírgula |
| `LFM_ACCURACY_PRECISION` | `Q4_K_M` | precisão dos pesos |
| `LFM_ACCURACY_DATASET` | `experiments/accuracy-attention.json` | dataset de casos |
| `LFM_ACCURACY_EVALUATOR` | `regex` | `regex` ou `judge` (FActScore) |
| `LFM_ACCURACY_SUMMARY` | `accuracy-attention-summary.json` | nome do resumo |
| `LFM_ACCURACY_CONTEXT` | `32768` | contexto explícito do servidor |
| `LFM_ACCURACY_THINK_BUDGET` | `512` | orçamento de raciocínio oculto |
| `LFM_ACCURACY_OUTPUT` | `experiments/results/accuracy-attention-q4.csv` | CSV por caso |
| `LFM_ACCURACY_RESULTS_DIR` | `experiments/results` | pasta do resumo |
| `LFM_ACCURACY_PORT` | `18096` | porta local |
| `LFM_ACCURACY_TIMEOUT_MS` | `600000` | tempo limite por resposta |
| `LFM_ACCURACY_URL` | vazio | usa um servidor já iniciado |

O avaliador `judge` lê `deepinfra_key` e `deepinfra_model` do `.env`, decompõe
cada resposta em fatos atômicos e verifica cada fato contra o artigo. Ele não vê
`expected` nem os checks antigos. Para uma suíte nova, use um dataset e um
`LFM_ACCURACY_OUTPUT` separados; o baseline de Attention não deve ser
sobrescrito.

O CSV é gravado ao final, inclusive quando há erro de geração. Os arquivos do
benchmark antigo (`quality-reviewed.csv`, `runs.jsonl`, `metrics.csv`) não são
tocados.

## Resultado desta execução

Execução de 22 respostas (11 por modelo), Q4_K_M, contexto 32.768, em
2026-10-22. Nenhuma geração terminou em erro.

| Modelo | Conteúdo + idioma | Todos os checks | Média dos checks | Palavras/resposta |
|---|---:|---:|---:|---:|
| `lfm2.5-2.6b` | 8/11 | 8/11 | 91,9% | 117,6 |
| `lfm2.5-8b-a1b` | 9/11 | 7/11 | 93,8% | 84,5 |

`Conteúdo + idioma` exige todos os checks de conteúdo e o idioma. `Todos os
checks` inclui também o limite de 150 palavras, por isso o 8B aparece com 9/11
alinhado ao conteúdo, mas 7/11 em todos os checks: duas respostas corretas
passaram de 150 palavras.

### Por caso

| Caso | 2.6B | 8B | Falhas relevantes |
|---|---:|---:|---|
| `attention-definition` | 100% | 85,7% | 8B: 156 palavras |
| `attention-scaling` | 100% | 100% | — |
| `attention-multihead` | 50,0% | 100% | 2.6B omitiu h=8, d_k=d_v=64 e d_model=512 |
| `attention-architecture` | 100% | 100% | — |
| `attention-masking` | 100% | 100% | — |
| `attention-positional` | 75,0% | 75,0% | ambos erraram a fórmula; 2.6B também passou de 150 palavras; 8B omitiu os comprimentos de onda |
| `attention-training` | 85,7% | 85,7% | 2.6B omitiu 4.000 passos; 8B omitiu beta1/beta2 |
| `attention-results` | 100% | 100% | — |
| `attention-absent` | 100% | 100% | ambos recusaram MMLU sem inventar nota |
| `attention-formula` | 100% | 100% | — |
| `attention-definition-pt` | 100% | 85,7% | 8B: 159 palavras |

A aprovação é por caso, com todos os checks iguais em peso; `accuracy_percent`
não é uma probabilidade estatística. Um caso pode ter conteúdo correto e ainda
falhar por extensão — os campos separados permitem ver essa diferença.

## Artefatos

- `results/accuracy-attention-q4.csv`: uma linha por modelo/caso, com resposta
  final, resposta esperada, contagens de checks, percentual, falhas, tokens,
  tempo e erro.
- `results/accuracy-attention-summary.json`: agregado por modelo e total.
- `.runtime/accuracy-<modelo>-<precisão>.log`: log do servidor, ignorado no Git.

Principais colunas do CSV:

| Coluna | Significado |
|---|---|
| `answer` | resposta final exibida; raciocínio oculto não é armazenado |
| `status` | `ok` ou `error` |
| `content_passed` / `content_total` | fatos e fórmulas aprovados |
| `instruction_passed` / `instruction_total` | limite de extensão |
| `language_passed` | idioma detectado contra o pedido |
| `content_aligned` | conteúdo e idioma aprovados; extensão separada |
| `all_checks_passed` | conteúdo, idioma e extensão aprovados |
| `accuracy_percent` | checks aprovados / checks totais |
| `failed_checks` | IDs das verificações reprovadas |
| `reasoning_budget` | orçamento de raciocínio usado no ensaio |

## Limitações

- São 11 casos de um único artigo; não representam a acurácia geral do modelo.
- A avaliação é automática por expressões regulares e pode aceitar uma resposta
  correta com redação inesperada ou rejeitar uma resposta correta mal formatada.
  A resposta e `expected` ficam no CSV para revisão.
- O limite de 150 palavras é deliberadamente estrito. Perguntas que pedem uma
  fórmula ou detalhes numéricos às vezes precisam de uma resposta mais curta que
  o modelo produziu.
- O resultado usa Q4_K_M e contexto 32.768, não o padrão de 64.000 tokens do
  plugin. Tempos não são comparáveis ao benchmark de precisões.
- O orçamento de raciocínio de 512 tokens é uma configuração deste ensaio. Sem
  esse limite, algumas respostas geraram um segundo fechamento de raciocínio e
  foram rejeitadas pelo cliente; por isso o resultado deve ser lido com essa
  condição explícita.
- A validação nativa do plugin em Windows 10/11 x64 continua pendente; este
  ensaio foi executado em Linux com CUDA.
