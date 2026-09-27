# Inferência local: GPU e fallback

## Iniciar pela interface do Zotero

Após preparar os arquivos, abra **Configurações → Assistente local → Escolher pasta…** e escolha a pasta do projeto. **Iniciar servidor** usa o modelo escolhido em Q4, a porta do endereço configurado e o contexto escolhido em **Contexto e conexão**. O status informa carregamento, disponibilidade e GPU inteira, GPU/CPU ou CPU. **Parar** encerra o supervisor e seu filho; **Reiniciar** aplica alterações e cancela pedidos em andamento.

**Iniciar automaticamente ao abrir o Zotero** é opcional e começa desativado. Salve a opção para que o plugin inicie o modelo no próximo startup, incluindo ao reabilitar o plugin. Salvar configurações não reinicia um modelo já carregado. O processo usa Python 3 do sistema e as versões preparadas na pasta escolhida; não instala drivers ou baixa pesos.

O controle nativo está disponível em Linux. Usa Gecko `Subprocess`, com argumentos separados e nenhum shell. O plugin encerra somente os processos que iniciou. Se já houver um servidor no endereço, mostra que ele é externo e desabilita parada/reinício. Um servidor externo continua utilizável se o modelo, contexto e slot estiverem configurados corretamente.

No início gerenciado, `--managed --parent-pid` acrescenta dois sinais de encerramento: fechamento do pipe de controle e saída do processo Zotero. Ambos pedem ao supervisor que encerre seu filho, inclusive ao desativar o plugin ou fechar o Zotero. O estado `.runtime/server-<porta>.json` apenas informa progresso; seus PIDs nunca autorizam encerrar processos.

## Iniciar pelo terminal

O comando de uso é:

```bash
python3 scripts/serve.py
```

O modo `auto` mantém Q4_K_M, contexto 32.768, oito threads, um slot, cache K/V f16 e nenhum descarte automático de contexto. Tenta, nesta ordem:

1. CUDA com todas as camadas, sem ajuste de memória.
2. Após falta de VRAM, CUDA com distribuição ajustada entre GPU e CPU. O ajuste reserva aproximadamente 512 MiB de margem na GPU.
3. CPU quando a GPU está indisponível ou a segunda tentativa também falha por memória.

O runtime verifica dispositivos CUDA reais antes de escolher o backend. Modelo ausente, porta ocupada e outros erros não provocam fallback silencioso. A ausência do binário CUDA exige preparar os runtimes; não deve levar uma máquina com GPU a executar inadvertidamente em CPU.

O fallback não muda precisão dos pesos, tamanho de contexto ou precisão do cache. A memória da GPU e a RAM continuam limitadas; CPU também pode falhar por memória. Pela interface, **Reiniciar** aplica o contexto do plugin ao servidor. No terminal, mantenha o contexto do plugin igual ao `--context` do launcher.

## Escolha de modelo

`--model lfm2.5-2.6b` é o padrão. A opção maior usa `--model lfm2.5-8b-a1b` tanto na preparação quanto no servidor:

```bash
python3 scripts/setup_runtime.py --model lfm2.5-8b-a1b --backend auto --precision Q4_K_M
python3 scripts/serve.py --model lfm2.5-8b-a1b
```

Selecione **LFM2.5-8B-A1B — maior capacidade** nas configurações do Zotero e clique em **Reiniciar** para trocar um servidor gerenciado. No terminal, encerre o servidor anterior antes de iniciar outro na mesma porta. O plugin recusa um alias diferente antes de enviar o artigo. Ele não baixa pesos nem troca o servidor apenas por salvar a seleção.

Ambos usam contexto inicial de 32.768 tokens e a mesma política GPU → GPU/CPU → CPU. O modelo maior mantém todos os seus especialistas em memória, embora ative apenas parte deles por token. Seus arquivos oficiais Q4_K_M, Q8_0 e F16 ocupam aproximadamente 5,16, 9,01 e 16,95 GB, respectivamente. Os hashes e a revisão estão fixados em `runtime.lock.json`; `--precision all` baixa apenas as precisões do modelo selecionado. O limite aceito por `--context` é 128.000 para o 8B-A1B e 131.072 para o 2.6B. O fallback conserva o modelo escolhido.

## Preparação e modos fixos

```bash
python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
```

