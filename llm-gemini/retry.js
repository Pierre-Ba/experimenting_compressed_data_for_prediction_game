// retry.js
export async function withBackoff(fn, {
    tries = 5,
    baseMs = 500,  // 0.5s, 1s, 2s, 4s, 8s...
    factor = 2,
    jitter = true
  } = {}) {
    let attempt = 0, lastErr;
    while (attempt < tries) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        // Only retry on 429/503/500-ish
        const msg = String(err?.message || '');
        const isRetryable =
          msg.includes('429') ||
          msg.includes('503') ||
          msg.includes('500') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('OVERLOADED');
        if (!isRetryable) throw err;
  
        const delay = (baseMs * (factor ** attempt)) * (jitter ? (0.7 + Math.random() * 0.6) : 1);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
    throw lastErr;
  }
  