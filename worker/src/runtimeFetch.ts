/**
 * Cloudflare's global fetch must be invoked with the runtime global as its
 * receiver. Passing the bare function through a constructor loses that
 * receiver and throws `Illegal invocation` in production.
 */
export const runtimeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
