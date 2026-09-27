# Validação da opção LFM2.5-8B-A1B

Validação funcional em Linux x86_64, Zotero 10.0.3, Ryzen 7 5700X e RTX 3070 de 8 GiB. O modelo foi adicionado como alternativa ao 2.6B; não foi realizada uma comparação de qualidade entre eles.

## Modelo e runtime

- Pesos oficiais `LiquidAI/LFM2.5-8B-A1B-GGUF`, revisão `49c14831707011e64d70b2ebd8462ba08d608434`, Q4_K_M, 5.155.564.768 bytes. Download e SHA-256 verificados pelo instalador.
- llama.cpp b11206, commit `2b129ccfa03aea330d2d9ac4650a10de393dbe3a`, mesmo runtime usado com o 2.6B. A arquitetura `lfm2_moe` carregou e executou inferência real.
- Contexto solicitado e efetivo: 32.768 tokens, um slot e cache K/V f16; geração reservada: 4.096 tokens.
- Limite de contexto do 8B-A1B: 128.000, confirmado no `config.json` oficial e em `n_ctx_train` do GGUF carregado. O instalador também fixa arquivos Q8_0 e F16, mas apenas Q4 foi baixado e executado.

Fontes primárias: [ficha do modelo](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B), [configuração oficial](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B/blob/main/config.json) e [pesos oficiais](https://huggingface.co/LiquidAI/LFM2.5-8B-A1B-GGUF/tree/49c14831707011e64d70b2ebd8462ba08d608434). As revisões e hashes usados estão em [`runtime.lock.json`](../runtime.lock.json).

## Inferência e memória

Com outros aplicativos ocupando a GPU, havia aproximadamente 2,2 GiB livres antes do carregamento. O modo automático tentou todas as camadas na GPU, recebeu erro de falta de VRAM e iniciou a distribuição compartilhada. O servidor registrou tensores transferidos para CPU; durante uma inferência completa, o processo manteve aproximadamente 2.214 MiB na GPU. O pico RSS registrado pelo kernel após o teste nativo foi de 5.619.500 kB. Essas medidas incluem buffers e páginas mapeadas; não são o tamanho dos pesos nem uma medição isolada do consumo incremental de RAM física.

O teste de artigo completo usou as 15 páginas de *Attention Is All You Need*, mantendo referências e legendas. A contagem do template mais BOS foi de **10.038 tokens**, igual a `timings.prompt_n`. O pedido sem reutilização de prefixo terminou em **18,88 s**, com primeira resposta visível em **16,38 s**. O runtime registrou 6,91 s de processamento de contexto e 56,60 tokens/s de geração, incluindo raciocínio oculto. Uma repetição confirmou a contagem e registrou 18 amostras de VRAM enquanto o processo de inferência estava ativo.

Esses tempos validam o funcionamento; outros aplicativos e outro llama-server permaneceram na GPU. Não são uma comparação controlada com o 2.6B nem garantem essa latência em outras condições. O teste não avalia correção científica: as respostas continuam sujeitas a erros, inclusive em detalhes de fórmulas e complexidade computacional. Não foi necessário encerrar aplicativos do usuário para executar o teste.

## Integração no Zotero

As **35 verificações simuladas** passaram, incluindo seletor com duas opções, limite por modelo e mensagem quando o servidor carrega um alias diferente. As **oito verificações com o 8B-A1B real** passaram: escolha salva nas preferências, reabertura mantendo a escolha, pergunta, continuação com dois turnos, botões de salvar específicos de cada resposta e ausência de anotações automáticas.

O XPI de distribuição foi instalado pelo AddonManager no perfil isolado e ficou ativo, sem harness. A cópia instalada coincide em SHA-256 com o pacote gerado. Os testes TypeScript (27) e Python (15), a checagem de tipos e o build passaram.

## Evidências e repetição

- [`results/lfm8b-smoke.json`](results/lfm8b-smoke.json): resposta, tokens e tempos do artigo completo.
- [`results/lfm8b-validation.json`](results/lfm8b-validation.json): versão/hash, tentativas de fallback, contexto real, memória e repetição com amostras.
- [`results/native-lfm8b.json`](results/native-lfm8b.json): verificações e respostas pelo popup real.
- [`results/model-build-validation.json`](results/model-build-validation.json): hash do XPI e ativação nativa.

Para repetir sem alterar os resultados entregues, inicie o servidor numa porta livre e escolha outro caminho de saída:

```bash
python3 scripts/serve.py --model lfm2.5-8b-a1b --port 18091
```

Em outro terminal:

```bash
LFM_SERVER_URL=http://127.0.0.1:18091 LFM_SMOKE_MODEL=lfm2.5-8b-a1b LFM_SMOKE_BACKEND=auto LFM_SMOKE_OUTPUT=.runtime/repeat-lfm8b-smoke.json node --experimental-strip-types scripts/smoke_runtime.ts
```

O benchmark de F16/Q8_0/Q4_K_M existente permanece do **2.6B**, com distribuição fixa. A escolha de modelo maior não modifica seus resultados nem substitui automaticamente os pesos durante fallback.
