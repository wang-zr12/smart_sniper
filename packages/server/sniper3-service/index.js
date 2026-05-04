import { makeWatchId } from '../../core/domain-types/index.js';
import { SimpleMachine } from '../../core/state-machine/index.js';

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_QUARANTINE_AFTER_FAILURES = 3;

export class Sniper3Service {
  constructor({
    eventBus,
    notificationService,
    sniper2,
    scheduler,
    tenantId = 'local-user',
    clock = () => new Date(),
    confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
    quarantineAfterFailures = DEFAULT_QUARANTINE_AFTER_FAILURES
  } = {}) {
    this.eventBus = eventBus;
    this.notificationService = notificationService ?? null;
    this.sniper2 = sniper2 ?? null;
    this.scheduler = scheduler ?? null;
    this.tenantId = tenantId;
    this.clock = clock;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this.quarantineAfterFailures = quarantineAfterFailures;
    this.watches = new Map();
    this.signalSources = new Map();
    this.confirmationHandles = new Map();
    this.taskToWatch = new Map();
    if (eventBus?.subscribe) {
      this._unsubscribeFromSniper2 = eventBus.subscribe(
        { topic: 'sniper2:task:terminal', tenantId: this.tenantId },
        (event) => this.#onSniper2Terminal(event).catch(() => {})
      );
    }
  }

  async createWatch(intent) {
    const watchId = makeWatchId();
    const machine = new SimpleMachine('sniper3Watch', 'monitoring', {
      watchId,
      intent,
      signalEvents: [],
      completedOrders: 0
    }, ({ from, to }) => {
      this.eventBus?.emit({
        topic: 'sniper3:watch:state_changed',
        tenantId: this.tenantId,
        payload: { watchId, fromState: from, toState: to }
      });
    });
    this.watches.set(watchId, {
      watchId,
      intent,
      machine,
      createdAt: this.clock(),
      checks: 0,
      linkedTaskId: null,
      lastSnapshot: null
    });
    return watchId;
  }

