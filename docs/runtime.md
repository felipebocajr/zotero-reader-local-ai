# Inferência local: GPU e fallback

## Iniciar pela interface do Zotero

Após preparar os arquivos, abra **Configurações → Assistente local → Escolher pasta…** e escolha a pasta do projeto. **Iniciar servidor** usa o modelo escolhido em Q4, a porta do endereço configurado e o contexto escolhido em **Contexto e conexão**. O status informa carregamento, disponibilidade e GPU inteira, GPU/CPU ou CPU. **Parar** encerra o supervisor e seu filho; **Reiniciar** aplica alterações e cancela pedidos em andamento.

**Iniciar automaticamente ao abrir o Zotero** é opcional e começa desativado. Salve a opção para que o plugin inicie o modelo no próximo startup, incluindo ao reabilitar o plugin. Salvar configurações não reinicia um modelo já carregado. O processo usa Python 3.12+ de 64 bits e as versões preparadas na pasta escolhida; não instala drivers ou baixa pesos.

O controle nativo está disponível em Linux x86_64 e Windows 10 22H2/Windows 11 x64. Usa Gecko `Subprocess`, com argumentos separados e nenhum shell. No Windows, o plugin procura `python3.exe`, `python.exe` e o launcher `py -3`; ARM64 é recusado com uma mensagem explícita. O plugin encerra somente os processos que iniciou. Se já houver um servidor no endereço, mostra que ele é externo e desabilita parada/reinício. Um servidor externo continua utilizável se o modelo, contexto e slot estiverem configurados corretamente.

O comando de parada gerenciada envia um byte de controle e fecha o pipe; isso evita depender apenas de EOF no Windows. Se o pipe não puder ser escrito, o fechamento continua sendo o sinal de parada.

No início gerenciado, `--managed --parent-pid` acrescenta dois sinais de encerramento: fechamento do pipe de controle e saída do processo Zotero. Ambos pedem ao supervisor que encerre seu filho, inclusive ao desativar o plugin ou fechar o Zotero. O estado `.runtime/server-<porta>.json` apenas informa progresso; seus PIDs nunca autorizam encerrar processos.

## Iniciar pelo terminal

O comando de uso é:

```bash
python3 scripts/serve.py
```

No Windows, use `py -3 scripts\serve.py` ou `python scripts\serve.py`. O restante dos comandos deste guia usa a forma Linux; troque apenas o interpretador e os separadores de caminho.

O modo `auto` mantém Q4_K_M, contexto padrão de 64.000, oito threads, um slot, cache K/V f16 e nenhum descarte automático de contexto. Tenta, nesta ordem:

1. CUDA com todas as camadas, sem ajuste de memória.
2. Após falta de VRAM, CUDA com distribuição ajustada entre GPU e CPU. O ajuste reserva aproximadamente 512 MiB de margem na GPU.
3. CPU quando a GPU está indisponível ou a segunda tentativa também falha por memória.

O runtime verifica dispositivos CUDA reais antes de escolher o backend. Modelo ausente, porta ocupada e outros erros não provocam fallback silencioso. A ausência do binário CUDA exige preparar os runtimes; não deve levar uma máquina com GPU a executar inadvertidamente em CPU.

O fallback não muda precisão dos pesos, tamanho de contexto ou precisão do cache. A memória da GPU e a RAM continuam limitadas; CPU também pode falhar por memória. Pela interface, **Reiniciar** aplica o contexto do plugin ao servidor. No terminal, mantenha o contexto do plugin igual ao `--context` do launcher.

## Escolha de modelo

`--model lfm2.5-8b-a1b` é o padrão. O LFM3-1.7B é a alternativa; o 2.6B permanece apenas como benchmark legado:

```bash
python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
python3 scripts/serve.py
python3 scripts/setup_runtime.py --model lfm3-1.7b --backend auto --precision Q4_K_M
python3 scripts/serve.py --model lfm3-1.7b
```

Selecione **LFM2.5-8B-A1B — padrão** ou **LFM3-1.7B — contexto de 256K** nas configurações do Zotero e clique em **Reiniciar** para trocar um servidor gerenciado. No terminal, encerre o servidor anterior antes de iniciar outro na mesma porta. O plugin recusa um alias diferente antes de enviar o artigo. Ele não baixa pesos nem troca o servidor apenas por salvar a seleção. O 2.6B não aparece no seletor; use `--model lfm2.5-2.6b` apenas para reproduzir o benchmark entregue.

