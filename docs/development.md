# Desenvolvimento e validação nativa

Nunca use a biblioteca pessoal nos testes. Os scripts verificam o diretório de dados antes de instalar/importar. O perfil é `.runtime/zotero-profile`, com biblioteca `.runtime/zotero-data`; sincronização automática e API HTTP do Zotero ficam desativadas.

## Preparar

```bash
npm ci
npm run build
python3 scripts/prepare_papers.py
python3 scripts/setup_dev.py
```

## Windows x64

O fluxo é o mesmo em Windows 10 22H2 ou Windows 11 x64, com Python 3.12+ de 64 bits. Use PowerShell e `py -3` (ou `python`) no lugar de `python3`:

```powershell
npm ci
npm run check
npm test
npm run test:runtime
npm run build
py -3 scripts\prepare_papers.py
py -3 scripts\setup_dev.py
```

`npm run build` e `test:runtime` usam `scripts/run_python.mjs`, que procura `python`, `py -3` e `python3`; defina `PYTHON` para indicar um interpretador específico. O instalador publica runtimes Windows em `.runtime\runtimes\...` e o harness usa `tasklist.exe` para confirmar que os processos antigos foram encerrados. `scripts/stop_dev.py` é específico de Linux; no Windows, feche apenas a janela do Zotero do perfil isolado pelo Gerenciador de Tarefas. `prepare_papers.py` requer Poppler (`pdftotext` e `pdfinfo`) no `PATH`; se os PDFs já estiverem em `experiments\data`, essa etapa pode ser pulada.

O RDP e o perfil isolado continuam em loopback. Nunca instale o XPI de desenvolvimento no perfil pessoal. A validação nativa Windows deve registrar evidência separada; o suporte Linux não prova o comportamento de `Subprocess`, pipes, caminhos ou DLLs no Windows.

Abra esse Zotero em outro terminal:

```bash
zotero -no-remote -profile "$PWD/.runtime/zotero-profile" -ZoteroDebugText -purgecaches --start-debugger-server 18085 > .runtime/zotero-dev.log 2>&1
```

No Windows, o caminho padrão do executável é usado neste exemplo; ajuste-o se o Zotero estiver instalado em outro local:

```powershell
& "$env:ProgramFiles\Zotero\zotero.exe" -no-remote -profile "$PWD\.runtime\zotero-profile" -ZoteroDebugText -purgecaches --start-debugger-server 18085 *> .runtime\zotero-dev.log
```

O debugger Gecko escuta somente em loopback neste perfil. O cliente de teste usa esse protocolo para carregar scripts privilegiados; não é um componente do plugin.

Com o Zotero aberto:

```bash
python3 scripts/rdp.py --file scripts/install_dev.js
```

Esse comando instala `.runtime/dev-reader-local-ai.xpi` pelo **AddonManager**, verifica ativação e grava `.runtime/install-result.json`. O XPI de desenvolvimento inclui um harness que importa um PDF de teste somente na biblioteca isolada, abre o leitor e verifica a extração completa. O XPI em `dist/` não inclui esse harness.

## Interface com resposta simulada

Em um terminal separado:

```bash
python3 scripts/mock_server.py
```

Depois:

```bash
python3 scripts/rdp.py --file scripts/zotero-ui-tests.js
```

Os testes usam o leitor real e suas seleções temporárias, sem salvar anotações. Verificam as ações, foco, streaming sem raciocínio, conversa, independência das perguntas, modo de artigo completo, cancelamento, erros, posição, o botão Expandir/Restaurar, o redimensionamento por arrasto e a movimentação pelo cabeçalho do popup. A parte final alterna para trechos e confere o aviso de recuperação. Evidências ficam em `experiments/results/native-acceptance.json`; capturas de tela ficam em `.runtime/native-popup-*.png`.

Para validar somente o RAG, com o mock em `18080` e o perfil isolado:

```bash
python3 scripts/rdp.py --file scripts/zotero-embedding-tests.js
python3 scripts/rdp.py --file scripts/zotero-rag-tests.js
```

O primeiro verifica o servidor gerenciado, 1.024 dimensões e a similaridade cross-language; grava `experiments/results/native-embedding.json`. O segundo verifica o prompt com trechos, a ausência do artigo completo e o aviso no popup; grava `experiments/results/native-rag.json`.

Os testes simulados verificam integração e protocolo. A qualidade e a velocidade da LFM são avaliadas com o runtime real, separadamente.

## RAG e embeddings