  listWatches() {
    return [...this.watches.values()].map((watch) => this.#view(watch));
  }

  getWatch(watchId) {
    return this.#view(this.#watch(watchId));
  }

  pauseWatch(watchId, reason = 'user') {
    const watch = this.#watch(watchId);
    watch.machine.send('pause', { suspendedReason: reason });
  }

  resumeWatch(watchId) {
    this.#watch(watchId).machine.send('resume');
  }

  cancelWatch(watchId) {
    const watch = this.#watch(watchId);
    watch.machine.send('cancel');
    this.#cancelConfirmationTimer(watchId);
  }

  registerSignalSource(siteId, source) {
    const list = this.signalSources.get(siteId) ?? [];
    list.push(source);
    this.signalSources.set(siteId, list);
  }

  listSignalSources(siteId) {
    const entries = siteId ? [[siteId, this.signalSources.get(siteId) ?? []]] : [...this.signalSources.entries()];
    return entries.flatMap(([site, sources]) =>
      sources.map((source) => ({ id: source.id, siteId: site, type: source.type }))
    );
  }

  /**
   * Receive a stock signal for a watched item. Drives the watch state machine
   * through monitoring → triggered → (confirming → )executing and, when no user
   * confirmation is required, immediately bridges to Sniper2 to place the order.
   */
  async fireSignal(watchId, snapshot) {
    const watch = this.#watch(watchId);
    const completed = watch.machine.context.completedOrders ?? 0;
    const cap = watch.intent.policy?.maxOrders ?? 1;
    if (completed >= cap) {
      return { ok: false, reason: 'task_already_terminal', state: watch.machine.state };
    }
    if (!['monitoring', 'configured', 'continued'].includes(watch.machine.state)) {
      return { ok: false, reason: 'task_already_terminal', state: watch.machine.state };
    }
    if (watch.machine.state === 'continued') watch.machine.send('resume');
    watch.lastSnapshot = snapshot;
    watch.machine.send('signal', { triggerSnapshot: snapshot, signalAt: this.clock() });
    watch.signalEvents = [...(watch.machine.context.signalEvents ?? []), { snapshot, at: this.clock() }];

    if (this.notificationService) {
      try {
        await this.notificationService.notify({
          scope: 'sniper3',
          category: 'restock_signal',
          severity: 'info',
          payload: { watchId, siteId: watch.intent.product?.siteId, snapshot },
          tenantId: this.tenantId
        });
      } catch {
        // notification failures must not block the trigger path
      }
    }

    if (watch.intent.policy?.requireConfirmation) {
      return this.#enterConfirming(watchId, snapshot);
    }
    return this.#enterExecuting(watchId, snapshot);
  }

  async confirmFromUser(watchId) {
    const watch = this.#watch(watchId);
    if (watch.machine.state !== 'confirming') {
      throw codeError('user_confirmation_timeout', `Watch ${watchId} is not awaiting confirmation (state=${watch.machine.state})`);
    }
    this.#cancelConfirmationTimer(watchId);
    watch.machine.send('confirmFromUser');
    const snapshot = watch.machine.context.triggerSnapshot ?? watch.lastSnapshot;
    return this.executeRestockOrder(watchId, snapshot);
  }

  async dismissConfirmation(watchId) {
    const watch = this.#watch(watchId);
    if (watch.machine.state !== 'confirming') return;
    this.#cancelConfirmationTimer(watchId);
    watch.machine.send('timeout');
  }

  async executeRestockOrder(watchId, snapshot) {
    const watch = this.#watch(watchId);
    if (watch.machine.state !== 'executing') {
      throw codeError('task_already_terminal', `Watch ${watchId} not in executing state (state=${watch.machine.state})`);
    }
    if (!this.sniper2) {
      watch.machine.send('failed', { reason: 'no_sniper2_bridge' });
      this.#applyContinuationPolicy(watch, { ok: false });
      return { ok: false, reason: 'no_sniper2_bridge' };
    }
    const orderIntent = restockToScheduledOrderIntent(watch.intent, snapshot, {
      watchId,
      now: this.clock()
    });
    try {
      const taskId = await this.sniper2.createTask(orderIntent, {
        autoDrive: false  // Sniper3-driven: caller decides when to run
      });
      watch.linkedTaskId = taskId;
      this.taskToWatch.set(taskId, watchId);
      this.eventBus?.emit({
        topic: 'sniper3:watch:order_created',
        tenantId: this.tenantId,
        payload: { watchId, taskId, intent: orderIntent }
      });
      return { ok: true, taskId, scheduledIntent: orderIntent };
    } catch (error) {
      const reason = error.code ?? 'internal_error';
      watch.machine.send('failed', { reason });
      this.#applyContinuationPolicy(watch, { ok: false, reason });
      return { ok: false, reason };
    }
  }

  /**
   * Caller signals the outcome of the linked Sniper2 task back into the watch
   * lifecycle so continueAfterSuccess / maxOrders policies can be applied.
   */
  async markExecutionResult(watchId, result = {}) {
    const watch = this.#watch(watchId);
    if (watch.machine.state !== 'executing') {
      throw codeError('task_already_terminal', `Watch ${watchId} cannot record result from state ${watch.machine.state}`);
    }
    if (result.ok) {
      const completed = (watch.machine.context.completedOrders ?? 0) + 1;
      // Reset DLQ counter on any successful order — failures must be consecutive.
      watch.machine.send('succeeded', { completedOrders: completed, lastResult: result, consecutiveFailures: 0 });
      this.#applyContinuationPolicy(watch, result);
      if (this.notificationService) {
        try {
          await this.notificationService.notify({
            scope: 'sniper3',
            category: 'task_completed',
            severity: 'info',
            payload: { watchId, taskId: watch.linkedTaskId, result },
            tenantId: this.tenantId
          });
        } catch { /* swallow notification failure */ }
      }
    } else {
      const consecutiveFailures = (watch.machine.context.consecutiveFailures ?? 0) + 1;
      const quarantined = consecutiveFailures >= this.quarantineAfterFailures;
      watch.machine.send('failed', { reason: result.reason ?? 'failed', lastResult: result, consecutiveFailures, quarantined });
      if (quarantined) {
        // DLQ: connectivity is bad / the site keeps refusing / vendor keeps cancelling.
        // Force exhaust regardless of continueAfterSuccess so the user gets paged
        // instead of letting the watch silently retry forever.
        watch.machine.send('exhaust', { quarantineReason: result.reason ?? 'failed', quarantineAt: this.clock() });
        this.eventBus?.emit({
          topic: 'sniper3:watch:quarantined',
          tenantId: this.tenantId,
          payload: { watchId, consecutiveFailures, lastReason: result.reason ?? 'failed' }
        });
      } else {
        this.#applyContinuationPolicy(watch, result);
      }
      if (this.notificationService) {
        try {
          await this.notificationService.notify({
            scope: 'sniper3',
            category: 'task_failed',
            severity: quarantined ? 'urgent' : 'warn',
            payload: {
              watchId,
              taskId: watch.linkedTaskId,
              reason: result.reason ?? 'failed',
              consecutiveFailures,
              quarantined,
              quarantineThreshold: this.quarantineAfterFailures
            },
            tenantId: this.tenantId
          });
        } catch { /* swallow notification failure */ }
      }
    }
    return this.#view(watch);
  }

  async #onSniper2Terminal(event) {
    const payload = event?.payload ?? {};
    const watchId = payload.sourceWatchId ?? this.taskToWatch.get(payload.taskId);
    if (!watchId) return;
    const watch = this.watches.get(watchId);
    if (!watch) return;
    if (watch.machine.state !== 'executing') return;
    await this.markExecutionResult(watchId, {
      ok: payload.ok,
      reason: payload.reason ?? undefined,
      phase: payload.phase ?? undefined,
      taskId: payload.taskId
    });
    this.taskToWatch.delete(payload.taskId);
  }

