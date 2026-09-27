# Conferência das respostas de referência

Revisão assistida por Codex em 27/09/2026 sobre os PDFs **v1** fixados em `cases.json`, usando o texto integral extraído por Poppler. Os resumos de referência são paráfrases; não são respostas produzidas pelo modelo avaliado. Esta conferência não é avaliação humana independente.

Alguns números de seção inicialmente indicados em `cases.json` correspondem a versões posteriores dos papers. Os localizadores verificados para os PDFs efetivamente usados são os seguintes:

| Casos | Localizador no PDF usado | Conteúdo conferido |
|---|---|---|
| attention-definition | §3.2.1, p.4 | Produto query/key, divisão por √d_k, softmax e combinação dos values; justificativa ligada a magnitudes e gradientes. |
| attention-cross-section | §3.1 e §3.2.3, pp.3–5 | Máscara de posições futuras e deslocamento das saídas impedem acesso ao futuro. |
| attention-absent | Artigo inteiro, incluindo §6 | Avalia tradução e parsing; não apresenta resultado MMLU. |
| rmsnorm-definition | §3 e §4, pp.3–5 | RMSNorm remove recentramento e preserva invariância de escala; a normalização usa RMS. |
| rmsnorm-cross-section | §5, p.5; §6, experimentos | pRMSNorm estima RMS das primeiras p% unidades; hipótese i.i.d.; convergência e velocidade não são garantidas para qualquer fração/implementação. |
| rmsnorm-absent | §6 e artigo inteiro | Não reporta RTX 3070. Há medições com TITAN X Pascal, Tesla e GeForce RTX 2080 Ti (tabela 10); dizer que todo resultado usa TITAN X seria excessivo. |
| rope-definition | §3.2, pp.4–5 | Rotação de pares de dimensões em query/key codifica posição. |
| rope-cross-section | §3.1–3.3, pp.3–6 | Composição R_mᵀR_n faz o produto depender da diferença n−m. Decaimento é uma propriedade teórica discutida no paper, não monotonicidade garantida de toda atenção. |
| rope-absent | Artigo inteiro | Não apresenta LLaMA 3.1 ou sua avaliação MMLU. |
| lora-definition | §3, pp.3–4 | W₀ congelado; atualização BA com rank reduzido. Nesta v1, o método está na seção 3, não 4.1. |
| lora-cross-section | §3, p.4, “No Additional Inference Latency” | BA pode ser incorporado a W₀ antes da inferência; o texto desta v1 limita a latência de troca de adaptação a uma passagem forward do modelo. |
| lora-absent | Artigo inteiro | Não relata QLoRA ou resultados com pesos de 4 bits. |
| llada-definition | §2.1–2.2 | Preditor aprende tokens mascarados; geração reverte o mascaramento progressivamente. |
| llada-cross-section | §2.2, algoritmo 5 e apêndice B.3 | Remascara predições de menor confiança; ablações distinguem base e instruct, incluindo efeito de blocos semi-autoregressivos. |
| llada-absent | Artigo inteiro | Não apresenta a comparação Q4 de pesos/Q8 de KV solicitada. |

As perguntas sobre informações ausentes foram verificadas por leitura do escopo/experimentos e busca dos nomes e termos relevantes no texto integral. A ausência de resultado no paper deve ser reconhecida, mesmo quando o modelo conhece informação externa.

Para revisão final, confira também as fórmulas nas páginas renderizadas: a extração textual perde raízes, expoentes, ordem de símbolos e estrutura de tabelas. As respostas devem ser julgadas contra o paper, sem tratar erros de extração como nova evidência científica.

Foram conferidas visualmente a fórmula de pRMSNorm (p.5), as rotações e propriedades de RoPE (pp.4–5) e a confiança no algoritmo de LLaDA (p.16). A seção 3.3 de RoPE enuncia a propriedade geral de decaimento; repeti-la não foi penalizado como erro. Alegar decaimento **exponencial garantido para cada par** ou fornecer fórmulas inválidas continua sendo um problema distinto.
