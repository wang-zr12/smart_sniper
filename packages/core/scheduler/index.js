import { randomUUID } from 'node:crypto';

/**
 * @typedef {'system_sleep' | 'network_outage' | 'warmup_failed' | 'time_drift_excessive'} MissReason
 * @typedef {Object} ScheduledTask
 * @property {Date} triggerAt
 * @property {number} leadTimeMs
 * @property {number} warmupMs
 * @property {() => Promise<void>} onWarmup
 * @property {() => Promise<void>} onTrigger
 * @property {(reason: MissReason, error?: Error) => void} [onMiss]
 * @property {() => Promise<number>} serverTimeProvider
 */

export class PrecisionScheduler {
  constructor({ clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.handles = new Map();
  }

  schedule(task) {
    const handle = {
      id: `scheduled:${randomUUID()}`,
      task,
      timers: [],
      cancelled: false,
      warmed: false,
      state: 'scheduled'
    };
    this.handles.set(handle.id, handle);
    this.#plan(handle);
    return handle;
  }

  cancel(handle) {
    const saved = this.handles.get(handle.id) ?? handle;
    saved.cancelled = true;
    saved.state = 'cancelled';
    for (const timer of saved.timers) this.clearTimer(timer);
    this.handles.delete(saved.id);
  }

  reschedule(handle, newTriggerAt) {
    const saved = this.handles.get(handle.id) ?? handle;
    for (const timer of saved.timers) this.clearTimer(timer);
    saved.timers = [];
    saved.task = { ...saved.task, triggerAt: new Date(newTriggerAt) };
    saved.cancelled = false;
    saved.state = 'scheduled';
    this.handles.set(saved.id, saved);
    this.#plan(saved);
  }

  #plan(handle) {
    const { task } = handle;
    const leadTimeMs = task.leadTimeMs ?? 5000;
    const warmupMs = task.warmupMs ?? 60000;
    const targetAt = new Date(task.triggerAt).getTime() - leadTimeMs;
    const warmupAt = targetAt - warmupMs;
    const warmupDelay = Math.max(0, warmupAt - this.clock());
    const triggerDelay = Math.max(0, targetAt - this.clock());

    handle.timers.push(this.setTimer(() => this.#warmup(handle), warmupDelay));
    handle.timers.push(this.setTimer(() => this.#trigger(handle), triggerDelay));
  }

  async #warmup(handle) {
    if (handle.cancelled || handle.warmed) return;
    handle.state = 'warming';
    try {
      await handle.task.onWarmup?.();
      handle.warmed = true;
      handle.state = 'armed';
    } catch (error) {
      handle.state = 'warmup_failed';
      handle.task.onMiss?.('warmup_failed', error);
    }
  }

  async #trigger(handle) {
    if (handle.cancelled) return;
    handle.state = 'triggering';
    try {
      const serverNow = await handle.task.serverTimeProvider?.();
      if (Number.isFinite(serverNow)) {
        const localNow = this.clock();
        if (Math.abs(serverNow - localNow) > 5000) {
          handle.state = 'missed';
          handle.task.onMiss?.('time_drift_excessive');
          return;
        }
      }
      await handle.task.onTrigger();
      handle.state = 'triggered';
    } catch (error) {
      handle.state = 'missed';
      handle.task.onMiss?.('network_outage', error);
    } finally {
      this.handles.delete(handle.id);
    }
  }
}

export function resolveDeadlineTier(distanceMs) {
  if (distanceMs < -30000) return 'idle';
  if (distanceMs <= 30000 && distanceMs >= 0) return 'post';
  if (distanceMs <= 15000) return 'strike';
  if (distanceMs <= 120000) return 'hot';
  if (distanceMs <= 1800000) return 'warm';
  return 'cold';
}

export function jitterInterval(lowerMs, upperMs, { rng = Math.random, profile = 'balanced' } = {}) {
  const multiplier = profile === 'conservative' ? 1.3 : profile === 'aggressive' ? 0.67 : 1;
  const uniform = lowerMs + rng() * (upperMs - lowerMs);
  const gaussian = Math.max(0.3, boxMuller(rng) * 0.15 + 1);
  let interval = Math.round(uniform * gaussian * multiplier);
  if (interval % 1000 === 0) interval += 137;
  return Math.max(1, interval);
}

export class RequestSpreader {
  constructor({ minSameSiteGapMs = 800, clock = () => Date.now() } = {}) {
    this.minSameSiteGapMs = minSameSiteGapMs;
    this.clock = clock;
    this.nextBySite = new Map();
  }

  nextAt(siteId, windowMs) {
    const now = this.clock();
    const earliest = Math.max(now, this.nextBySite.get(siteId) ?? now);
    const scheduled = earliest + Math.floor(Math.random() * Math.max(1, windowMs));
    this.nextBySite.set(siteId, scheduled + this.minSameSiteGapMs);
    return new Date(scheduled);
  }
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function boxMuller(rng) {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
