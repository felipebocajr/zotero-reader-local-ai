# Contexto padrão de 64.000 tokens — versão 0.1.1

O plugin, as preferências nativas e o launcher usam **64.000 tokens** por padrão, exatamente metade dos 128.000 do LFM2.5-8B-A1B. A reserva permanece em 4.096; o orçamento de entrada é 59.904 tokens. Preferências de contexto já salvas são preservadas, e o servidor aplica mudanças após reinício.

A comparação de precisões e a medição de memória no carregamento agora passam 32.768 explicitamente. Os resultados anteriores não foram reexecutados ou substituídos.

## Pacote e interface

`npm run check`, os 52 testes TypeScript, os 18 testes de runtime e `npm run build` passaram. O XPI `reader-local-ai-0.1.1.xpi` foi instalado pelo AddonManager no Zotero 10.0.3, somente no perfil isolado. O arquivo instalado é idêntico ao pacote de distribuição, que não contém o harness.

Oito verificações nativas confirmaram a ativação, o padrão de 64.000 nas preferências e na interface, a reserva de geração, a edição/persistência de um contexto personalizado e a restauração do padrão ao limpar essa preferência. As configurações originais do perfil de teste foram restauradas.

## Inferência real e limite da validação GPU

Um servidor separado foi iniciado com `python3 scripts/serve.py --model lfm2.5-8b-a1b --port 18096`, sem passar `--context`. Confirmou 64.000 tokens, um slot e K/V f16. O teste usou todas as 15 páginas de *Attention Is All You Need*.

A GPU tinha pouca memória disponível, com outros aplicativos e o servidor original do Zotero ainda abertos. Uma primeira tentativa chegou a iniciar em GPU/CPU, mas encontrou falta de VRAM durante a geração e interrompeu o pedido. No ensaio seguinte, as tentativas GPU inteira e GPU/CPU falharam por memória no carregamento; o supervisor iniciou CPU conservando o modelo, o contexto e a precisão do cache.

A inferência em CPU concluiu em aproximadamente **194,63 s**. Os **10.301 tokens** da contagem prévia foram iguais a `timings.prompt_n`; a geração terminou com resposta final. O pico RSS do processo registrado pelo kernel foi de aproximadamente 8.625 MiB. RSS inclui páginas mapeadas e buffers e não representa consumo incremental de RAM física isolado.

Esses dados verificam o novo padrão e o fallback. Não constituem uma comparação controlada de desempenho ou qualidade, nem validam desempenho de GPU inteira/GPU compartilhada com 64.000 tokens. O servidor e o Zotero de teste foram encerrados; o servidor original foi preservado.

## Evidências

- [`results/context-default-build-validation.json`](results/context-default-build-validation.json): integridade, testes e instalação do pacote.
- [`results/native-install-0.1.1.json`](results/native-install-0.1.1.json): ativação pelo AddonManager.
- [`results/context-default-native.json`](results/context-default-native.json): verificações das preferências nativas.
- [`results/context-default-runtime.json`](results/context-default-runtime.json): tentativas de GPU/fallback, contexto efetivo, contagem, resposta final e amostras de memória.
