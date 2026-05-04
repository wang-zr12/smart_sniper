export class MemoryRateLimiter {
  constructor({ capacity = 60, refillPerSecond = 1, clock = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.clock = clock;
    this.buckets = new Map();
  }

  async acquire(key, weight = 1) {
    const bucket = this.#bucket(key);
    this.#refill(bucket);
    if (bucket.tokens < weight) {
      const deficit = weight - bucket.tokens;
      const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.#refill(bucket);
    }
    bucket.tokens = Math.max(0, bucket.tokens - weight);
    return {
      key,
      weight,
      acquiredAt: new Date(this.clock()),
      release: () => {}
    };
  }

  async getRemaining(key) {
    const bucket = this.#bucket(key);
    this.#refill(bucket);
    return {
      key,
      remaining: Math.floor(bucket.tokens),
      capacity: this.capacity,
      resetAt: new Date(this.clock() + ((this.capacity - bucket.tokens) / this.refillPerSecond) * 1000)
    };
  }

  #bucket(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAt: this.clock() };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  #refill(bucket) {
    const now = this.clock();
    const deltaSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + deltaSeconds * this.refillPerSecond);
    bucket.updatedAt = now;
  }
}
