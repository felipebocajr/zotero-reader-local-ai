# Validação do runtime automático

O launcher agora prefere GPU inteira, tenta distribuição GPU/CPU após falta de VRAM e usa CPU como último recurso. Esta validação de uso foi executada na RTX 3070 de 8 GiB, driver 610.57.04, com llama.cpp b11206 e os pesos fixados em `runtime.lock.json`. O contexto foi 32.768 tokens, com um slot e cache K/V f16 em todos os modos.

| Caso real | Distribuição observada | Pedido | Resultado |
|---|---|---|---|
| Q4_K_M, padrão automático | GPU inteira; 2.396 MiB de VRAM após o pedido | Attention, todas as 15 páginas | Resposta final em 6,0 s |
| F16, padrão automático | Falta de VRAM na primeira tentativa; ajuste para 23/31 camadas GPU e restante CPU; 4.610 MiB de VRAM após o pedido | Mesmo artigo e pergunta | Resposta final em 40,9 s |
| Q4_K_M, CUDA oculto somente nesse processo | CPU; nenhuma alocação GPU | Pedido curto | Resposta final em 7,5 s |

As unidades da tabela são MiB: os valores medidos foram **2.396 MiB** para Q4 e **4.610 MiB** para F16, equivalentes a aproximadamente 2,34 e 4,50 GiB. Esses números são amostras após o pedido, não picos. O pedido CPU foi curto e não deve ser comparado aos dois pedidos com artigo completo. A validação anterior de CPU com artigo inteiro permanece em `results/cpu-smoke.json`.

Nos dois testes com Attention, a contagem prévia e `timings.prompt_n` foram iguais: **10.039 tokens**. `/props` confirmou 32.768 tokens e um slot. Os logs detalhados do ajuste F16 registraram contexto fixado pelo usuário sem alteração, 23/31 camadas GPU, buffer de pesos CPU de 1.740,27 MiB e buffer GPU de 3.904,73 MiB. O cache K/V ficou dividido entre CPU e GPU, mantendo f16.

O teste de falta de VRAM não foi simulado: a tentativa F16 com GPU inteira falhou ao alocar o buffer CUDA de 5.145 MiB. O supervisor então lançou o mesmo peso, com o mesmo contexto, no modo ajustado. A disponibilidade de VRAM pode mudar o número de camadas da segunda tentativa em outras execuções.

## Evidência

- [runtime-auto-validation.json](results/runtime-auto-validation.json): tentativas, erros de memória, distribuição final, contexto, memória, testes e confirmação de encerramento dos filhos.
- [runtime-auto-q4-smoke.json](results/runtime-auto-q4-smoke.json): resposta e tempos com Q4 na GPU inteira.
- [runtime-auto-f16-smoke.json](results/runtime-auto-f16-smoke.json): resposta e tempos após fallback híbrido real.
- [runtime-auto-cpu-smoke.json](results/runtime-auto-cpu-smoke.json): resposta final no caminho CPU automático.

Um encerramento controlado do supervisor durante geração interrompeu a requisição e produziu a mensagem legível de conexão interrompida; o processo filho saiu. As três execuções finais também terminaram sem deixar filhos em execução. A instalação foi corrigida para publicar arquivos por renomeação atômica e foi repetida durante uma inferência CPU sem interromper sua resposta.

Passaram `npm run check`, os 18 testes TypeScript, os 12 testes de runtime/instalação e `npm run build`. O XPI manteve o mesmo SHA-256 do pacote já validado no Zotero; esta mudança não altera a interface do plugin. Os testes novos verificam fallback GPU → GPU/CPU → CPU, preservação de pesos/contexto/cache, erro de memória após o servidor estar pronto, cancelamento, contexto efetivo inválido, falhas sem relação com memória e instalação sem truncar arquivos já abertos.

## Limites desta validação

O caminho CPU real foi provocado com `CUDA_VISIBLE_DEVICES=` somente no processo de teste. A sequência em que ambas as tentativas GPU falham por memória foi testada automaticamente; não foi necessário esgotar também a memória do modo híbrido nesta máquina. Falta de VRAM durante geração foi verificada por teste automatizado do supervisor; a interrupção real durante geração foi causada pelo encerramento controlado, não por OOM.

Estes tempos validam o funcionamento dos modos de uso. Não são uma nova comparação de precisões: a distribuição foi adaptativa, a memória livre variou e não houve repetições. As respostas geradas não foram avaliadas quanto à correção científica neste teste. Os 135 registros e os resultados da comparação com distribuição fixa de 24 camadas permanecem preservados.

Para repetir sem sobrescrever os resultados, siga [docs/runtime.md](../docs/runtime.md) e escolha outro caminho de saída para o teste.
