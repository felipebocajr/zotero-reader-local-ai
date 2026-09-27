import type { PaperSource } from "./paper.ts";

// Keep Zotero's internal PDF API and filesystem access behind this boundary.
export function zoteroPaperSource(zotero: any, io: any): PaperSource {
  return {
    async describe(id) {
      const item = await zotero.Items.getAsync(id);
      if (!item?.isPDFAttachment()) throw new Error("Not a PDF attachment");
      const path = await item.getFilePathAsync();
      if (!path) throw new Error("Missing attachment file");
      const stat = await io.stat(path);
      const parent = item.parentID ? await zotero.Items.getAsync(item.parentID) : item;
      return { path, title: parent.getField("title") || item.getField("title") || "Artigo", modified: stat.lastModified, size: stat.size };
    },
    async extract(id) {
      if (typeof zotero.PDFWorker?.getFullText !== "function") throw new Error("Unsupported Zotero PDF API");
      return zotero.PDFWorker.getFullText(id, null);
    },
  };
}
