/**
 * @typedef {'safe' | 'tight' | 'will_miss'} PaymentRisk
 * @typedef {Object} PaymentTask
 * @property {string} taskId
 * @property {Date} acquiredAt
 * @property {Date} reservationExpiresAt
 * @property {number} estimatedDurationMs
 * @property {Array<object>} flowSettlePhase
 * @property {{raw: string, source: string}} reservationToken
 * @property {number} maxRetries
 * @property {number} retryBackoffMs
 */

export class PaymentChannel {
  constructor({
    id,
    methodRef,
    type = 'creditcard',
    minIntervalMs = 30000,
    typicalDurationMs = 45000,
    hasOTP = false,
    maxQueueSize = 10,
    clock = () => Date.now()
  }) {
    this.id = id;
    this.methodRef = methodRef;
    this.type = type;
    this.minIntervalMs = minIntervalMs;
    this.typicalDurationMs = typicalDurationMs;
    this.hasOTP = hasOTP;
    this.maxQueueSize = maxQueueSize;
    this.clock = clock;
    this.isFrozen = false;
    this.frozenReason = undefined;
    this.currentlyProcessing = null;
    this.pending = [];
    this.durations = [];
  }

  enqueue(task) {
    if (this.isFrozen) throw codeError('payment_channel_frozen', this.frozenReason ?? 'Payment channel is frozen');
    if (this.pending.length >= this.maxQueueSize) throw codeError('payment_channel_full', 'Payment queue is full');
    const normalized = {
      ...task,
      acquiredAt: new Date(task.acquiredAt),
      reservationExpiresAt: new Date(task.reservationExpiresAt),
      estimatedDurationMs: task.estimatedDurationMs ?? this.averageActualDurationMs(),
      state: 'queued'
    };
    this.pending.push(normalized);
    this.rebalance();
    const pending = this.pending.find((item) => item.taskId === task.taskId);
    return {
      position: this.pending.indexOf(pending) + 1,
      estimatedStartAt: pending.estimatedStartAt,
      willCompleteBy: pending.willCompleteBy,
      isSafe: pending.risk !== 'will_miss',
      risk: pending.risk,
      warnings: pending.risk === 'will_miss' ? ['reservation will expire before the safe payment slot'] : []
    };
  }

  dequeue(taskId) {
    this.pending = this.pending.filter((task) => task.taskId !== taskId);
    if (this.currentlyProcessing?.taskId === taskId) this.currentlyProcessing = null;
    this.rebalance();
  }

  rebalance() {
    const now = this.clock();
    this.pending.sort((a, b) => a.reservationExpiresAt - b.reservationExpiresAt);
    let lastFinish = this.currentlyProcessing?.expectedFinishAt?.getTime() ?? now;
    for (const task of this.pending) {
      const earliestStart = Math.max(now, lastFinish + this.minIntervalMs);
      const finish = earliestStart + task.estimatedDurationMs;
      const margin = task.reservationExpiresAt.getTime() - finish;
      task.estimatedStartAt = new Date(earliestStart);
      task.willCompleteBy = new Date(finish);
      task.risk = margin < 0 ? 'will_miss' : margin < 120000 ? 'tight' : 'safe';
      lastFinish = finish;
    }
  }

  startNext({ forceNow = false } = {}) {
    if (this.isFrozen || this.currentlyProcessing || this.pending.length === 0) return null;
    this.rebalance();
    const next = this.pending.shift();
    const now = this.clock();
    const startAt = forceNow ? now : Math.max(now, next.estimatedStartAt.getTime());
    this.currentlyProcessing = {
      ...next,
      startedAt: new Date(startAt),
      expectedFinishAt: new Date(startAt + next.estimatedDurationMs)
    };
    this.rebalance();
    return this.currentlyProcessing;
  }

  complete(taskId, { ok = true, durationMs } = {}) {
    if (this.currentlyProcessing?.taskId !== taskId) return;
    if (ok) this.durations.push(durationMs ?? Math.max(0, this.clock() - this.currentlyProcessing.startedAt.getTime()));
    if (this.durations.length > 50) this.durations.shift();
    this.currentlyProcessing = null;
    this.rebalance();
  }

  inspect() {
    return {
      channelId: this.id,
      isFrozen: this.isFrozen,
      frozenReason: this.frozenReason,
      currentlyProcessing: this.currentlyProcessing,
      pending: this.pending.map((task, index) => ({ ...task, position: index + 1 })),
      averageActualDurationMs: this.averageActualDurationMs(),
      recentSuccessRate: 1
    };
  }

  freeze(reason) {
    this.isFrozen = true;
    this.frozenReason = reason;
  }

  unfreeze() {
    this.isFrozen = false;
    this.frozenReason = undefined;
    this.rebalance();
  }

  averageActualDurationMs() {
    if (this.durations.length < 5) return this.typicalDurationMs;
    const sorted = [...this.durations].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
