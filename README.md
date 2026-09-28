# Zotero Reader Local AI

**English** | [Português (Brasil)](README.pt-BR.md)

A Zotero add-on that helps readers understand PDF passages and ask questions about a paper using locally run language models.

![An English AI explanation for a selected passage in the Zotero PDF reader](docs/images/native-popup-en.png)

## Features

- Explain selected passages and ask questions about a PDF.
- View assistance alongside the text and optionally save useful answers as Zotero annotations.
- Read formatted Markdown and mathematical expressions.
- English is the default response language; Brazilian Portuguese is available in the settings.
- Inference runs locally, and conversations are not saved automatically.

## Compatibility

- Zotero 10.0.3–10.0.x; validated with Zotero 10.0.3.
- The bundled runtime and in-app server controls are validated on Linux x86_64 with Python 3.12 or newer. Other platforms are not yet validated.
- An NVIDIA GPU is optional. With a driver compatible with CUDA 12.8, automatic mode can use the GPU, share work between GPU and CPU, or fall back to CPU.

## Get started

1. Download the `.xpi` package from [Releases](https://github.com/felipebocajr/zotero-reader-local-ai/releases).
2. Clone the project and prepare the runtime and default model (LFM2.5-2.6B, Q4_K_M):

   ```bash
   git clone https://github.com/felipebocajr/zotero-reader-local-ai.git
   cd zotero-reader-local-ai
   python3 scripts/setup_runtime.py --backend auto --precision Q4_K_M
   ```

   This step downloads the required files and needs an internet connection and disk space. Inference can run offline after setup.

3. In Zotero, open the Plugins menu, choose **Install Plugin From File** from the gear menu, and select the `.xpi`.
4. In the **Assistente local** (Local Assistant) preferences pane, choose the cloned project folder and click **Iniciar servidor** (Start Server). When the status is **Pronto** (Ready), open a PDF, select a passage, and choose **Explicar trecho** (Explain Passage) or **Fazer pergunta** (Ask a Question).

The default model is LFM2.5-2.6B. To use LFM2.5-8B-A1B or configure the runtime, see the [runtime guide](docs/runtime.md). Plugin updates are manual.

## Privacy and limitations

AI inference runs on your device; the plugin does not send documents to an external inference service. Initial setup downloads the runtime and model files. Scanned PDFs without selectable text need OCR, which is not included. Answers may contain errors; see the [evaluation and its limitations](experiments/report.md).

## Development

Requires Node.js 22.18 or newer. To check the code and build the package:

```bash
npm ci
npm run check
npm test
npm run test:runtime
npm run build
```

The XPI is written to `dist/`. See the [development and native testing guide](docs/development.md), [runtime guide](docs/runtime.md), and [experiment guide](experiments/README.md).

## License

This project does not yet specify a license.