O instalador prepara CUDA, suas bibliotecas e CPU nas versões de `runtime.lock.json`. Depois dos downloads, o fluxo funciona sem internet. Este pacote foi validado em Linux x86_64 com NVIDIA; outros aceleradores ainda precisam de um backend validado.

A extração ocorre numa pasta temporária antes de publicar os arquivos por renomeação atômica. Uma reinstalação mantém intactas as bibliotecas já mapeadas por processos em execução.

Para forçar CPU, GPU inteira ou uma quantidade fixa de camadas:

```bash
python3 scripts/serve.py --backend cpu
python3 scripts/serve.py --backend cuda --gpu-layers -1
python3 scripts/serve.py --backend cuda --gpu-layers 24
```

Esses modos explícitos não fazem fallback nem ajustam automaticamente a distribuição. Isso mantém comparações experimentais com a mesma configuração entre precisões. `--binary` também seleciona execução fixa. Sem `--gpu-layers`, `--backend cuda` coloca todas as camadas na GPU.

## Durante a execução

O terminal informa cada tentativa e quando o servidor está pronto. O modo automático publica estado transitório em `.runtime/server-8080.json` (ou a porta escolhida): modelo, precisão, backend, contexto, PID do supervisor, PID do filho e tentativas. `gpuLayers` registra a configuração solicitada (`all`, `auto` ou `0`), não uma medição de utilização ou do número final de camadas. Nenhum prompt ou histórico é registrado nesse arquivo.

Uma falta de VRAM pode ocorrer ao carregar o modelo ou durante uma pergunta. O supervisor encerra o filho que falhou e tenta o próximo modo. Se a pergunta já estava em andamento, o popup apresenta erro de interrupção. Espere o servidor ficar pronto e repita a pergunta; não há reenvio automático nem continuação de uma resposta parcial.

`Ctrl+C` encerra o supervisor e seu filho. O modo automático verifica que o contexto efetivo e o slot único continuam iguais aos solicitados. O modelo não perde páginas para caber na memória.

## Contrato do runtime fixado

No llama.cpp b11206, a primeira tentativa usa `--n-gpu-layers all --fit off`. A segunda usa `--n-gpu-layers auto --fit on --fit-target 512`, com `--ctx-size` positivo e `--fit-ctx` iguais ao contexto solicitado. O ajuste muda a distribuição de tensores, incluindo a possibilidade de manter partes de camadas em CPU. CPU usa `--device none --no-op-offload`.

A semântica foi conferida na [documentação do servidor](https://github.com/ggml-org/llama.cpp/blob/2b129ccfa03aea330d2d9ac4650a10de393dbe3a/tools/server/README.md) e no [código de ajuste de memória](https://github.com/ggml-org/llama.cpp/blob/2b129ccfa03aea330d2d9ac4650a10de393dbe3a/common/fit.cpp) da versão fixada. Ao atualizar o runtime, confira esse contrato e valide novamente o contexto efetivo com `/props` e inferência real.

## Verificação

```bash
npm run test:runtime
```

Os testes verificam a ordem dos modos, preservação de contexto/pesos/cache, distribuição fixa para experimentos, cancelamento e rejeição de erros não relacionados à GPU. Os testes reais de uso ficam separados da comparação de precisões; consulte [a validação do fallback](../experiments/runtime-fallback-validation.md).

Para repetir uma pergunta com todas as páginas de Attention sem sobrescrever a evidência original, inicie o servidor automático numa porta livre e execute:

```bash
python3 scripts/serve.py --port 18088
```

Em outro terminal:

```bash
LFM_SERVER_URL=http://127.0.0.1:18088 LFM_SMOKE_BACKEND=auto LFM_SMOKE_OUTPUT=.runtime/repeat-auto-smoke.json node --experimental-strip-types scripts/smoke_runtime.ts
```

O teste exige resposta final e confere a contagem prévia de tokens contra `timings.prompt_n`. Para F16, prepare esse peso, inicie com `--precision F16` e informe também `LFM_SMOKE_PRECISION=F16` no teste. Apenas tamanho do arquivo ou o nome de um binário CUDA não provam execução na GPU: confira a VRAM do processo durante uma inferência real.

Para testar o 8B-A1B, acrescente `--model lfm2.5-8b-a1b` ao servidor e `LFM_SMOKE_MODEL=lfm2.5-8b-a1b` ao teste, escolhendo outro arquivo com `LFM_SMOKE_OUTPUT`. Esses resultados não fazem parte da comparação de precisões do 2.6B.
