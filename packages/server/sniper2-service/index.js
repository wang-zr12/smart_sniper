import { makeTaskId } from '../../core/domain-types/index.js';
import { SimpleMachine } from '../../core/state-machine/index.js';
import { AcquirePool } from '../order-shared/acquire-pool/index.js';
import { PaymentChannel } from '../order-shared/payment-channel/index.js';
import { HttpExecutionEngine, BrowserExecutionEngine, MobileExecutionEngine, runAcquirePhase as executeAcquirePhase, runSettlePhase as executeSettlePhase } from '../order-shared/execution-engine/index.js';

// Map error codes that are surfaced to users → NotificationService category.
// Only codes that genuinely need user attention live here; transient retriable
// errors (rate_limited, network_error) are intentionally absent.
const ERROR_TO_NOTIFICATION_CATEGORY = Object.freeze({
  auth_required:               'auth_required',
  session_expired:             'auth_required',
  captcha_encountered:         'captcha_required',
  account_blocked:             'account_blocked',
  payment_3ds_required:        'payment_3ds_required',
  insufficient_funds:          'payment_declined',
  payment_declined:            'payment_declined',
  payment_declined_hard:       'payment_declined',
  payment_refunded_by_vendor:  'vendor_refunded',
  stock_phantom_read:          'stock_phantom'
});

const ERROR_NOTIFICATION_SEVERITY = Object.freeze({
  payment_3ds_required: 'urgent',
  account_blocked:      'urgent',
  vendor_refunded:      'urgent',
  auth_required:        'warn',
  captcha_required:     'warn',
  payment_declined:     'warn',
  stock_phantom:        'warn'
});

export class Sniper2Service {
  constructor({
    adapterRegistry,
    eventBus,
    transactionGuard,
    notificationService,
    egress,
    logger,
    scheduler,
    tenantId = 'local-user',
    clock = () => new Date()
  } = {}) {
    this.adapterRegistry = adapterRegistry;
    this.eventBus = eventBus;
    this.transactionGuard = transactionGuard;
    this.notificationService = notificationService ?? null;
    this.egress = egress;
    this.logger = logger;
    this.scheduler = scheduler ?? null;
    this.tenantId = tenantId;
    this.clock = clock;
    this.tasks = new Map();
    this.flows = new Map();
    this.acquirePool = new AcquirePool();
    this.paymentChannels = new Map();
    this.scheduledHandles = new Map();
  }

  async createTask(intent, opts = {}) {
    const taskId = makeTaskId();
    const machine = new SimpleMachine('sniper2ScheduledTask', 'configured', { taskId, intent }, ({ from, to }) => {
      this.eventBus?.emit({ topic: 'sniper2:task:state_changed', tenantId: this.tenantId, payload: { taskId, fromState: from, toState: to } });
    });
    this.tasks.set(taskId, {
      taskId,
      intent,
      machine,
      createdAt: this.clock(),
      sourceWatchId: intent?.sourceWatchId ?? null,
      autoDriveCtx: opts.autoCtx ?? null
    });
    if (intent?.scheduling?.triggerAt && this.scheduler?.schedule && opts.autoDrive !== false) {
      this.#scheduleAutoDrive(taskId, new Date(intent.scheduling.triggerAt), opts);
    }
    return taskId;
  }

