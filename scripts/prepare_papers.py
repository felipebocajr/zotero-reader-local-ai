#!/usr/bin/env python3
"""Fetch versioned public sample papers and extract all their pages with Poppler."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    dataset = json.loads((ROOT / "experiments/cases.json").read_text())
    output = ROOT / "experiments/data"
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for paper in dataset["papers"]:
        pdf = output / f'{paper["id"]}.pdf'
        url = f'https://arxiv.org/pdf/{paper["arxiv"]}'
        if not pdf.exists():
            print(f'Baixando {paper["title"]}', flush=True)
            request = urllib.request.Request(url, headers={"User-Agent": "zotero-reader-local-ai/0.1"})
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read()
            if not raw.startswith(b"%PDF-"):
                raise RuntimeError(f"Resposta não é PDF: {url}")
            pdf.write_bytes(raw)
        text = output / f'{paper["id"]}.txt'
        subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf), str(text)], check=True)
        info = subprocess.check_output(["pdfinfo", str(pdf)], text=True)
        pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
        content = text.read_text()
        if len(content.split("\f")) - 1 != pages or not content.strip():
            raise RuntimeError(f'Cobertura de páginas não confirmada para {paper["id"]}')
        normalized = re.sub(r"\s+", " ", content)
        for case in (c for c in dataset["cases"] if c["paper"] == paper["id"]):
            if case["selectionPhrase"].lower() not in normalized.lower():
                raise RuntimeError(f'Trecho não encontrado: {case["id"]}')
        with pdf.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest.append({**paper, "url": url, "pages": pages, "sha256": sha, "characters": len(content)})
        print(f'{paper["id"]}: {pages} páginas, {len(content)} caracteres, SHA-256 {sha}', flush=True)
    (output / "papers.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
