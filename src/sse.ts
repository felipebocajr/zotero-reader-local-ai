import { ReaderError } from "./errors.ts";

export async function* readSSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ReaderError("cancelled", "Pedido cancelado.");
      const { value, done } = await reader.read();
      // Gecko resolves a canceled pending read as done instead of rejecting it.
      if (signal.aborted) throw new ReaderError("cancelled", "Pedido cancelado.");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r\n|\n|\r/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield data;
      }
      if (buffer.length > 2 * 1024 * 1024) throw new ReaderError("stream", "Resposta do servidor fora do formato esperado.");
      if (done) {
        if (buffer.trim() && !buffer.trim().startsWith(":")) throw new ReaderError("interrupted", "A conexão terminou antes de completar a resposta. Tente novamente.");
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Defensive tag filtering; normally llama-server provides reasoning_content separately. */
export class FinalTextFilter {
  private pending = "";
  private thinking = false;
  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    while (this.pending) {
      const opening = this.pending.indexOf("<think>");
      const closing = this.pending.indexOf("</think>");
      const index = opening < 0 ? closing : closing < 0 ? opening : Math.min(opening, closing);
      if (index >= 0) {
        if (!this.thinking) output += this.pending.slice(0, index);
        const tag = index === opening ? "<think>" : "</think>";
        if (tag === "</think>" && !this.thinking) throw new ReaderError("reasoning", "O servidor não separou o raciocínio corretamente. Inicie-o com --reasoning-format deepseek.");
        this.thinking = tag === "<think>";
        this.pending = this.pending.slice(index + tag.length);
        continue;
      }
      let held = 0;
      for (const tag of ["<think>", "</think>"]) {
        for (let size = 1; size < tag.length; size++) if (this.pending.endsWith(tag.slice(0, size))) held = Math.max(held, size);
      }
      const safe = this.pending.slice(0, this.pending.length - held);
      if (!this.thinking) output += safe;
      this.pending = held ? this.pending.slice(-held) : "";
      break;
    }
    return output;
  }
  finish(): string {
    if (this.thinking || this.pending.startsWith("<")) throw new ReaderError("reasoning", "A geração terminou antes da resposta final. Tente novamente.");
    const tail = this.pending; this.pending = ""; return tail;
  }
}
