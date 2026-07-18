/**
 * seed.ts — a pre-filled Tool A conversation.
 *
 * A judge should get the magic in ~10 seconds without typing: land on the page,
 * hit "Save context", then "Resume in Tool B". So Tool A starts with a realistic
 * planning session already in it — one with clear decisions and a next step for
 * the summarizer to capture. Self-contained (no server imports) so the client
 * component can use it directly.
 */
export type SeedMessage = { role: "user" | "assistant"; content: string };

export const SEED_TOOL_A: SeedMessage[] = [
  {
    role: "user",
    content:
      "I'm building rate limiting for our public API. Help me plan it — needs to handle bursty traffic and run across multiple server instances.",
  },
  {
    role: "assistant",
    content:
      "Let's plan it.\n\n" +
      "**Approach:** token-bucket over sliding-window. Token-bucket handles bursts naturally (a full bucket absorbs a spike) and refills in O(1), whereas sliding-window log is O(n) in requests and heavier to store.\n\n" +
      "**Key decisions:**\n" +
      "1. Algorithm: token-bucket (burst-friendly, O(1) refill).\n" +
      "2. Shared state: since we run multiple instances, the bucket must live in Redis, not per-process memory — otherwise each instance enforces its own limit and the real limit is Nx too high.\n" +
      "3. Identity: limit per API key, falling back to IP for anonymous calls.\n\n" +
      "**Gotcha to watch:** clock skew across instances can double-count refills — use a single Redis TIME source, not each server's wall clock.\n\n" +
      "**Next step:** implement the token-bucket in `src/limiter.ts` with a Redis backend, then write a burst-traffic test that fires 100 requests in 1 second and asserts the excess is rejected.",
  },
  {
    role: "user",
    content:
      "Great, that matches my thinking. I've hit my usage limit here though — I'll continue in my other AI tool.",
  },
];
