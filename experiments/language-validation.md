# Preferência de idioma

O XPI oferece **Português (Brasil)**, padrão, e **Inglês** em **Configurações → Assistente local → Idioma das respostas**. A instrução aparece no system e após cada pergunta, além do artigo completo. Um pedido explícito de outro idioma tem prioridade. A preferência é lida por pedido; mudar o idioma não reinicia o servidor nem reescreve respostas anteriores.

## Validação

- 48 testes TypeScript e 18 testes Python passaram; os testes de idioma cobrem artigo longo em inglês, continuações, troca de preferência, preservação dos turnos originais e rejeição de valores inválidos.
- [39 verificações nativas com servidor simulado](results/native-acceptance.json) passaram, incluindo seletor e envio da instrução depois do artigo.
- [28 verificações nativas com inferência real](results/native-languages.json) passaram, incluindo atualização sem preferência anterior, persistência ao reabrir configurações e ausência de anotações automáticas.
- O artigo completo em inglês foi *Attention Is All You Need*, extraído pelo Zotero: 15 páginas, 36.990 caracteres. A mesma conversa recebeu três respostas por modelo:

| Modelo Q4_K_M | Explicar trecho, preferência pt-BR | Pergunta em português, preferência en | Pergunta em inglês, preferência pt-BR |
|---|---|---|---|
| LFM2.5-2.6B | Português | Inglês | Português |
| LFM2.5-8B-A1B | Português | Inglês | Português |

Os seis textos foram inspecionados pelo Codex; nomes, títulos, siglas e termos técnicos podem permanecer no idioma original. O 2.6B usou o supervisor gerenciado na porta 18095, com fallback para GPU/CPU devido à VRAM ocupada. O 8B usou o servidor externo compatível já ativo na porta 8080; ele foi preservado. Nenhuma configuração ou biblioteca do perfil pessoal foi alterada. As configurações do perfil isolado foram restauradas e o servidor criado para o teste foi encerrado.

Uma [geração adicional em inglês](results/language-token-smoke.json), com pergunta em português e o artigo completo, confirmou **10.257 tokens** tanto no preflight quanto em `timings.prompt_n`, sem reutilização de prefixo. O lembrete entra na contagem normal de contexto.

A [integridade e ativação do XPI de distribuição](results/language-build-validation.json) foram verificadas pelo AddonManager no perfil isolado; o pacote instalado coincide com o arquivo de `dist/` e não contém o harness. Veja [o seletor nativo](../docs/images/native-language.png).

## Repetir e interpretar

Os comandos estão em [desenvolvimento](../docs/development.md#idioma-das-respostas). `scripts/smoke_runtime.ts` também aceita `LFM_SMOKE_LANGUAGE=pt-BR` ou `en`; use um novo `LFM_SMOKE_OUTPUT` para outra execução.

Essa validação cobre o idioma dessas amostras, sem garantir adesão em todas as perguntas. Não avalia a correção científica: os textos gerados ainda apresentam erros conceituais e matemáticos e não são respostas de referência. Os tempos variam com o contexto, a reutilização de prefixo e os outros aplicativos; não representam uma comparação controlada de modelos ou idiomas. A mudança no prompt exige uma nova pasta `LFM_RESULTS_DIR` para novas comparações de precisão. O baseline entregue permanece preservado.