O contexto padrão é recuperado, não o artigo completo. `src/chunking.ts` divide o texto com `chunkSize=1200`, overlap de 160 caracteres e a hierarquia `["\n\n", ". ", ".\n", "\n", " ", ""]`; headings detectados viram fronteiras de seção. `src/embeddings.ts` fala com o servidor local OpenAI-compatible; `src/retrieval.ts` embeda os chunks com heading, embeda a pergunta com a instrução fixa em inglês, mantém o chunk do trecho selecionado e vizinhos da mesma seção, remove referências e seleciona chunks com score ≥75% do melhor, entre 4 e 12, limitados pelo orçamento de tokens.

`src/embedding-runtime.ts` inicia sob demanda o `scripts/serve_embedding.py` em `127.0.0.1:18081`, com Qwen3-Embedding-0.6B Q8_0, `--embedding --pooling last` e fallback GPU → CPU. O processo é propriedade do plugin; um servidor externo é detectado e nunca é parado. Vetores ficam em memória, indexados pela assinatura do PDF, modelo e dimensões; não há banco vetorial.

O modelo é baixado por `scripts/setup_runtime.py --backend auto` (Q8_0, 639 MB). Use `--no-embedding` para pular ou `--embedding-precision F16` para o controle de qualidade. O setup baixa chat e embeddings por padrão.

Testes:

- `tests/chunking.test.ts`: parágrafo, frase, linha, palavra, caractere, overlap, headings, form feeds e cobertura dos 7 artigos.
- `tests/embeddings.test.ts`: lote, normalização, cosseno, loopback e erros HTTP.
- `tests/retrieval.test.ts`: âncora, orçamento, cache de documentos e prompt de trechos.
- `tests/embedding-runtime.test.ts`: início único, servidor externo, projeto ausente e modelo divergente.
- `scripts/embedding_benchmark.ts`: hit@k/MRR com `experiments/cases.json`; grava `experiments/results/embedding-retrieval-qwen3-0.6b-zotero.json`. Não substitui o benchmark de precisão.
- `scripts/retrieval_smoke.ts`: recuperação real com o Attention e o servidor local.
- `scripts/zotero-embedding-tests.js`: servidor gerenciado, 1.024 dimensões e cosseno cross-language no perfil isolado.
- `scripts/zotero-rag-tests.js`: popup com trechos, aviso de contagem e ausência do artigo completo.

No texto real do Zotero, o splitter gerou 284 chunks em 5 artigos, 100% em fronteiras naturais. O benchmark de recuperação com 10 casos não-ausentes ficou em 9/10 no top 5, 10/10 no top 12 e MRR 0,777 com instrução, no backend GPU. O único caso fora do top 5 ficou em 10º; não há evidência para adicionar reranker.

O modo **Artigo completo** continua explícito nas preferências e envia todas as páginas. O benchmark de precisão entregue usa esse caminho; não o sobrescreva com resultados de RAG.

## Provedor Groq

`tests/groq.test.ts` usa um `fetch` simulado para verificar a requisição OpenAI-compatible, o streaming, o descarte de raciocínio, os erros 401/429/404/5xx, o limite de contexto e a recusa de respostas incompletas. Nenhuma chave real é usada.

`scripts/zotero-groq-pane-tests.js`, executado no perfil isolado com o RDP, verifica os controles nativos: provedor local por padrão, campos do Groq ocultos, troca de provedor, persistência da chave/modelo, endpoint fixo `https://api.groq.com/openai/v1`, estado externo e restauração do modelo local. O teste também não acessa a rede; ele grava `experiments/results/native-groq-pane.json`.

No Groq, o contexto é estimado de forma conservadora (aproximadamente 3,5 caracteres por token) porque a API não expõe `/apply-template` nem `/tokenize`. No modo padrão, somente os trechos recuperados são enviados; o orçamento é de 5.500 tokens de entrada, dentro do ITPM de 7.000 da conta free. O modo **Artigo completo** envia todas as páginas e exige um limite maior; se a estimativa com a reserva de geração exceder o contexto configurado, o plugin recusa antes do envio e não corta o artigo. O modelo padrão é `openai/gpt-oss-120b`; modelos de raciocínio recebem `reasoning_effort: "low"` para preservar a reserva da resposta. A chave fica nas preferências do Zotero em texto puro neste protótipo e nunca deve ser gravada em logs, status ou artefatos de experimento.

Para o teste real, instale o XPI, abra **Configurações → Assistente local**, escolha **Groq (API)**, informe a chave e o modelo e salve. Depois abra um PDF e faça uma pergunta; a primeira chamada também valida a chave e o modelo.