  /**
   * Run acquire → enqueue → pre-pay recheck → settle in sequence. Failure short-circuits
   * later phases. Always emits a single `sniper2:task:terminal` event so other services
   * (e.g., Sniper3) can react without subscribing to per-step events.
   *
   * Pre-pay recheck (Invariant 4.1) defends against state phantom reads: between
   * acquire and settle (≥30s by PaymentChannel.minIntervalMs) the variant might be
   * gone or the price might exceed the guard. Set `opts.prepayRecheck: false` to
   * skip — the test fixtures use this when a snapshot is pre-supplied via ctx.
   */
  async runFullPipeline(taskId, ctx = {}, opts = {}) {
    const acquire = await this.runAcquirePhase(taskId, ctx);
    if (!acquire.ok) {
      const summary = { ok: false, phase: 'acquire', reason: acquire.reason, retriable: acquire.retriable, acquire };
      this.#emitTerminal(taskId, summary);
      return summary;
    }
    let enqueue;
    try {
      enqueue = this.enqueueForSettle(taskId, acquire.reservationToken);
    } catch (error) {
      const summary = { ok: false, phase: 'enqueue', reason: error.code ?? 'internal_error', acquire };
      this.#emitTerminal(taskId, summary);
      return summary;
    }
    if (enqueue?.risk === 'will_miss') {
      const summary = { ok: false, phase: 'enqueue', reason: 'acquire_expired', acquire, enqueue };
      this.#emitTerminal(taskId, summary);
      return summary;
    }
    if (opts.prepayRecheck !== false) {
      const recheck = await this.prepayRecheck(taskId, ctx);
      if (!recheck.ok) {
        const summary = { ok: false, phase: 'prepay_recheck', reason: recheck.reason, retriable: false, acquire, enqueue, recheck };
        this.#emitTerminal(taskId, summary);
        return summary;
      }
    }
    const settle = await this.runSettlePhase(taskId, ctx);
    const summary = {
      ok: settle.ok,
      phase: 'settle',
      reason: settle.ok ? null : settle.reason,
      retriable: settle.retriable,
      acquire,
      enqueue,
      settle
    };
    this.#emitTerminal(taskId, summary);
    // Post-settle verification (3.2 + 3.3): poll the vendor for late-cancellation
    // / oversold-refund / order-disappeared signals. Skipped when settle failed
    // or `opts.orderVerification: false`.
    if (summary.ok && summary.settle?.orderConfirmation && opts.orderVerification !== false) {
      this.scheduleOrderVerification(taskId, summary.settle.orderConfirmation, {
        ...ctx,
        intervalsMs: opts.orderVerificationIntervalsMs
      });
    }
    return summary;
  }

  /**
   * Schedule periodic adapter.fetchOrderStatus polls after a successful settle.
   * Detects two conditions surfaced as separate notifications:
   *   - 'cancelled' / 'refunded' → vendor_refunded notification (urgent) — 3.3
   *   - 'unknown' twice in a row → payment_timeout notification (urgent) — 3.2
   * Default cadence: 30s, 5min, 30min, 24h. Adapters that don't implement
   * fetchOrderStatus or return 'unknown' get the default heuristic.
   */
  scheduleOrderVerification(taskId, orderConfirmation, ctx = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const adapter = this.#adapter(task.intent);
    if (typeof adapter.fetchOrderStatus !== 'function') return null;
    if (!this.scheduler?.schedule) return null;
    const intervalsMs = ctx.intervalsMs ?? [30_000, 300_000, 1_800_000, 86_400_000];
    task.orderVerification = {
      attempts: 0,
      unknownStreak: 0,
      done: false,
      intervalsMs,
      orderConfirmation,
      ctxSnapshot: this.#verificationCtxFor(ctx)
    };
    this.#tickOrderVerification(taskId);
    return task.orderVerification;
  }

