# Avaliação do assistente local de leitura

Medições realizadas em 27/09/2026. **135/135 gerações concluídas**, sem falta de memória ou interrupção. O Q4 consumiu menos memória e foi mais rápido neste perfil; houve erros científicos nas três precisões. A revisão de qualidade é assistida por Codex, sem avaliador humano independente.

## Configuração fixada

- Zotero 10.0.3; Omarchy 4.0.4, Ryzen 7 5700X, aproximadamente 15,5 GiB de RAM e RTX 3070 de 8 GiB, driver 610.57.04.
- llama.cpp b11206, commit `2b129ccfa03aea330d2d9ac4650a10de393dbe3a`; GGUF oficial LiquidAI/LFM2.5-2.6B-GGUF, revisão `e7caca5d835a3901a8e0d63e94009429bafafdfc`.
- F16, Q8_0 e Q4_K_M do mesmo checkpoint, sem QAD. **24 camadas na GPU em todas as precisões**, oito threads CPU, um slot, contexto 32.768, K/V f16/f16 e reserva de geração 4.096.
- Temperatura 0,1, top_k 50, repeat_penalty 1,1, seed 42; ordem F16 → Q8 → Q4. Nenhuma redução automática de contexto ou mudança de distribuição para acomodar um modelo.
- Cinco PDFs arXiv v1, três perguntas por artigo: conceito, outra seção e informação ausente. Três repetições por caso/configuração. Extração por Poppler de todas as páginas; o plugin usa o worker do Zotero.
- `cache_prompt:false`; `timings.cache_n` foi zero em todas as gerações. A cache de arquivos do sistema não foi apagada.

## Tempo e processamento

Medianas dos 45 pedidos de cada precisão. O tempo até texto visível inclui preparação HTTP, processamento do contexto e raciocínio oculto. O total termina com a resposta final; não inclui extração do PDF ou abertura do popup.

| Precisão | Primeiro texto visível | Tempo total | Processamento do contexto | Geração |
|---|---:|---:|---:|---:|
| F16 | 32.30 s | 41.28 s | 1409 tokens/s | 17.49 tokens/s |
| Q8_0 | 28.34 s | 32.57 s | 1611 tokens/s | 27.98 tokens/s |
| Q4_K_M | 22.04 s | 26.17 s | 1735 tokens/s | 40.66 tokens/s |

A taxa de geração inclui raciocínio e resposta; ela não é a velocidade de palavras visíveis. Os prompts efetivos tinham 9702–26053 tokens. Todos couberam integralmente com a reserva.

## Memória

RAM é RSS do processo do servidor. Os picos durante pedidos foram amostrados a cada 500 ms; VRAM por PID via `nvidia-smi` a cada segundo. A medição de carregamento foi repetida separadamente, com as mesmas 24 camadas, contexto e cache, lendo o pico do kernel (`VmHWM`) e mantendo arquivos em cache.

| Precisão | RAM: pico amostrado nos pedidos | RAM: pico no ensaio de carregamento | VRAM: pico amostrado nos pedidos | Tamanho GGUF decimal |
|---|---:|---:|---:|---:|
| F16 | 2.21 GiB | 5.35 GiB | 4.66 GiB | 5.40 GB |
| Q8_0 | 1.33 GiB | 3.01 GiB | 2.78 GiB | 2.87 GB |
| Q4_K_M | 1.09 GiB | 1.89 GiB | 1.92 GiB | 1.67 GB |

No benchmark original, o monitor do kernel foi ativado depois de F16: capturou picos de ciclo de vida de 3.054,63 MiB em Q8 e 1.935,00 MiB em Q4. O pico de ciclo de vida original de F16 não foi registrado; seu ensaio de carregamento posterior está separado, sem ser apresentado como medição retroativa. Não some máximos de momentos diferentes para estimar um pico simultâneo RAM+VRAM. Outros processos e a cache de arquivos do sistema não entram nesses valores.

## Qualidade

As três respostas de cada caso/precisão foram idênticas. As repetições medem variação de tempo, não diversidade nem três amostras independentes de qualidade. Foram revisadas **45 respostas distintas**, uma por caso/precisão, contra as referências conferidas no texto e nas páginas renderizadas.

Escala 0–2: 0 = erro relevante; 1 = imprecisão/incompletude; 2 = adequado. As notas e justificativas individuais estão em [quality-reviewed.csv](results/quality-reviewed.csv).

| Precisão | Correção média | Apoio no artigo | Clareza | Respostas >150 palavras |
|---|---:|---:|---:|---:|
| F16 | 1.60/2 | 1.67/2 | 1.53/2 | 6/15 |
| Q8_0 | 1.33/2 | 1.40/2 | 1.53/2 | 6/15 |
| Q4_K_M | 1.27/2 | 1.40/2 | 1.53/2 | 4/15 |