  async #enterConfirming(watchId, snapshot) {
    const watch = this.#watch(watchId);
    watch.machine.send('confirm');
    if (this.notificationService) {
      try {
        await this.notificationService.notify({
          scope: 'sniper3',
          category: 'confirmation_required',
          severity: 'warn',
          payload: {
            watchId,
            siteId: watch.intent.product?.siteId,
            snapshot,
            timeoutMs: this.confirmationTimeoutMs,
            confirmEndpoint: `/api/v1/sniper3/watches/${encodeURIComponent(watchId)}/confirm`
          },
          tenantId: this.tenantId
        });
      } catch { /* notification failure should not block confirmation flow */ }
    }
    this.#scheduleConfirmationTimeout(watchId);
    return { ok: true, state: 'confirming', awaitingConfirmation: true };
  }

  async #enterExecuting(watchId, snapshot) {
    const watch = this.#watch(watchId);
    watch.machine.send('execute');
    return this.executeRestockOrder(watchId, snapshot);
  }

  #scheduleConfirmationTimeout(watchId) {
    if (!this.scheduler?.schedule) return;
    const triggerAt = new Date(this.clock().getTime() + this.confirmationTimeoutMs);
    const handle = this.scheduler.schedule({
      triggerAt,
      leadTimeMs: 0,
      warmupMs: 0,
      onTrigger: async () => {
        this.confirmationHandles.delete(watchId);
        const watch = this.watches.get(watchId);
        if (!watch || watch.machine.state !== 'confirming') return;
        watch.machine.send('timeout');
        this.eventBus?.emit({
          topic: 'sniper3:watch:confirmation_timeout',
          tenantId: this.tenantId,
          payload: { watchId, at: this.clock() }
        });
      }
    });
    this.confirmationHandles.set(watchId, handle);
  }

  #cancelConfirmationTimer(watchId) {
    const handle = this.confirmationHandles.get(watchId);
    if (handle && this.scheduler?.cancel) this.scheduler.cancel(handle);
    this.confirmationHandles.delete(watchId);
  }

  #applyContinuationPolicy(watch, _result) {
    const policy = watch.intent.policy ?? {};
    const completed = watch.machine.context.completedOrders ?? 0;
    const cap = policy.maxOrders ?? 1;
    if (policy.continueAfterSuccess && completed < cap) {
      watch.machine.send('continue');
      watch.machine.send('resume');
    } else {
      watch.machine.send('exhaust');
    }
  }

  #watch(watchId) {
    const watch = this.watches.get(watchId);
    if (!watch) throw new Error(`Unknown watch: ${watchId}`);
    return watch;
  }

  #view(watch) {
    const ctx = watch.machine.context;
    return {
      watchId: watch.watchId,
      state: watch.machine.state,
      intent: watch.intent,
      createdAt: watch.createdAt,
      totalChecks: watch.checks,
      linkedTaskId: watch.linkedTaskId,
      completedOrders: ctx.completedOrders ?? 0,
      consecutiveFailures: ctx.consecutiveFailures ?? 0,
      quarantined: Boolean(ctx.quarantined),
      quarantineReason: ctx.quarantineReason ?? null,
      lastSnapshot: watch.lastSnapshot
    };
  }
}