  #verificationCtxFor(ctx) {
    return {
      mobileSession: ctx.mobileSession,
      mobileBridge: ctx.mobileBridge,
      egress: ctx.egress ?? this.egress,
      logger: ctx.logger ?? this.logger,
      input: ctx.input ?? {},
      tenantId: this.tenantId
    };
  }

  #tickOrderVerification(taskId) {
    const task = this.tasks.get(taskId);
    if (!task?.orderVerification || task.orderVerification.done) return;
    const v = task.orderVerification;
    if (v.attempts >= v.intervalsMs.length) {
      v.done = true;
      return;
    }
    const delay = v.intervalsMs[v.attempts];
    v.attempts += 1;
    const triggerAt = new Date(this.clock().getTime() + delay);
    this.scheduler.schedule({
      triggerAt,
      leadTimeMs: 0,
      warmupMs: 0,
      onTrigger: async () => {
        const live = this.tasks.get(taskId);
        if (!live?.orderVerification || live.orderVerification.done) return;
        const adapter = this.#adapter(live.intent);
        let status = 'unknown';
        try {
          status = await adapter.fetchOrderStatus(v.orderConfirmation, v.ctxSnapshot);
        } catch {
          // network error during poll — continue to next attempt
          return this.#tickOrderVerification(taskId);
        }
        if (status === 'confirmed') {
          v.done = true;
          v.finalStatus = 'confirmed';
          this.eventBus?.emit({
            topic: 'sniper2:task:order_verified',
            tenantId: this.tenantId,
            payload: { taskId, orderConfirmation: v.orderConfirmation }
          });
          return;
        }
        if (status === 'cancelled' || status === 'refunded') {
          v.done = true;
          v.finalStatus = status;
          await this.#notifyVendorRefunded(live, v.orderConfirmation, status);
          return;
        }
        if (status === 'unknown') {
          v.unknownStreak += 1;
          if (v.unknownStreak >= 2) {
            v.done = true;
            v.finalStatus = 'timed_out';
            await this.#notifyPaymentTimeout(live, v.orderConfirmation);
            return;
          }
        } else if (status === 'pending') {
          v.unknownStreak = 0;
        }
        this.#tickOrderVerification(taskId);
      }
    });
  }

  async #notifyVendorRefunded(task, orderConfirmation, status) {
    this.eventBus?.emit({
      topic: 'sniper2:task:vendor_refunded',
      tenantId: this.tenantId,
      payload: { taskId: task.taskId, orderConfirmation, status }
    });
    if (!this.notificationService) return;
    try {
      await this.notificationService.notify({
        scope: 'sniper2',
        category: 'vendor_refunded',
        severity: 'urgent',
        payload: {
          taskId: task.taskId,
          orderId: orderConfirmation?.orderId,
          status,
          siteId: task.intent?.product?.siteId,
          totalChargedCents: orderConfirmation?.totalChargedCents
        },
        tenantId: this.tenantId
      });
    } catch { /* swallow notification failure */ }
  }

  async #notifyPaymentTimeout(task, orderConfirmation) {
    this.eventBus?.emit({
      topic: 'sniper2:task:payment_timeout',
      tenantId: this.tenantId,
      payload: { taskId: task.taskId, orderConfirmation }
    });
    if (!this.notificationService) return;
    try {
      // Order disappeared from vendor after a successful settle. We don't know
      // for sure whether the charge landed — the user must check their card and
      // the vendor's order page. Use task_failed with urgent severity + the
      // explicit reason so the UI can format a "支付超时，请检查支付状态" banner.
      await this.notificationService.notify({
        scope: 'sniper2',
        category: 'task_failed',
        severity: 'urgent',
        payload: {
          taskId: task.taskId,
          reason: 'payment_timeout',
          orderId: orderConfirmation?.orderId,
          message: 'Order disappeared from vendor after settle — payment may have timed out',
          siteId: task.intent?.product?.siteId,
          totalChargedCents: orderConfirmation?.totalChargedCents
        },
        tenantId: this.tenantId
      });
    } catch { /* swallow notification failure */ }
  }

  /**
   * Pre-pay state recheck. Re-fetches a fresh product snapshot and re-runs price
   * guard + variant match BEFORE the card is charged. If the user-supplied ctx
   * already has a snapshot, we skip the network fetch — but we still re-validate
   * against the latest priceGuard to catch config changes mid-flight.
   */
  async prepayRecheck(taskId, ctx = {}) {
    const task = this.#task(taskId);
    const adapter = this.#adapter(task.intent);
    const decision = this.transactionGuard?.evaluate(ctx.transactionControl) ?? { dryRunMode: ctx.dryRunMode !== false };
    const adapterCtx = {
      ...this.#adapterContext(task.intent, adapter, ctx, decision),
      input: ctx.input ?? {},
      mobileSession: ctx.mobileSession,
      headers: ctx.headers
    };
    let freshSnapshot;
    try {
      freshSnapshot = ctx.recheckSnapshot
        ?? (await adapter.fetchProductSnapshot?.(task.intent.product.productUrl, adapterCtx))
        ?? ctx.snapshot;
    } catch (error) {
      // Snapshot fetch failed — abort settle defensively. Better to lose the
      // reservation than to charge for something we can't verify.
      return { ok: false, reason: 'stock_phantom_read', cause: error.code ?? 'network_error' };
    }
    if (!freshSnapshot) {
      // No snapshot at all means we can't verify — fail closed.
      return { ok: false, reason: 'stock_phantom_read', cause: 'no_snapshot' };
    }
    const priceGuard = checkPriceGuard(freshSnapshot, task.intent);
    if (!priceGuard.pass) {
      return { ok: false, reason: 'stock_phantom_read', cause: priceGuard.reason };
    }
    const variantGuard = checkVariantMatch(freshSnapshot, task.intent);
    if (!variantGuard.pass) {
      return { ok: false, reason: 'stock_phantom_read', cause: variantGuard.reason };
    }
    return { ok: true, snapshot: freshSnapshot };
  }

  #scheduleAutoDrive(taskId, triggerAt, opts) {
    const handle = this.scheduler.schedule({
      triggerAt,
      leadTimeMs: opts.leadTimeMs ?? 5000,
      warmupMs: opts.warmupMs ?? 60000,
      onWarmup: opts.onWarmup,
      onTrigger: async () => {
        const ctx = opts.autoCtx ?? this.#defaultAutoCtx();
        const summary = await this.runFullPipeline(taskId, ctx);
        if (typeof opts.onComplete === 'function') {
          try { await opts.onComplete(summary); } catch { /* swallow callback errors */ }
        }
      },
      onMiss: (reason) => {
        const summary = { ok: false, phase: 'schedule', reason: reason ?? 'missed' };
        this.#emitTerminal(taskId, summary);
        if (typeof opts.onComplete === 'function') {
          opts.onComplete(summary);
        }
      },
      serverTimeProvider: opts.serverTimeProvider
    });
    this.scheduledHandles.set(taskId, handle);
  }

  #defaultAutoCtx() {
    return {
      transactionControl: { developerMode: false, executeLive: false },
      egress: this.egress,
      logger: this.logger,
      tenantId: this.tenantId,
      input: {},
      env: {}
    };
  }

  #emitTerminal(taskId, summary) {
    const task = this.tasks.get(taskId);
    this.eventBus?.emit({
      topic: 'sniper2:task:terminal',
      tenantId: this.tenantId,
      payload: {
        taskId,
        sourceWatchId: task?.sourceWatchId ?? null,
        ok: summary.ok,
        reason: summary.reason ?? null,
        phase: summary.phase ?? null
      }
    });
    // Notify user on actionable failures + freeze the PaymentChannel on 3DS so
    // sibling tasks on the same card don't fire while the user is on their phone.
    if (!summary.ok && summary.reason) {
      this.#notifyTerminalReason(task, summary).catch(() => {});
      if (summary.reason === 'payment_3ds_required' && task?.intent?.payment?.methodRef) {
        const channel = this.paymentChannels.get(`channel:${task.intent.payment.methodRef}`);
        channel?.freeze('payment_3ds_required: awaiting issuer challenge confirmation');
      }
    }
  }

  async #notifyTerminalReason(task, summary) {
    if (!this.notificationService || !task) return;
    const category = ERROR_TO_NOTIFICATION_CATEGORY[summary.reason];
    if (!category) return;
    try {
      await this.notificationService.notify({
        scope: 'sniper2',
        category,
        severity: ERROR_NOTIFICATION_SEVERITY[category] ?? 'warn',
        payload: {
          taskId: task.taskId,
          reason: summary.reason,
          phase: summary.phase,
          siteId: task.intent?.product?.siteId,
          productUrl: task.intent?.product?.productUrl
        },
        tenantId: this.tenantId
      });
    } catch {
      // notification failures must never block the terminal-emit path
    }
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return { taskId, state: task.machine.state, intent: task.intent, createdAt: task.createdAt };
  }

  pauseTask(taskId) {
    this.getTask(taskId);
  }

  resumeTask(taskId) {
    this.getTask(taskId);
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    task.machine.send('cancel');
  }

  selectEngine(intent) {
    const adapter = this.adapterRegistry?.resolveOrdering(intent.product.siteId) ?? this.adapterRegistry?.resolveOrdering(intent.product.productUrl);
    if (!adapter) throw codeError('adapter_not_found', `No ordering adapter for ${intent.product.siteId}`);
    if (adapter.capabilities.supportsHttpStrategy) return 'http';
    if (adapter.capabilities.supportsBrowserStrategy) return 'browser';
    if (adapter.capabilities.supportsMobileStrategy) return 'mobile-android';
    throw codeError('adapter_not_found', 'No supported execution engine');
  }

  registerFlow(flow) {
    this.flows.set(`${flow.flow_id}@${flow.version}`, flow);
    return `${flow.flow_id}@${flow.version}`;
  }

  getFlow(flowRef) {
    const flow = this.flows.get(flowRef);
    if (!flow) throw codeError('flow_validation_failed', `Unknown flow: ${flowRef}`);
    return flow;
  }

  async runAcquirePhase(taskId, ctx = {}) {
    const task = this.#task(taskId);
    const adapter = this.#adapter(task.intent);
    const decision = this.transactionGuard?.evaluate(ctx.transactionControl) ?? { dryRunMode: ctx.dryRunMode !== false, liveAllowed: ctx.dryRunMode === false };
    const adapterCtx = this.#adapterContext(task.intent, adapter, ctx, decision);
    const snapshot = ctx.snapshot ?? await adapter.fetchProductSnapshot(task.intent.product.productUrl, adapterCtx);
    const priceGuard = checkPriceGuard(snapshot, task.intent);
    if (!priceGuard.pass) return { ok: false, reason: priceGuard.reason, retriable: false };
    const variantGuard = checkVariantMatch(snapshot, task.intent);
    if (!variantGuard.pass) return { ok: false, reason: variantGuard.reason, retriable: false };
    const slot = await this.acquirePool.acquire(adapter.siteId, taskId);
    task.machine.send('strike');
    task.machine.send('acquire');
    try {
      const flow = ctx.flow ?? this.getFlow(task.intent.flow);
      const engine = this.#engine(adapter, ctx, adapterCtx);
      const result = await executeAcquirePhase({
        taskId,
        flow,
        adapter,
        engine,
        intent: task.intent,
        snapshot,
        context: {
          ...adapterCtx,
          dryRunMode: decision.dryRunMode,
          input: ctx.input ?? {},
          env: ctx.env ?? {},
          resolvedVariant: resolveVariant(snapshot, task.intent)
        }
      });
      task.acquireResult = result;
      if (result.ok) task.machine.send('acquired');
      else task.machine.send('acquireFailed');
      return result;
    } finally {
      this.acquirePool.release(slot);
    }
  }

  enqueueForSettle(taskId, token) {
    const task = this.#task(taskId);
    const adapter = this.#adapter(task.intent);
    const channel = this.#paymentChannel(task.intent.payment.methodRef, adapter);
    const reservationToken = token ?? task.acquireResult?.reservationToken;
    const reservationExpiresAt = task.acquireResult?.reservationExpiresAt;
    if (!reservationToken || !reservationExpiresAt) throw codeError('acquire_expired', 'Task has no active reservation');
    const flow = this.getFlow(task.intent.flow);
    const result = channel.enqueue({
      taskId,
      acquiredAt: new Date(),
      reservationExpiresAt,
      estimatedDurationMs: adapter.capabilities.typicalSettleDurationMs,
      flowSettlePhase: flow.phases.settle,
      reservationToken,
      maxRetries: 3,
      retryBackoffMs: 1000,
      totalCents: task.acquireResult.resolvedVariant?.variant?.unitPriceCents ?? 0
    });
    task.machine.send('queued');
    return result;
  }

  async runSettlePhase(taskId, ctx = {}) {
    const task = this.#task(taskId);
    const adapter = this.#adapter(task.intent);
    const decision = this.transactionGuard?.assertAllowed(ctx.transactionControl, {
      action: 'sniper2.settle',
      siteId: adapter.siteId,
      amountCents: task.acquireResult?.resolvedVariant?.variant?.unitPriceCents
    }) ?? { dryRunMode: false, liveAllowed: true };
    const channel = this.#paymentChannel(task.intent.payment.methodRef, adapter);
    let paymentTask = channel.currentlyProcessing?.taskId === taskId ? channel.currentlyProcessing : channel.startNext({ forceNow: ctx.forceNow === true });
    if (!paymentTask || paymentTask.taskId !== taskId) throw codeError('payment_channel_full', 'Task is not next in the payment channel');
    task.machine.send('paymentStart');
    const adapterCtx = this.#adapterContext(task.intent, adapter, ctx, decision);
    const result = await executeSettlePhase({
      taskId,
      flow: ctx.flow ?? this.getFlow(task.intent.flow),
      adapter,
      engine: this.#engine(adapter, ctx, adapterCtx),
      paymentTask,
      context: { ...adapterCtx, dryRunMode: decision.dryRunMode, input: ctx.input ?? {}, env: ctx.env ?? {} }
    });
    if (result.ok) {
      channel.complete(taskId, { ok: true });
      task.machine.send('paymentSucceeded');
    } else {
      channel.complete(taskId, { ok: false });
      task.machine.send(result.reason === 'payment_timeout' ? 'paymentTimeout' : 'paymentFailed');
    }
    task.settleResult = result;
    return result;
  }

  #task(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  #adapter(intent) {
    const adapter = this.adapterRegistry?.resolveOrdering(intent.product.siteId) ?? this.adapterRegistry?.resolveOrdering(intent.product.productUrl);
    if (!adapter) throw codeError('adapter_not_found', `No ordering adapter for ${intent.product.siteId}`);
    return adapter;
  }

  #adapterContext(intent, adapter, ctx, decision) {
    return {
      credentialRef: ctx.credentialRef ?? intent.payment?.methodRef,
      egress: ctx.egress ?? this.egress,
      browserPool: ctx.browserPool,
      mobileBridge: ctx.mobileBridge,
      logger: ctx.logger ?? this.logger,
      scope: ctx.scope ?? 'sniper2',
      tenantId: this.tenantId,
      dryRunMode: decision.dryRunMode
    };
  }

  #engine(adapter, ctx, adapterCtx) {
    const selected = ctx.engine ?? adapter.selectEngine(adapterCtx);
    const siteConfig = adapter.config ?? null;     // BaseHtml/BaseMobileFlow expose config; legacy fixtures don't
    if (selected === 'http') return new HttpExecutionEngine({ egress: adapterCtx.egress, logger: adapterCtx.logger, siteConfig });
    if (selected === 'browser') return new BrowserExecutionEngine({ browserPool: adapterCtx.browserPool, logger: adapterCtx.logger });
    if (selected === 'mobile-android') return new MobileExecutionEngine({ mobileBridge: adapterCtx.mobileBridge, session: ctx.mobileSession });
    throw codeError('adapter_not_found', `Unsupported engine: ${selected}`);
  }

  #paymentChannel(methodRef, adapter) {
    const id = `channel:${methodRef}`;
    if (!this.paymentChannels.has(id)) {
      this.paymentChannels.set(id, new PaymentChannel({
        id,
        methodRef,
        type: 'creditcard',
        minIntervalMs: 30000,
        typicalDurationMs: adapter.capabilities.typicalSettleDurationMs,
        hasOTP: false
      }));
    }
    return this.paymentChannels.get(id);
  }
}

