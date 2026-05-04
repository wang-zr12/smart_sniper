/**
 * Cross-family egress middleware utilities. Reused by every adapter base.
 * Wired through MiddlewareEgress (../_common/middleware-egress.js).
 */

export class SameOriginRateLimit {
  constructor({ minIntervalMs = 800, clock = () => Date.now() } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
    this.lastByOrigin = new Map();
  }

  async wait(origin) {
    const now = this.clock();
    const nextAllowed = this.lastByOrigin.get(origin) ?? now;
    const delay = Math.max(0, nextAllowed - now);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.lastByOrigin.set(origin, this.clock() + this.minIntervalMs);
  }
}

export class HeaderConsistency {
  constructor() {
    this.bySession = new Map();
  }

  headersFor(sessionId, seedHeaders = {}) {
    if (!this.bySession.has(sessionId)) {
      this.bySession.set(sessionId, {
        'user-agent': seedHeaders['user-agent'] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Smart-Sniper/0.5',
        'accept-language': seedHeaders['accept-language'] ?? 'en-US,en;q=0.9',
        'sec-ch-ua': seedHeaders['sec-ch-ua']
      });
    }
    return { ...seedHeaders, ...this.bySession.get(sessionId) };
  }
}

export function classifyBackoff(response) {
  if (response.status === 429) return { action: 'drop_tier', holdMs: 1800000, reason: 'rate_limited' };
  if (response.status >= 500) return { action: 'drop_tier', holdMs: 1800000, reason: 'network_error' };
  return { action: 'none' };
}

export function detectGenericCaptcha({ bodyText = '', headers = {} } = {}) {
  const text = `${bodyText} ${Object.values(headers).join(' ')}`.toLowerCase();
  return text.includes('captcha') || text.includes('verify you are human');
}
