# Comparação de precisões

Dataset em [`cases.json`](cases.json): cinco versões fixadas de papers, três perguntas por paper (conceito, outra seção e informação ausente), três repetições por configuração. São **135 gerações** para F16, Q8_0 e Q4_K_M do mesmo checkpoint oficial, sem variantes QAD.

## Reproduzir

```bash
python3 scripts/setup_runtime.py --backend cuda --precision all
python3 scripts/prepare_papers.py
LFM_RESULTS_DIR="$PWD/experiments/results-repeat" LFM_BINARY="$PWD/.runtime/llama-cuda/llama-b11206/llama-server" LFM_GPU_LAYERS=24 LFM_PRECISIONS=F16,Q8_0,Q4_K_M npm run experiment
```

Para CPU, prepare `--backend cpu --precision all` e execute `LFM_RESULTS_DIR="$PWD/experiments/results-cpu" npm run experiment` sem as variáveis CUDA. Não compare números CPU com CUDA como se apenas a precisão tivesse mudado.

O script lança e encerra seu próprio servidor, uma precisão por vez, na porta 18084. Mantém 24 camadas GPU no perfil CUDA acima, oito threads, contexto 32.768, K/V f16, reserva 4.096, temperatura 0,1 e seed 42. O contexto de comparação é explícito e independente do padrão de uso de 64.000 tokens do plugin/launcher. O prompt é o mesmo do plugin. `cache_prompt:false` força processamento do contexto em cada repetição; reutilização de prefixo fica desativada.

O benchmark seleciona backend e camadas explicitamente, com ajuste automático e fallback desabilitados. O modo padrão de uso (`scripts/serve.py`) prefere GPU inteira e pode compartilhar com CPU; seus tempos ficam em artefatos separados. Novos identificadores experimentais incluem também o código do launcher. A comparação já entregue permanece intacta.

Os downloads PDF vêm do arXiv, com versões e SHA-256 registrados. A extração experimental usa Poppler em todas as páginas, enquanto o plugin usa o worker do Zotero. Isso torna a comparação entre precisões reproduzível, mas os tempos do benchmark não incluem extração e renderização do popup.

## Artefatos

- `results/experiment-config.json`: versões, hashes, parâmetros e identificador da configuração.
- `results/runs.jsonl`: cada resposta final, tempos, contagem de tokens e pico amostrado de memória por processo.
- `results/metrics.csv`: métricas tabulares.
- `results/quality-review.csv`: campos para revisão de correção, apoio no artigo e clareza.
- `results/model-validation.json`: três casos de validação inicial com Q4 antes da interface; esse ensaio antecede o prompt final.
- `results/native-acceptance.json`: aceitação com Zotero real e resposta simulada.
- `results/native-annotations.json`: gravação opcional de respostas escolhidas e leitura na aba de anotações, com Zotero real e geração simulada.
- `results/native-model.json`: quatro perguntas pelo popup em três PDFs, com a LFM real e extração do Zotero.
- `results/cpu-smoke.json` e `cuda-smoke.json`: inferências reais com artigo inteiro e conferência da contagem prévia contra o servidor.
- `results/build-validation.json`: testes, integridade e SHA-256 do XPI original da comparação.
- `results/annotation-build-validation.json`: testes, integridade e confirmação do XPI atualizado com salvamento opcional de respostas nas anotações.
- `results/quality-assessment.json` e `quality-reviewed.csv`: notas e justificativas de revisão assistida, sem avaliador humano independente.
- `results/summary.json` e `case-summary.csv`: resumos calculados, incluindo igualdade das respostas entre repetições.
- `results/memory-highwater.json`: pico RSS do ciclo de vida dos servidores Q8/Q4 via kernel.
- `results/load-memory.json`: medição adicional do carregamento das três precisões, com os mesmos parâmetros de memória.
- `results/runtime-auto-validation.json` e `runtime-auto-*-smoke.json`: validação posterior do modo de uso GPU/fallback, separada do benchmark; [detalhes](runtime-fallback-validation.md).
- `results/lfm8b-validation.json`, `lfm8b-smoke.json` e `native-lfm8b.json`: validação de uso da opção LFM2.5-8B-A1B Q4, com modelo real e GPU/CPU; [detalhes](lfm8b-validation.md). Não integram as 135 gerações do 2.6B.
- `results/model-build-validation.json`: hash e ativação do XPI com seletor de modelos, testes TypeScript/Python e verificações nativas.
- `results/native-math.json`, `math-model-smoke.json`, `math-model-render.json` e `math-build-validation.json`: validação da formatação LaTeX no popup, na visualização dos comentários e em uma resposta real. O prompt com instruções de LaTeX é posterior ao benchmark; não misture esses resultados.
- `results/native-markdown.json` e `markdown-build-validation.json`: formatação Markdown com MathML, anotação original, persistência após reinício e ativação do XPI final; [detalhes](markdown-validation.md).
- `.runtime/experiment-*.log`: logs locais do runtime, incluindo prefill/decode.

Execuções podem ser retomadas com os mesmos parâmetros e `LFM_RESULTS_DIR`. O script recusa misturar resultados quando o identificador da configuração muda. Use outra pasta para uma nova comparação; os resultados entregues em `results/` ficam preservados. Falta de memória e falhas são resultados; o script não reduz contexto nem altera a distribuição CPU/GPU para conseguir completar uma configuração.

Para repetir a medição separada de carregamento, pare os outros modelos e execute `python3 scripts/measure_startup.py --backend cuda --gpu-layers 24 --output experiments/results-repeat/load-memory.json`. A cache de arquivos do sistema não é apagada. Para recalcular os resumos, use `python3 scripts/summarize_experiment.py` ou `--results experiments/results-repeat`, após preencher avaliações nessa pasta.

## Métricas e rubrica

O tempo até a primeira resposta visível inclui processamento do prompt e raciocínio oculto. O tempo total vai da preparação HTTP até o término da resposta. `completionTokens` inclui raciocínio e resposta, e `timings.predicted_per_second` mede decode; não equivale à velocidade de texto visível.

`ramPeakMiB` é RSS durante os pedidos, amostrado a cada 500 ms. VRAM é memória do processo reportada por `nvidia-smi`, a cada segundo. Esses picos amostrados podem perder eventos curtos e não incluem toda a memória de outros processos nem toda a cache de arquivos do sistema. O carregamento pode consumir mais RAM que a geração: o relatório distingue essas medidas. Novas execuções também registram `ramHighwaterMiB` de `/proc/PID/status`, incluindo carregamento. Os arquivos GGUF de 1,67/2,87/5,40 GB não equivalem à memória total de inferência.

Pontuação por dimensão:

| Nota | Correção | Apoio no artigo | Clareza |
|---|---|---|---|
| 2 | Conceito/resultados corretos; reconhece ausência | Afirmações sustentadas pelo paper | Direta e compreensível |
| 1 | Imprecisão pequena ou explicação incompleta | Inferência pouco justificada ou mistura de fontes | Redundância, ambiguidade ou excesso de extensão |
| 0 | Erro conceitual ou resultado inventado | Afirmação contradita/ausente apresentada como resultado | Resposta inutilizável ou não responde |

As referências desta execução foram conferidas no texto e nas páginas renderizadas; [reference-validation.md](reference-validation.md) registra os localizadores corretos para as versões v1, corrigindo alguns números originalmente indicados em `cases.json`. O dataset e os registros do benchmark ficam preservados. Para novas avaliações, registre o responsável e seus critérios; uma revisão assistida não substitui avaliação humana independente. Não trate 15 casos como evidência de qualidade geral.