export function resolveVariant(snapshot, intent) {
  const required = intent.product.requiredVariants;
  const exact = snapshot.variants.find((variant) => variant.inStock && matchesVariant(variant, required));
  if (exact) return { variant: exact, matchedFromList: 'required' };
  for (const [index, fallback] of (intent.product.fallbackVariants ?? []).entries()) {
    const variant = snapshot.variants.find((candidate) => candidate.inStock && matchesVariant(candidate, fallback));
    if (variant) return { variant, matchedFromList: 'fallback', fallbackIndex: index };
  }
  return null;
}

export function allocateQuantity(intent, availableStock = Number.POSITIVE_INFINITY) {
  const quantity = intent.quantity;
  if (quantity.type === 'exact') {
    if (availableStock < quantity.value) return { ok: false, reason: 'stock_sold_out' };
    return { ok: true, quantity: quantity.value };
  }
  const selected = Math.min(quantity.preferred, quantity.max, availableStock);
  if (selected < quantity.min) return { ok: false, reason: 'stock_sold_out' };
  return { ok: true, quantity: selected };
}

export function checkPriceGuard(snapshot, intent) {
  const cheapest = Math.min(...snapshot.variants.filter((variant) => variant.inStock).map((variant) => variant.unitPriceCents));
  if (!Number.isFinite(cheapest)) return { pass: false, reason: 'stock_sold_out', userMessage: 'No in-stock variant was found.' };
  if (cheapest > intent.priceGuard.maxUnitPrice) {
    return { pass: false, reason: 'price_guard_violated', userMessage: 'Current price exceeds the configured cap.' };
  }
  return { pass: true };
}

export function checkVariantMatch(snapshot, intent) {
  const resolved = resolveVariant(snapshot, intent);
  if (!resolved) return { pass: false, reason: 'variant_unavailable', userMessage: 'Required and fallback variants are unavailable.' };
  return { pass: true };
}

function matchesVariant(variant, required) {
  return Object.entries(required).every(([key, value]) => variant.attributes[key] === value);
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
