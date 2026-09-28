# Assistente local de leitura para Zotero

[English](README.md) | **Português (Brasil)**

Extensão do Zotero que ajuda a compreender trechos de PDFs e responder a perguntas sobre artigos usando modelos de linguagem executados localmente.

![Uma explicação da IA em português para um trecho selecionado no leitor de PDF do Zotero](docs/images/native-popup-pt-BR.png)

## Funcionalidades

- Explica trechos selecionados e responde a perguntas sobre o PDF.
- Exibe a assistência junto ao texto e permite salvar respostas úteis como anotações do Zotero.
- Formata Markdown e expressões matemáticas.
- O idioma padrão das respostas é inglês; português do Brasil está disponível nas configurações.
- A inferência é local, e as conversas não são salvas automaticamente.

## Compatibilidade

- Zotero 10.0.3–10.0.x; validado no Zotero 10.0.3.
- Runtime integrado e controles do servidor validados em Linux x86_64 com Python 3.12 ou superior. Outras plataformas ainda não foram validadas.
- GPU NVIDIA é opcional. Com driver compatível com CUDA 12.8, o modo automático pode usar a GPU, compartilhar o trabalho entre GPU e CPU ou recorrer somente à CPU.

## Instalação

1. Baixe o pacote `.xpi` na página de [Releases](https://github.com/felipebocajr/zotero-reader-local-ai/releases).
2. Clone o projeto e prepare o runtime e o modelo padrão (LFM2.5-2.6B, Q4_K_M):

   ```bash
   git clone https://github.com/felipebocajr/zotero-reader-local-ai.git
   cd zotero-reader-local-ai
   python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
   ```

   Esta etapa baixa os arquivos necessários e requer internet e espaço em disco. Depois da preparação, a inferência pode funcionar offline.

3. No Zotero, abra **Ferramentas → Plugins**, escolha **Instalar plugin de arquivo** no menu de engrenagem e selecione o `.xpi`.
4. Em **Configurações → Assistente local**, escolha a pasta clonada e clique em **Iniciar servidor**. Quando o status indicar **Pronto**, abra um PDF, selecione um trecho e escolha **Explicar trecho** ou **Fazer pergunta**.

O modelo padrão é o LFM2.5-2.6B. Para usar o LFM2.5-8B-A1B ou configurar o runtime, consulte o [guia de runtime](docs/runtime.md). As atualizações do plugin são manuais.

## Privacidade e limitações

A inferência de IA acontece no dispositivo; o plugin não envia documentos a um serviço externo de inferência. A preparação inicial baixa o runtime e os arquivos do modelo. PDFs escaneados sem texto selecionável precisam de OCR, que não está incluído. As respostas podem conter erros; consulte a [avaliação e seus limites](experiments/report.md).

## Desenvolvimento

Requer Node.js 22.18 ou superior. Para conferir o código e gerar o pacote:

```bash
npm ci
npm run check
npm test
npm run test:runtime
npm run build
```

O XPI é gerado em `dist/`. Consulte os guias de [desenvolvimento e testes nativos](docs/development.md), [runtime](docs/runtime.md) e [experimentos](experiments/README.md).

## Licença

Este projeto ainda não especifica uma licença.
