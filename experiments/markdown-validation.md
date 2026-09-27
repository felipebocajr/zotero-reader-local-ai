# Formatação de Markdown nas respostas

O popup antes apresentava o texto do modelo com MathML, mas deixava `##` e `**` literais. Agora interpreta Markdown durante o streaming e em respostas concluídas: títulos, negrito, itálico, listas, tabelas e código. A regra inline de fórmulas preserva `\(...\)`, `\[...\]`, `$...$`, `$$...$$` e delimitadores duplicados antes de Markdown escapar barras ou índices.

O renderizador usa markdown-it 15.0.2 empacotado no XPI, com HTML bruto desativado. Imagens e links são apenas texto; não há carregamento de recursos externos pelo conteúdo do modelo. A fonte original permanece no histórico e no comentário salvo. Na aba de anotações, uma projeção mostra Markdown e MathML; o editor nativo revela a fonte ao receber foco. O pacote inclui as licenças das bibliotecas e dependências empacotadas.

Validação no Zotero 10.0.3 com perfil e biblioteca isolados:

| Verificação | Resultado |
|---|---:|
| Testes TypeScript, incluindo Markdown com LaTeX, streaming e HTML hostil | 52 passaram |
| Testes Python de runtime/instalação | 18 passaram |
| [Formatação nativa e persistência no XPI final](results/native-markdown.json) | 17 passaram |
| [Regressão nativa de MathML](results/native-math.json) | 24 passaram |
| [Regressão nativa do popup](results/native-acceptance.json) | 39 passaram |
| [Regressão nativa das anotações](results/native-annotations.json) | 21 passaram |

O [XPI final](results/markdown-build-validation.json) foi instalado pelo AddonManager no perfil isolado, ativou sem erro, passou na verificação ZIP e corresponde byte a byte ao pacote instalado. O teste de persistência repetiu a inspeção depois de encerrar e reabrir o Zotero com o XPI sem harness. O baseline de precisão não foi alterado; esta mudança afeta apenas a apresentação e mantém o prompt e as respostas originais.

Use [os comandos de desenvolvimento](../docs/development.md#renderização-de-markdown-e-latex) para repetir. As capturas foram verificadas visualmente em `.runtime/native-markdown-popup.png` e `.runtime/native-markdown-annotation.png` no perfil de teste.
