import { ReaderError, abortIfNeeded } from "./errors.ts";
import type { Paper } from "./types.ts";

export interface PaperSource {
  describe(id: number): Promise<{ path: string; title: string; modified: number; size: number }>;
  extract(id: number): Promise<{ text: string; extractedPages: number; totalPages: number }>;
}

export class PaperCache {
  private cache = new Map<number, { signature: string; paper: Paper }>();
  private source: PaperSource;
  private maxEntries: number;
  constructor(source: PaperSource, maxEntries = 3) { this.source = source; this.maxEntries = maxEntries; }
  clear(): void { this.cache.clear(); }
  async get(id: number, signal: AbortSignal): Promise<Paper> {
    abortIfNeeded(signal);
    try {
      const info = await this.source.describe(id);
      const signature = JSON.stringify([info.path, info.modified, info.size]);
      const hit = this.cache.get(id);
      if (hit?.signature === signature) {
        this.cache.delete(id); this.cache.set(id, hit);
        abortIfNeeded(signal);
        return hit.paper;
      }
      const raw = await this.source.extract(id);
      abortIfNeeded(signal);
      if (typeof raw.text !== "string" || !raw.text.trim()) throw new ReaderError("no-text", "Este PDF não contém texto extraível. PDFs escaneados precisam de OCR, que fica fora desta versão.");
      if (!Number.isInteger(raw.totalPages) || raw.totalPages < 1 || !Number.isInteger(raw.extractedPages) || raw.extractedPages !== raw.totalPages) {
        throw new ReaderError("partial-paper", "Não foi possível extrair todas as páginas do artigo. O pedido não foi enviado com contexto parcial.");
      }
      const after = await this.source.describe(id);
      if (JSON.stringify([after.path, after.modified, after.size]) !== signature) throw new ReaderError("changed-paper", "O PDF mudou durante a extração. Tente novamente.");
      abortIfNeeded(signal);
      const paper: Paper = { ...raw, title: info.title };
      this.cache.set(id, { signature, paper });
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      return paper;
    } catch (error) {
      if (error instanceof ReaderError || signal.aborted) { abortIfNeeded(signal); throw error; }
      throw new ReaderError("extraction", "Não foi possível ler o PDF completo. Confira se o arquivo está disponível e desbloqueado.");
    }
  }
}
