export class AcquirePool {
  constructor({ globalMaxConcurrent = 5, defaultPerSiteMaxConcurrent = 3, slotWaitTimeoutMs = 60000 } = {}) {
    this.globalMaxConcurrent = globalMaxConcurrent;
    this.defaultPerSiteMaxConcurrent = defaultPerSiteMaxConcurrent;
    this.slotWaitTimeoutMs = slotWaitTimeoutMs;
    this.perSiteLimits = new Map();
    this.active = new Map();
    this.queue = [];
  }

  setMaxConcurrentPerSite(siteId, n) {
    this.perSiteLimits.set(siteId, n);
    this.#drain();
  }

  setGlobalMaxConcurrent(n) {
    this.globalMaxConcurrent = n;
    this.#drain();
  }

  acquire(siteId, taskRef) {
    if (this.#canAcquire(siteId)) return Promise.resolve(this.#slot(siteId, taskRef));
    return new Promise((resolve, reject) => {
      const request = { siteId, taskRef, resolve, reject };
      request.timer = setTimeout(() => {
        this.queue = this.queue.filter((queued) => queued !== request);
        reject(codeError('no_acquire_slot', 'Timed out waiting for acquire slot'));
      }, this.slotWaitTimeoutMs);
      this.queue.push(request);
    });
  }

  release(slot) {
    const key = slot.siteId;
    const active = this.active.get(key) ?? new Set();
    active.delete(slot.id);
    this.active.set(key, active);
    this.#drain();
  }

  #slot(siteId, taskRef) {
    const id = `slot:${siteId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const active = this.active.get(siteId) ?? new Set();
    active.add(id);
    this.active.set(siteId, active);
    return { id, siteId, taskRef, acquiredAt: new Date() };
  }

  #canAcquire(siteId) {
    const perSite = this.active.get(siteId)?.size ?? 0;
    const global = [...this.active.values()].reduce((total, set) => total + set.size, 0);
    const siteLimit = this.perSiteLimits.get(siteId) ?? this.defaultPerSiteMaxConcurrent;
    return global < this.globalMaxConcurrent && perSite < siteLimit;
  }

  #drain() {
    for (const request of [...this.queue]) {
      if (!this.#canAcquire(request.siteId)) continue;
      clearTimeout(request.timer);
      this.queue = this.queue.filter((queued) => queued !== request);
      request.resolve(this.#slot(request.siteId, request.taskRef));
    }
  }
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