Exemplos de falhas verificadas:

- **F16:** transforma um índice de confiança do algoritmo de LLaDA em multiplicação e mistura refinamento de inferência com aprendizagem; outra resposta fornece expressões complexas incorretas para RoPE.
- **Q8:** inverte resultados das ablações de LLaDA base/instruct e afirma que a geração começa mascarando uma sequência original.
- **Q4:** inventa uma fórmula para pRMSNorm, fornece dimensões incompatíveis para o produto BA de LoRA e afirma decaimento exponencial de RoPE. Algumas respostas excedem 150 palavras ou usam listas apesar da instrução.

Todos os 15 casos de informação ausente (cinco por precisão) reconheceram a ausência do resultado solicitado, embora algumas respostas acrescentassem informação externa, detalhes errados ou sugestões redundantes. As médias são descritivas deste conjunto pequeno; não estabelecem superioridade geral de uma precisão.

A extração perde estrutura de fórmulas e tabelas. A revisão distinguiu erros novos de notação já degradada no texto e afirmações presentes no próprio artigo; ver [conferência das referências](reference-validation.md). Isso também limita a confiabilidade para explicações matemáticas.

## Integração real e perfil de uso

O XPI de distribuição, sem harness, foi instalado e ficou ativo no Zotero 10.0.3. **31 verificações nativas** com servidor simulado passaram: teclado/foco, streaming sem raciocínio, continuação, artigo único, perguntas independentes, múltiplas abas, bordas/zoom, cancelamento, falhas e desativação. Os **18 testes automatizados** também passaram, incluindo o limite exato do contexto.

A LFM Q4 foi executada separadamente com **todas as camadas na GPU** (`--gpu-layers -1`), e quatro pedidos foram feitos pelo popup em três PDFs: conceito, continuação, outra seção e informação ausente. As coberturas foram 15/15, 14/14 e 24/24 páginas.

| Pedido nativo | Primeiro texto visível | Tempo total |
|---|---:|---:|
| Attention: conceito | 5.83 s | 7.27 s |
| Attention: continuação | 1.99 s | 3.13 s |
| RMSNorm: outra seção | 6.60 s | 7.80 s |
| LLaDA: informação ausente | 7.78 s | 8.83 s |

Esses tempos incluem o fluxo do plugin, mas não o carregamento inicial do servidor. O processo CUDA apresentou 2.398 MiB de VRAM após as inferências e pico RSS de aproximadamente 1.933 MiB. São evidências do perfil de uso com todas as camadas, **separadas da comparação de 24 camadas**. As respostas nativas ainda contêm erros: a continuação confunde autoatenção com atenção ao encoder, e a pergunta sem resultado ainda sugere consultar o artigo completo já fornecido.

Inferências adicionais em CUDA e CPU com o artigo inteiro confirmaram que a contagem prévia coincide com `timings.prompt_n`: 10.039 tokens de entrada. O ensaio CPU Q4, sem camadas na GPU, usou as 15 páginas de Attention Is All You Need e concluiu em **134,19 segundos**, com primeiro texto visível em 115,68 segundos. A validação está em [cpu-smoke.json](results/cpu-smoke.json); ela comprova o caminho CPU, sem fazer parte da comparação entre precisões. O ensaio CUDA correspondente está em [cuda-smoke.json](results/cuda-smoke.json).

## Rastreabilidade e limites

- [Configuração/hashes](results/experiment-config.json), [135 respostas e medições](results/runs.jsonl), [resumo calculado](results/summary.json) e [medianas por caso](results/case-summary.csv).
- [Carregamento](results/load-memory.json), [picos do kernel](results/memory-highwater.json), [aceitação nativa](results/native-acceptance.json), [instalação XPI](results/native-install.json) e [inferências nativas](results/native-model.json).
- A contagem prévia do benchmark omitira **um BOS**. A entrada efetiva sempre continha esse token; os números de contexto deste relatório usam `timings.prompt_n`. O código de distribuição foi corrigido, sem alterar as mensagens de geração. O registro bruto permanece intacto; [evidência da correção](results/preflight-correction.json).
- Apenas cinco artigos de aprendizado de máquina, perguntas fixas, seed única e revisão assistida não cega. Não há avaliação humana independente, generalização para outros domínios, medição de energia ou controle de clocks/carga do desktop.
- OCR, interpretação visual de gráficos, busca externa, agentes, quantização de K/V e validação Windows/macOS ficam fora desta versão. O alvo validado é Zotero 10.0.3 em Linux x86_64.

Os comandos para repetir o experimento em outra pasta de resultados estão no [README experimental](README.md).
