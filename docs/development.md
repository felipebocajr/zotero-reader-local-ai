# Desenvolvimento e validação nativa

Nunca use a biblioteca pessoal nos testes. Os scripts verificam o diretório de dados antes de instalar/importar. O perfil é `.runtime/zotero-profile`, com biblioteca `.runtime/zotero-data`; sincronização automática e API HTTP do Zotero ficam desativadas.

## Preparar

```bash
npm ci
npm run build
python3 scripts/prepare_papers.py
python3 scripts/setup_dev.py
```

Abra esse Zotero em outro terminal:

```bash
zotero -no-remote -profile "$PWD/.runtime/zotero-profile" -ZoteroDebugText -purgecaches --start-debugger-server 18085 > .runtime/zotero-dev.log 2>&1
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

Os testes usam o leitor real e suas seleções temporárias, sem salvar anotações. Verificam as ações, foco, streaming sem raciocínio, conversa, independência das perguntas, texto completo, cancelamento, erros e posição. Evidências ficam em `experiments/results/native-acceptance.json`; capturas de tela ficam em `.runtime/native-popup-*.png`.

Os testes simulados verificam integração e protocolo. A qualidade e a velocidade da LFM são avaliadas com o runtime real, separadamente.

## Idioma das respostas

Depois da suíte simulada, com Q4 dos dois modelos preparado:

```bash
python3 scripts/rdp.py --file scripts/zotero-language-tests.js
```

O teste abre o seletor nativo, verifica o padrão `pt-BR` numa atualização sem preferência anterior e a persistência ao reabrir a janela. Com o artigo completo em inglês, gera uma explicação em português, troca para inglês com uma pergunta em português e volta para português com uma pergunta em inglês na mesma conversa. Faz esse fluxo com ambos os modelos; o idioma não exige reiniciar o servidor. Revise os textos em `experiments/results/native-languages.json`: verificações de interface/protocolo não substituem a inspeção do idioma real.

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
- `src/runtime.ts` controla propriedade e ciclo de vida; `src/zotero-runtime.ts` isola `Subprocess`, o seletor nativo de pasta e IO. `scripts/serve.py --managed --parent-pid` termina com EOF do controle ou saída do Zotero. Nenhum PID de arquivo de estado é adotado como processo próprio.
- `Zotero.Annotations.saveFromJSON` cria um destaque com o trecho e a resposta escolhida como comentário. A API cuida de sua transação e envia notificações aos leitores abertos. O plugin captura os metadados originais da seleção e gera sua própria chave de anotação. Uma gravação solicitada pelo usuário pode terminar após fechar o popup; isso não mantém nem restaura a conversa.
- O runtime de uso prefere GPU inteira e ajusta a distribuição para GPU/CPU em falta de VRAM. Testes de distribuição fixa e benchmarks usam `--backend` e `--gpu-layers` explícitos, sem fallback. [runtime.md](runtime.md) descreve os comandos e a validação separada.

APIs internas e seleções usadas no harness podem mudar entre versões do Zotero. A compatibilidade do protótipo permanece restrita a 10.0.x até nova validação.