## Idioma das respostas

Depois da suíte simulada, com Q4 dos dois modelos preparado:

```bash
python3 scripts/rdp.py --file scripts/zotero-language-tests.js
```

O teste abre o seletor nativo, verifica o padrão `en` num perfil sem preferência salva e a persistência ao reabrir a janela. Com o artigo completo em inglês, gera uma explicação em inglês, troca para português (Brasil) com uma pergunta em português e volta para inglês com uma pergunta em inglês na mesma conversa. Faz esse fluxo com ambos os modelos; o idioma não exige reiniciar o servidor. Revise os textos em `experiments/results/native-languages-en-default.json`: verificações de interface/protocolo não substituem a inspeção do idioma real.

O teste usa a porta 18095 e encerra somente o runtime que iniciou. Se já houver um servidor 8B compatível na porta 8080 (um slot e contexto 32.768), aproveita-o como servidor externo e o preserva. Nenhuma anotação é criada, e as preferências do perfil isolado são restauradas. Capturas ficam em `.runtime/native-language-*.png`.

`responseLanguage` é lido no início de cada pedido; a instrução fica no system e após cada pergunta. Ela permite outro idioma quando solicitado explicitamente. Os lembretes fazem parte da contagem real de tokens, e perguntas/respostas originais permanecem no histórico e no salvamento. Essa alteração muda o prompt: novas comparações exigem uma pasta separada `LFM_RESULTS_DIR`.

## Salvar respostas nas anotações

Com o mesmo servidor simulado e o perfil isolado, execute:

```bash
python3 scripts/rdp.py --file scripts/zotero-annotation-tests.js
```

O teste salva respostas específicas de uma continuação como anotações nativas, confirma o conteúdo e a posição no PDF, a atualização da aba de anotações, proteção contra duplicatas, falhas e tentativas seguintes, independência após nova pergunta e preservação após fechar o leitor. Somente a biblioteca isolada recebe as anotações de teste. A evidência fica em `experiments/results/native-annotations.json`, e a captura em `.runtime/native-annotations-popup.png`.

Para conferir a persistência em disco, instale o XPI de distribuição com `scripts/install_release.js`, encerre apenas o perfil com `scripts/stop_dev.py`, abra novamente com o mesmo comando de desenvolvimento e execute:

```bash
python3 scripts/rdp.py --file scripts/zotero-annotation-persistence.js
```

Esse script relê as anotações pela API interna num processo novo e verifica a aba de anotações e a ativação do XPI sem harness. O teste de interface usa eventos confiáveis do Gecko para acionar o botão com Enter; o plugin trata Enter e Espaço diretamente para impedir que os atalhos do leitor interceptem a ação.

## Renderização de Markdown e LaTeX

Com o perfil isolado e o servidor simulado, execute:

```bash
python3 scripts/rdp.py --file scripts/zotero-markdown-tests.js
```

O teste verifica títulos, negrito, itálico, listas, código, MathML no mesmo texto, streaming, bloqueio de HTML/imagens remotas e a resposta original preservada no comentário da anotação. A aba de anotações exibe uma projeção formatada e revela o editor nativo com o texto original ao editar. Resultados em `experiments/results/native-markdown.json`; capturas em `.runtime/native-markdown-popup.png` e `.runtime/native-markdown-annotation.png`.

Para conferir a persistência, instale o XPI de distribuição com `scripts/install_release.js`, encerre somente o perfil isolado, abra-o novamente e execute `python3 scripts/rdp.py --file scripts/zotero-markdown-persistence.js`. O teste confirma que a fonte permanece intacta e a visualização formatada reaparece após o reinício.

O renderizador `src/markdown.ts` usa markdown-it fixado e empacotado com `html:false`, sem criar imagens ou links navegáveis. Sua regra inline reconhece fórmulas antes de Markdown tratar barras e índices; `src/math.ts` permanece responsável pela saída MathML segura. `src/zotero-math.ts` projeta respostas salvas sem editar o comentário original. O XPI inclui as licenças das bibliotecas e dependências empacotadas.

## Renderização de LaTeX

Com o perfil isolado e o servidor simulado atualizado, após terminar a suíte de interface:

```bash
python3 scripts/rdp.py --file scripts/zotero-math-tests.js
```

O teste cobre MathML durante streaming, equações com índices/limites, frações e raízes, texto LaTeX exato no comentário salvo, visualização na aba de anotações, edição no campo nativo, fórmulas inválidas, HTML do modelo e limpeza ao desativar/reabilitar. Somente a biblioteca isolada recebe a anotação do teste. Resultados em `experiments/results/native-math.json`; capturas em `.runtime/native-math-popup.png` e `.runtime/native-math-annotation.png`.

