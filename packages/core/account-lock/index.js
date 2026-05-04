/**
 * AccountLock — cross-process serialization for credential-level operations.
 *
 *  WAIT FOR FUTURE IMPLEMENTATION (M+ SaaS milestone).
 *
 * Why this exists: under SaaS multi-instance deployment, two worker processes
 * could concurrently drive the same credential (eBay account, TGTG account,
 * Goodwill account, …). Without a cross-process lock, you can:
 *   - double-bid on the same auction
 *   - place two reservations for the same TGTG bag
 *   - trigger two competing 3DS challenges, hanging the user's bank session
 * The MVP runs single-process, so the default `NoOpLockProvider` is correct
 * for now. When SaaS lands, swap in a Redis SETNX or Postgres advisory-lock
 * implementation registered via dependency injection.
 *
 *
 * # Contract (each method returns a Promise)
 *
 *  acquire(key, opts) -> LockHandle
 *      Acquire an exclusive lock on `key`. Blocks (up to `opts.timeoutMs`)
 *      until the lock is available; throws { code: 'lock_unavailable' } on
 *      timeout. The implementation MUST set an automatic TTL (`opts.ttlMs`,
 *      recommend ≥ expected task duration + 30s safety margin) so a crashed
 *      worker doesn't permanently lock out its replacement.
 *
 *  release(handle) -> void
 *      Releases a lock acquired earlier. Safe to call on already-released
 *      handles (idempotent). Implementations MUST verify the holder identity
 *      (e.g., Redis Lua compare-and-delete) so a worker cannot accidentally
 *      release another worker's lock.
 *
 *  withLock(key, fn, opts) -> T
 *      Convenience wrapper: acquire → run fn → release in finally. Re-throws
 *      whatever fn throws.
 *
 *  isHeld(key) -> boolean
 *      Diagnostic-only. NOT authoritative under contention; do not use this
 *      to gate critical sections — race-y by design.
 *
 *
 * # Recommended key shape
 *
 *  See `lockKeyFor(tenantId, siteId, credentialRef)` below. Lock granularity
 *  is per-credential; two different cards on the same site can run in
 *  parallel. Per-tenant prefix ensures one tenant cannot lock another's keys.
 *
 *
 * # Future Sniper2/3 wiring (when this lands)
 *
 *  Sniper2.runFullPipeline:
 *    await lockProvider.withLock(
 *      lockKeyFor(tenantId, adapter.siteId, intent.payment.methodRef),
 *      () => acquire-then-settle pipeline,
 *      { ttlMs: 10 * 60 * 1000 }
 *    );
 *
 *  Sniper3.executeRestockOrder: same shape; concurrent watches on the same
 *  card serialize across all SaaS workers.
 */

export class LockProvider {
  /**
   * Acquire an exclusive lock. Override in concrete implementations.
   * @param {string} _key
   * @param {{ ttlMs?: number, timeoutMs?: number }} [_opts]
   * @returns {Promise<{ key: string, [k: string]: unknown }>}
   */
  // eslint-disable-next-line no-unused-vars
  async acquire(_key, _opts = {}) {
    throw new Error('LockProvider.acquire must be implemented by subclass');
  }

  /**
   * Release a lock by handle. Idempotent.
   * @param {{ key: string }} _handle
   */
  // eslint-disable-next-line no-unused-vars
  async release(_handle) {
    throw new Error('LockProvider.release must be implemented by subclass');
  }

  /**
   * Acquire → run → release in finally. Re-throws fn errors after release.
   * @template T
   * @param {string} key
   * @param {(handle: { key: string }) => Promise<T>} fn
   * @param {{ ttlMs?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<T>}
   */
  async withLock(key, fn, opts = {}) {
    const handle = await this.acquire(key, opts);
    try {
      return await fn(handle);
    } finally {
      await this.release(handle);
    }
  }

  /**
   * Diagnostic-only. Race-y by design — never use to gate a critical section.
   * @param {string} _key
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  async isHeld(_key) {
    return false;
  }
}

/**
 * In-process no-op lock provider. Tracks lock keys in a local Set so isHeld()
 * is diagnostic-truthful within the single process. Provides ZERO protection
 * across processes — replace with a Redis/Postgres-backed provider for SaaS.
 *
 * Wait for future implementation.
 */
export class NoOpLockProvider extends LockProvider {
  constructor() {
    super();
    this.held = new Set();
  }

  // eslint-disable-next-line no-unused-vars
  async acquire(key, _opts = {}) {
    this.held.add(key);
    return { key, acquiredAt: new Date(), releasedAt: null };
  }

  async release(handle) {
    if (handle?.key) this.held.delete(handle.key);
  }

  async isHeld(key) {
    return this.held.has(key);
  }
}

/**
 * Build a canonical lock key for a credential-scoped operation.
 *
 * @param {string} tenantId
 * @param {string} siteId
 * @param {string} credentialRef
 * @returns {string}  e.g. "local-user:tgtg:cred:visa"
 */
export function lockKeyFor(tenantId, siteId, credentialRef) {
  return `${tenantId}:${siteId}:${credentialRef}`;
}
