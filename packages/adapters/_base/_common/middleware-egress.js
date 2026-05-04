import { randomUUID } from 'node:crypto';
import { SameOriginRateLimit, HeaderConsistency, classifyBackoff } from './middleware.js';
import { currentRequestId } from '../../../core/tenant-context/index.js';

/**
 * Wraps any underlying egress (DirectEgress / VaultProxyEgress) and enforces:
 *   - same-origin rate limiting (default 800ms)
 *   - per-session header stability (UA, accept-language)
 *   - 429 / 5xx backoff with tier-drop hold (default 30 min)
 * Anti-detection.md mandates this for every adapter request.
 */
export class MiddlewareEgress {
  constructor({ underlying, siteId, profile = 'balanced', sessionId, minIntervalMs = 800, clock = () => Date.now() } = {}) {
    if (!underlying) throw new TypeError('underlying egress is required');
    this.underlying = underlying;
    this.siteId = siteId ?? 'unknown';
    this.profile = profile;
    this.sessionId = sessionId ?? `mw-egress:${this.siteId}`;
    this.clock = clock;
    this.rate = new SameOriginRateLimit({ minIntervalMs, clock });
    this.headers = new HeaderConsistency();
    this.backoffUntil = 0;
  }

  async fetch(request) {
    if (this.backoffUntil > this.clock()) {
      throw codeError('rate_limited', `${this.siteId}: middleware backoff active until ${new Date(this.backoffUntil).toISOString()}`);
    }
    const origin = originOf(request.url);
    if (origin) await this.rate.wait(origin);
    const augmented = this.headers.headersFor(this.sessionId, request.headers ?? {});
    // Trace propagation: inject X-Request-Id (from AsyncLocalStorage) and a
    // per-request X-Trace-Id so the downstream site's logs correlate with ours.
    // This is the "全链路 Trace ID" item in the error-handling audit.
    const requestId = currentRequestId() ?? `req:${randomUUID()}`;
    const traceId = `trace:${randomUUID()}`;
    augmented['x-request-id'] = augmented['x-request-id'] ?? requestId;
    augmented['x-trace-id']   = augmented['x-trace-id']   ?? traceId;
    const response = await this.underlying.fetch({ ...request, headers: augmented, traceId, requestId });
    const back = classifyBackoff(response);
    if (back.action === 'drop_tier') {
      this.backoffUntil = this.clock() + (back.holdMs ?? 1800000);
    }
    if (response && typeof response === 'object' && response.traceId == null) {
      response.traceId = traceId;
      response.requestId = requestId;
    }
    return response;
  }

  async newBrowserContext(opts) {
    return this.underlying.newBrowserContext?.(opts);
  }

  async releaseBrowserContext(ctx) {
    return this.underlying.releaseBrowserContext?.(ctx);
  }
}

const WRAPPED_KEY = Symbol.for('smart-sniper.middleware-egress');

export function applyMiddleware(egress, siteConfig) {
  if (!egress) return egress;
  if (egress[WRAPPED_KEY]) return egress;
  const wrapped = new MiddlewareEgress({
    underlying: egress,
    siteId: siteConfig?.siteId,
    profile: siteConfig?.businessRules?.pollProfile ?? 'balanced'
  });
  wrapped[WRAPPED_KEY] = true;
  return wrapped;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function codeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
