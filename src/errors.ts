export class ReaderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "ReaderError"; this.code = code; }
}
export function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new ReaderError("cancelled", "Pedido cancelado.");
}
export function userMessage(error: unknown): string {
  if (error instanceof ReaderError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Pedido cancelado.";
  return "Não foi possível concluir o pedido. Tente novamente; consulte o log do Zotero se o problema persistir.";
}