O pacote inclui KaTeX fixado e sua licença MIT. `src/math.ts` gera MathML nativo, escapando toda a prosa e bloqueando comandos que carreguem recursos ou HTML. `src/zotero-math.ts` acrescenta uma visualização separada para comentários da IA; nunca substitui o DOM do contenteditable nem grava HTML gerado. Fórmulas longas usam rolagem horizontal, e sintaxe inválida permanece legível. O parser decodifica uma camada de barras duplicadas apenas em fórmulas delimitadas dessa maneira; a resposta original permanece no histórico e no salvamento.

As [opções oficiais do KaTeX](https://katex.org/docs/options.html) documentam a saída `mathml`, o bloqueio de comandos por `trust:false` e os limites de expansão/tamanho. Os limites e a ausência de recursos externos também são verificados pelos testes do projeto.

Para validar também a instrução com o modelo real, inicie um servidor numa porta separada e execute:

```bash
LFM_SERVER_URL=http://127.0.0.1:18093 LFM_SMOKE_BACKEND=auto LFM_SMOKE_QUESTION='Explique a atenção por produto escalar escalonado e apresente sua fórmula em LaTeX.' LFM_SMOKE_OUTPUT=.runtime/repeat-math-smoke.json node --experimental-strip-types scripts/smoke_runtime.ts
```

A instrução de LaTeX modifica o prompt. Novas comparações de precisão exigem outra pasta `LFM_RESULTS_DIR`; não misture os resultados anteriores com esse prompt.

## Fluxo completo com o modelo real

Pare o servidor simulado. Após a comparação experimental terminar, inicie o Q4 numa porta de teste separada:

```bash
python3 scripts/serve.py --port 18080
```

Então execute:

```bash
python3 scripts/rdp.py --file scripts/zotero-real-model.js
```

O script importa três papers na biblioteca isolada e faz quatro perguntas reais pelo popup, incluindo uma continuação, uma que usa outra seção e uma sem resposta no artigo. Salva respostas e tempos em `experiments/results/native-model.json`, com capturas em `.runtime/native-model-*.png`. Não execute outro modelo ao mesmo tempo que o benchmark: a disputa de recursos distorceria os tempos.

Para validar o XPI de distribuição sem harness, execute `python3 scripts/rdp.py --file scripts/install_release.js` no perfil isolado. O script lê a versão de `addon/manifest.json` e grava a evidência em `experiments/results/native-install-<versão>.json`.

Após alterar o código:

```bash
npm run check
npm test
npm run test:runtime
npm run build
python3 scripts/setup_dev.py
python3 scripts/rdp.py --file scripts/install_dev.js
```

Para encerrar apenas o Zotero desse perfil:

```bash
python3 scripts/stop_dev.py
```

Não use `pkill zotero`, nem copie arquivos para o perfil pessoal. Pare o servidor simulado com `Ctrl+C`. O debugger e o harness nunca devem ser habilitados no perfil pessoal.

## Opção 8B-A1B com o modelo real

Após terminar a suíte simulada, mantenha o perfil isolado aberto e prepare/inicie o modelo maior numa porta separada:

```bash
python3 scripts/setup_runtime.py --model lfm2.5-8b-a1b
python3 scripts/serve.py --model lfm2.5-8b-a1b --port 18091
```

Em outro terminal:

```bash
python3 scripts/rdp.py --file scripts/zotero-model-tests.js
```

O teste seleciona o modelo nas preferências, confirma a escolha ao reabrir a janela e gera uma pergunta e uma continuação pelo popup. Confirma que os botões de salvar continuam disponíveis sem criar anotações automaticamente. Restaura as configurações ao terminar. Evidências ficam em `experiments/results/native-lfm8b.json` e capturas em `.runtime/native-model-preferences.png` e `.runtime/native-lfm8b-popup.png`. Para repetir, use cópias desses arquivos ou outra pasta de resultados; a validação do 8B não altera o benchmark do 2.6B.

## Controle nativo do servidor

Prepare Q4 dos dois modelos e mantenha o servidor simulado na porta 18080. Termine a suíte simulada antes de iniciar esta:

```bash
python3 scripts/rdp.py --file scripts/zotero-runtime-tests.js
```

O script usa os botões da página de configurações para iniciar o launcher real na porta 18094, gerar respostas com os dois modelos, reiniciar e parar. Verifica pasta inválida, estado de carregamento, preservação de contexto/cache, novo PID ao reiniciar, ausência dos processos antigos, detecção do servidor externo e início automático ao reabilitar. Desativar deve encerrar o supervisor e o filho. As preferências originais são restauradas; nenhum prompt é reenviado automaticamente. Evidência em `experiments/results/native-runtime.json`, captura em `.runtime/native-runtime-preferences.png`.

`setup_dev.py` configura a pasta do projeto e desativa o início automático no perfil isolado. O teste de reinício integral do Zotero precisa alterar temporariamente somente o `user.js` desse perfil, porque ele sobrescreve preferências no startup; restaure-o ao terminar. Nunca aplique essas alterações ao perfil pessoal.

Após instalar o XPI de distribuição, execute `scripts/zotero-runtime-restart-prepare.js` pelo debugger: ele guarda as configurações, habilita o início automático no perfil isolado, inicia o modelo e fecha o Zotero normalmente. Reabra esse mesmo perfil com o comando de desenvolvimento. Com o servidor pronto, `scripts/zotero-runtime-restart-check.js` verifica novos PIDs, limpeza dos processos antigos e o checkbox persistente, encerra o novo servidor e restaura o `user.js` e as preferências. Evidência em `experiments/results/native-runtime-restart.json`.

`scripts/zotero-runtime-pane-tests.js` segura uma consulta de status, fecha a janela nativa e libera a resposta depois. Verifica que não há acesso a uma janela destruída nem reagendamento de timers. Restaura a API de status no final e grava `experiments/results/native-runtime-pane.json`.

O Zotero destrói o sandbox da página antes de enviar `unload` à janela. Operações assíncronas de processo/status/picker e o listener de fechamento ficam no plugin privilegiado. A página usa handlers síncronos e consulta snapshots; o registro de vida da janela cancela seu timer ao fechar ou desativar. Não registre listeners de unload ou callbacks de promessas no sandbox da página.

## Contratos

- `Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID)` integra as ações ao popup nativo.
- `Zotero.PDFWorker.getFullText(attachmentID, null)` pede todas as páginas. O adaptador recusa extração parcial ou vazia e invalida o cache quando caminho, tamanho ou data do arquivo mudam.
- A requisição HTTP sai do bootstrap privilegiado. Nenhum script web de conteúdo recebe acesso ao servidor.
- `/apply-template` e `/tokenize` com `add_special:true, parse_special:true` contam o prompt, incluindo BOS. `/props` confirma contexto e slot único. `/v1/chat/completions` transmite SSE, separando `reasoning_content` de `content`. `scripts/smoke_runtime.ts` confere a contagem contra `timings.prompt_n` com inferência real.
- Desativar o plugin cancela sessões, remove ações, popups, estilos, página de configurações e listeners e encerra seu servidor gerenciado. Servidores externos continuam sob controle do usuário.
- `src/runtime.ts` controla propriedade e ciclo de vida do chat; `src/embedding-runtime.ts` controla o servidor de embeddings. `src/zotero-runtime.ts` isola `Subprocess`, o seletor nativo de pasta e IO. `scripts/serve.py --managed --parent-pid` e `scripts/serve_embedding.py --managed --parent-pid` terminam com EOF do controle ou saída do Zotero. Nenhum PID de arquivo de estado é adotado como processo próprio.
- `src/embeddings.ts` usa `/v1/embeddings` no loopback, normaliza os vetores e valida 1.024 dimensões. `src/retrieval.ts` mantém o índice em memória e corta o prompt pelo orçamento. O status transitório do chat fica em `.runtime/server-<porta>.json`; o dos embeddings, em `.runtime/embedding-<porta>.json`, sem prompts ou histórico.
- `Zotero.Annotations.saveFromJSON` cria um destaque com o trecho e a resposta escolhida como comentário. A API cuida de sua transação e envia notificações aos leitores abertos. O plugin captura os metadados originais da seleção e gera sua própria chave de anotação. Uma gravação solicitada pelo usuário pode terminar após fechar o popup; isso não mantém nem restaura a conversa.
- O runtime de uso prefere GPU inteira e ajusta a distribuição para GPU/CPU em falta de VRAM. Testes de distribuição fixa e benchmarks usam `--backend` e `--gpu-layers` explícitos, sem fallback. [runtime.md](runtime.md) descreve os comandos e a validação separada.

APIs internas e seleções usadas no harness podem mudar entre versões do Zotero. A compatibilidade do protótipo permanece restrita a 10.0.x até nova validação.
