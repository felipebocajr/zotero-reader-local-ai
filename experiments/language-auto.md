# Idioma automático das respostas

Teste real, sem preferência de idioma, para confirmar que a resposta segue o
idioma da pergunta mesmo quando o artigo está em inglês.

## Configuração

- Modelo: `lfm3-1.7b`, Q4_K_M, GPU, contexto de 32.768 tokens.
- Artigo completo: *Attention Is All You Need* (em inglês).
- Prompt montado por `buildMessages`; nenhum histórico.
- Servidor local em `127.0.0.1:18087`.
- Artefato: `experiments/results/language-auto-smoke.json`.

## Resultados

| Pergunta | Idioma detectado | Resposta | Prompt | Conclusão |
|---|---|---|---:|---|
| Por que o artigo usa atenção em vez de recorrência? Responda em até 80 palavras. | pt-BR | Português | 10.347 | Seguiu a pergunta |
| Why does the paper use attention instead of recurrence? Answer in at most 80 words. | en | Inglês | 10.340 | Seguiu a pergunta |

Resposta em português:

> O artigo propõe o Transformer como alternativa aos RNNs porque as redes
> recorrentes são sequenciais, exigindo operações \(O(n)\) por camada e
> impedindo paralelização durante o treinamento. A atenção permite que cada
> posição relate a todas (ou uma janela) com um número constante de operações,
> reduzindo a complexidade computacional e permitindo maior paralelismo e
> treinamento mais rápido. Além disso, a atenção captura dependências longas sem
> precisar armazenar estados passados.

Resposta em inglês:

> The authors replace recurrence and convolutions with self-attention so that
> each position can attend to every other position directly, eliminating the
> O(n) sequential steps of RNNs and the growing path length of convolutions;
> this makes training much faster (parallelizable) and allows capturing
> long-range dependencies in constant time.

## Limitações

- O teste usou o modo **Artigo completo**. O caminho RAG compartilha o mesmo
  system prompt e o mesmo lembrete por pergunta, mas não foi medido com geração
  real neste experimento.
- O teste usou o LFM3-1.7B, não o 8B-A1B padrão.
- A validação com o Groq continua pendente de uma chave substituta; a chave
  exposta no diagnóstico anterior deve ser revogada.