/**
 * Convert a RestockIntent into a ScheduledOrderIntent for Sniper2.
 * - maxQuantity → quantity { type: 'range', min: 1, max, preferred: max } (or 'exact' when max=1)
 * - constraints.maxUnitPrice → priceGuard.maxUnitPrice (with abortOnExceed: true)
 * - product / payment / shipping / flow forwarded as-is
 * - scheduling.triggerAt set to (now + 1s) so Sniper2 treats it as immediate
 */
export function restockToScheduledOrderIntent(restock, snapshot, opts = {}) {
  if (!restock?.product) throw new TypeError('RestockIntent.product is required');
  if (!restock?.payment) throw new TypeError('RestockIntent.payment is required');
  if (restock?.constraints?.maxUnitPrice == null) {
    throw new TypeError('RestockIntent.constraints.maxUnitPrice is required');
  }
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const triggerAt = new Date(now.getTime() + 1000);
  const requiredVariants = restock.constraints?.requiredVariants
    ?? restock.product.requiredVariants
    ?? {};
  const fallbackVariants = restock.constraints?.fallbackVariants
    ?? restock.product.fallbackVariants
    ?? [];
  return {
    product: {
      siteId: restock.product.siteId,
      productUrl: restock.product.productUrl,
      requiredVariants,
      fallbackVariants
    },
    quantity: maxQuantityToOrderQuantity(restock.constraints?.maxQuantity),
    priceGuard: { maxUnitPrice: restock.constraints.maxUnitPrice, abortOnExceed: true },
    scheduling: { triggerAt },
    payment: restock.payment,
    shipping: restock.shipping,
    flow: restock.flow,
    sourceWatchId: opts.watchId,
    sourceSnapshot: snapshot
  };
}

function maxQuantityToOrderQuantity(maxQuantity) {
  const n = Number.isFinite(maxQuantity) && maxQuantity > 0 ? Math.floor(maxQuantity) : 1;
  if (n === 1) return { type: 'exact', value: 1 };
  return { type: 'range', min: 1, max: n, preferred: n };
}

export function mergeSignals(watchId, signals) {
  const sorted = [...signals].sort((a, b) => b.detectedAt - a.detectedAt);
  const confidenceScore = sorted.reduce(
    (score, signal) => score + ({ high: 3, medium: 2, low: 1 }[signal.confidence] ?? 0),
    0
  );
  return {
    watchId,
    signals: sorted,
    confidence: confidenceScore >= 6 ? 'high' : confidenceScore >= 3 ? 'medium' : 'low'
  };
}

export function shouldTriggerAction(fusedSignal, intent) {
  const highCount = fusedSignal.signals.filter((signal) => signal.confidence === 'high').length;
  if (highCount >= 2) return { trigger: true, confidence: 'high' };
  if (highCount === 1) return { revalidate: true, afterMs: 1000 };
  if (intent.policy?.triggerOn === 'any_stock' && fusedSignal.confidence !== 'low') {
    return { revalidate: true, afterMs: 2000 };
  }
  return { trigger: false, reason: 'signal confidence too low' };
}

export function detectPriceDrift(originalPriceCents, currentPriceCents, tolerance) {
  if (!tolerance) {
    return { originalPriceCents, currentPriceCents, toleranceExceeded: currentPriceCents !== originalPriceCents };
  }
  const delta = Math.abs(currentPriceCents - originalPriceCents);
  const allowed = tolerance.type === 'percent'
    ? Math.round(originalPriceCents * (tolerance.value / 100))
    : tolerance.value;
  return { originalPriceCents, currentPriceCents, toleranceExceeded: delta > allowed };
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