Os modelos de produto (8B-A1B e LFM3-1.7B) usam contexto padrão de **64.000 tokens** e a mesma política GPU → GPU/CPU → CPU. O 8B-A1B aceita até 128.000 tokens e o LFM3-1.7B até 262.144; o 2.6B legado aceita 131.072. O 8B-A1B mantém todos os especialistas em memória, embora ative apenas parte deles por token; seus arquivos oficiais Q4_K_M, Q8_0 e F16 ocupam aproximadamente 5,16, 9,01 e 16,95 GB. O LFM3-1.7B ocupa aproximadamente 1,10, 1,85 e 3,47 GB nas mesmas precisões. Os hashes e a revisão estão fixados em `runtime.lock.json`; `--precision all` baixa apenas as precisões do modelo selecionado. O fallback conserva o modelo escolhido. O LFM3 usa o template `<think>` e exige llama.cpp b11960+; o raciocínio oculto fica em `reasoning_content` e não é exibido. O LFM3 foi validado em Linux/CUDA com inferência real e contagem de tokens; a aceitação nativa no Zotero e a validação em Windows ainda precisam ser registradas antes de tratá-lo como equivalente aos modelos anteriores.

## Embeddings locais

O modo padrão de contexto usa RAG: o artigo é dividido em chunks e apenas os trechos mais relevantes são enviados ao modelo. Os embeddings são gerados localmente por **Qwen3-Embedding-0.6B Q8_0** (639 MB, 1.024 dimensões, contexto de 32k, 100+ idiomas). A revisão e o SHA-256 estão em `runtime.lock.json`.

O `scripts/setup_runtime.py --backend auto` baixa o modelo de chat e o de embeddings. Para preparar apenas o chat, use `--no-embedding`; para escolher a precisão do embedding, `--embedding-precision Q8_0` ou `F16`.

O servidor é separado do chat e usa `--embedding --pooling last`:

```bash
python3 scripts/serve_embedding.py
# porta 18081; GPU primeiro, CPU em caso de falta de VRAM
```

O plugin inicia esse servidor sob demanda na primeira pergunta em modo de trechos, mantém o processo sob seu controle e o encerra ao desativar o plugin. Se já houver um servidor externo em `127.0.0.1:18081`, ele é detectado e nunca é parado ou adotado; o alias precisa ser `qwen3-embedding-0.6b`.

A instrução fixa `Given a web search query, retrieve relevant passages that answer the query` é aplicada somente à pergunta; os documentos são vetorizados com o heading e o texto do chunk, sem instrução. Os vetores ficam em memória, indexados pela assinatura do PDF, modelo e dimensões. Um artigo com 80 chunks ocupa cerca de 320 KB; não há banco vetorial. O texto do artigo não é gravado em preferências, status ou logs.

O orçamento de entrada é de 16.000 tokens no servidor local e 5.500 no Groq. O plugin mantém chunks com similaridade de pelo menos **75% do melhor chunk**, com mínimo de **4** e máximo de **12**; o orçamento de tokens ainda é o limite final. O trecho selecionado e seus vizinhos da mesma seção entram sempre. A interface não expõe seletor de contexto.

## Preparação e modos fixos

```bash
python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
```

O instalador prepara CUDA, suas bibliotecas e CPU nas versões de `runtime.lock.json`. Depois dos downloads, o fluxo funciona sem internet. O runtime Linux foi validado em x86_64 com NVIDIA; o runtime Windows x64 está implementado, mas a aceitação nativa com GPU ainda precisa ser registrada. Use `--backend cpu` para baixar somente CPU.

Linux usa CUDA 12.8. Windows usa CUDA 12.4, que mantém compatibilidade com Windows 10, drivers mais antigos e GPUs Pascal–Hopper; exige driver NVIDIA 551.61 ou superior. GPUs Blackwell/RTX 50 não são cobertas pelo runtime CUDA 12.4 e recorrem à CPU. Windows ARM64 e Windows 32 bits são recusados.

A extração ocorre numa pasta temporária antes de publicar os arquivos por renomeação atômica. No Linux, uma reinstalação mantém intactas as bibliotecas já mapeadas por processos em execução. No Windows, cada combinação de tag e hashes é publicada em `.runtime/runtimes/llama-*-b12250-*`; um servidor em execução continua usando sua pasta versionada até ser reiniciado, e nenhum `.exe`/`.dll` carregado é sobrescrito.

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

No llama.cpp b12250, a primeira tentativa usa `--n-gpu-layers all --fit off`. A segunda usa `--n-gpu-layers auto --fit on --fit-target 512`, com `--ctx-size` positivo e `--fit-ctx` iguais ao contexto solicitado. O ajuste muda a distribuição de tensores, incluindo a possibilidade de manter partes de camadas em CPU. CPU usa `--device none --no-op-offload`.

A semântica foi conferida na [documentação do servidor](https://github.com/ggml-org/llama.cpp/blob/ae4893a092e060cfbd4979600bf3c1e48a710874/tools/server/README.md) e no [código de ajuste de memória](https://github.com/ggml-org/llama.cpp/blob/ae4893a092e060cfbd4979600bf3c1e48a710874/common/fit.cpp) da versão fixada. Ao atualizar o runtime, confira esse contrato e valide novamente o contexto efetivo com `/props` e inferência real.

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
