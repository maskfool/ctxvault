/**
 * tokens.ts — cheap token budgeting without a tokenizer dependency.
 *
 * A well-known rule of thumb for English + code is ~4 characters per token.
 * We never need exact counts here — we only need to decide "does this packet
 * fit the budget, and if not, what do I drop?" chars/4 is plenty for that.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/** Keep the TAIL of a string within a char budget (recent messages matter most). */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(text.length - maxChars);
  return `…[earlier context truncated]…\n${kept}`;
}
