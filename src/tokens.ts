import type { Message } from "./types.ts";

/** Conservative estimate used where the API does not expose its tokenizer. */
export function estimatePromptTokens(messages: readonly Message[]): number {
  let characters = 0;
  for (const message of messages) characters += message.role.length + message.content.length + 8;
  // 3.5 characters per token is conservative for English and Portuguese papers.
  return Math.ceil(characters / 3.5) + 64;
}
