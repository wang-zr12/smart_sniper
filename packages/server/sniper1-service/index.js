import { makeItemId } from '../../core/domain-types/index.js';
import { BudgetEngine } from '../../core/budget-engine/index.js';
import { SimpleMachine } from '../../core/state-machine/index.js';

const DEFAULT_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

export class Sniper1Service {
  constructor({
    adapterRegistry,
    eventBus,
    transactionGuard,
    notificationService,
    scheduler,
    tenantId = 'local-user',
    clock = () => new Date()
  } = {}) {
    this.adapterRegistry = adapterRegistry;
    this.eventBus = eventBus;
    this.transactionGuard = transactionGuard;
    this.notificationService = notificationService ?? null;
    this.scheduler = scheduler ?? null;
    this.tenantId = tenantId;
    this.clock = clock;
    this.items = new Map();
    this.deadlineHandles = new Map();
    this.budget = new BudgetEngine('sniper1', {
      tenantId,
      auditLog: (event) => eventBus?.emit({ topic: 'shared:audit:event', tenantId, payload: event })
    });
  }

  async addWatchedItem(siteId, urlOrId, options) {
    const adapter = this.adapterRegistry?.resolveAuction(siteId) ?? this.adapterRegistry?.resolveAuction(urlOrId);
    if (!adapter) throw codeError('adapter_not_found', `No auction adapter for ${siteId}`);
    const itemId = makeItemId();
    const notifyOnWin = options.notifyOnWin !== false;
    const reminderLeadMs = options.reminderLeadMs ?? DEFAULT_REMINDER_LEAD_MS;
    const machine = new SimpleMachine('sniper1Item', 'watching', {
      itemId,
      budgetCents: options.budget,
      bumpStrategies: options.bumpStrategies,
      bumpUsage: { tieUsed: false, outbidUsed: false },
      hasBeenWinningOnce: false,
      bidHistory: [],
      notifyOnWin,
      reminderLeadMs
    }, ({ from, to }) => {
      this.eventBus?.emit({ topic: 'sniper1:item:state_changed', tenantId: this.tenantId, payload: { itemId, fromState: from, toState: to } });
    });
    this.items.set(itemId, {
      itemId,
      siteId,
      urlOrId,
      adapter,
      strategy: null,
      machine,
      createdAt: new Date()
    });
    if (this.budget.availableCents() < options.budget) {
      const shortfall = options.budget - this.budget.availableCents();
      this.budget.setTotalBudget(this.budget.totalCents() + shortfall, 'auto-expand local MVP budget');
    }
    this.budget.commit(itemId, options.budget, 'watch item allocation');
    return itemId;
  }

  async removeWatchedItem(itemId, refundPolicy = 'return_to_pool') {
    const item = this.#item(itemId);
    item.machine.send('cancel');
    this.#cancelDeadlineHandle(itemId);
    const committed = this.budget.committedCents(itemId);
    if (committed > 0) this.budget.release(itemId, committed, refundPolicy);
    this.items.delete(itemId);
  }

  listWatchedItems() {
    return [...this.items.values()].map((item) => this.#view(item));
  }

  getItemDetail(itemId) {
    return this.#view(this.#item(itemId));
  }

  async refreshItemNow(itemId, ctx) {
    const item = this.#item(itemId);
    const snapshot = await item.adapter.fetchSnapshot(itemId, ctx);
    item.machine.send('tick', {
      lastSnapshot: snapshot,
      hasBeenWinningOnce: item.machine.context.hasBeenWinningOnce || snapshot.highBidderIsMe
    });
    this.eventBus?.emit({ topic: 'sniper1:item:price_updated', tenantId: this.tenantId, payload: { itemId, snapshot, tier: 'hot' } });
    return snapshot;
  }

  armItem(itemId, strategy) {
    const item = this.#item(itemId);
    item.strategy = strategy;
    item.machine.send('arm');
  }

  disarmItem(itemId) {
    const item = this.#item(itemId);
    item.strategy = null;
    item.machine.send('disarm');
  }

  computeBidAmount(itemId, snapshot) {
    const item = this.#item(itemId);
    const committed = this.budget.committedCents(itemId);
    const desired = snapshot.currentPriceCents + snapshot.minIncrementCents;
    return Math.min(desired, committed);
  }

  async executeBid(itemId, amountCents, ctx) {
    const item = this.#item(itemId);
    const decision = this.transactionGuard?.assertAllowed(ctx?.transactionControl, {
      action: 'sniper1.placeBid',
      siteId: item.siteId,
      amountCents
    });
    if (ctx?.dryRunMode !== false && !decision?.liveAllowed) {
      throw codeError('user_cancelled', 'Live bid requires developer-mode transaction control');
    }
    item.machine.send('executeBid');
    const result = await item.adapter.placeBid(itemId, amountCents, {
      ...ctx,
      itemUrl: item.urlOrId,
      dryRunMode: false,
      liveTransactionAllowed: true
    });
    await this.handleBidOutcome(itemId, result, amountCents);
    return result;
  }

  async handleBidOutcome(itemId, result, amountCents = 0) {
    const item = this.#item(itemId);
    const event = {
      itemId,
      amountCents,
      result,
      triggeredBy: 'scheduler',
      at: new Date()
    };
    const nextHistory = [...item.machine.context.bidHistory, event];
    if (result.ok && result.highBidderIsMe) {
      item.machine.send('bidWinning', { bidHistory: nextHistory, hasBeenWinningOnce: true });
    } else if (result.ok) {
      item.machine.send('bidOutbid', { bidHistory: nextHistory });
    } else {
      item.machine.send('bidFailed', { bidHistory: nextHistory });
      await this.#notifyActionableBidFailure(item, result);
    }
    this.eventBus?.emit({ topic: 'sniper1:item:bid_executed', tenantId: this.tenantId, payload: { itemId, event } });
  }

  async #notifyActionableBidFailure(item, result) {
    if (!this.notificationService || !result?.reason) return;
    const map = {
      account_blocked:       { category: 'account_blocked',  severity: 'urgent' },
      session_expired:       { category: 'auth_required',    severity: 'warn'   },
      auth_required:         { category: 'auth_required',    severity: 'warn'   },
      captcha_encountered:   { category: 'captcha_required', severity: 'warn'   }
    };
    const target = map[result.reason];
    if (!target) return;
    try {
      await this.notificationService.notify({
        scope: 'sniper1',
        category: target.category,
        severity: target.severity,
        payload: {
          itemId: item.itemId,
          siteId: item.siteId,
          urlOrId: item.urlOrId,
          reason: result.reason
        },
        tenantId: this.tenantId
      });
    } catch { /* notification failure must not block bid handling */ }
  }

  /**
   * Mark an item as won and trigger the post-win user-payment flow.
   * Sniper1 NEVER auto-pays; this transitions to pending_user_payment, sends a notification,
   * and schedules a deadline reminder. Idempotent on already-pending items.
   */
  async markItemWon(itemId, outcome = {}) {
    const item = this.#item(itemId);
    const finalPriceCents = outcome.finalPriceCents ?? outcome.amountCents ?? this.#lastBidAmount(item);
    const now = this.clock();
    item.machine.send('markWon', { lastSnapshot: outcome.snapshot ?? item.machine.context.lastSnapshot });
    if (item.machine.state !== 'won') {
      throw codeError('task_already_terminal', `Item ${itemId} cannot transition to won from state ${item.machine.state}`);
    }

    const payDeadline = item.adapter.payDeadlineFromOutcome?.(outcome, { now }) ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const payUrl = item.adapter.payUrlFor?.(itemId) ?? null;
    const winOutcome = Object.freeze({
      finalPriceCents,
      payDeadline,
      payUrl,
      notifiedAt: now,
      reminderScheduledAt: item.machine.context.reminderLeadMs > 0
        ? new Date(payDeadline.getTime() - item.machine.context.reminderLeadMs)
        : null
    });

    item.machine.send('promoteToPendingPayment', { winOutcome });

    if (item.machine.context.notifyOnWin && this.notificationService) {
      try {
        await this.notificationService.notify({
          scope: 'sniper1',
          category: 'auction_won',
          severity: 'urgent',
          payload: {
            itemId,
            siteId: item.siteId,
            urlOrId: item.urlOrId,
            finalPriceCents,
            payDeadline: payDeadline.toISOString(),
            payUrl,
            payDeadlineDaysHint: Math.round((payDeadline.getTime() - now.getTime()) / (24 * 3600 * 1000))
          },
          reminderAt: winOutcome.reminderScheduledAt,
          tenantId: this.tenantId
        });
      } catch (error) {
        this.eventBus?.emit({
          topic: 'shared:audit:event',
          tenantId: this.tenantId,
          payload: { kind: 'notification_dispatch_failed', itemId, message: error.message }
        });
      }
    }

    this.#scheduleDeadlineEvent(itemId, payDeadline);
    this.eventBus?.emit({
      topic: 'sniper1:item:won',
      tenantId: this.tenantId,
      payload: { itemId, siteId: item.siteId, finalPriceCents, payDeadline, payUrl }
    });
    return winOutcome;
  }

  async markPaymentCompleted(itemId, confirmedAt = this.clock()) {
    const item = this.#item(itemId);
    if (item.machine.state !== 'pending_user_payment') {
      throw codeError('task_already_terminal', `Item ${itemId} is in state ${item.machine.state}, cannot mark paid`);
    }
    item.machine.send('userMarkPaid', { paidAt: confirmedAt });
    this.#cancelDeadlineHandle(itemId);
    const committed = this.budget.committedCents(itemId);
    if (committed > 0) {
      const finalPrice = item.machine.context.winOutcome?.finalPriceCents ?? committed;
      const spendAmount = Math.min(finalPrice, committed);
      if (spendAmount > 0) this.budget.spend(itemId, spendAmount, 'user marked paid');
      const leftover = committed - spendAmount;
      if (leftover > 0) this.budget.release(itemId, leftover, 'leftover after settled win');
    }
    this.eventBus?.emit({
      topic: 'sniper1:item:paid',
      tenantId: this.tenantId,
      payload: { itemId, paidAt: confirmedAt }
    });
  }

  async markPaymentOverdue(itemId) {
    const item = this.#item(itemId);
    if (item.machine.state !== 'pending_user_payment') return;
    item.machine.send('paymentDeadlineHit', { overdueAt: this.clock() });
    this.#cancelDeadlineHandle(itemId);
    if (this.notificationService) {
      try {
        await this.notificationService.notify({
          scope: 'sniper1',
          category: 'payment_overdue',
          severity: 'urgent',
          payload: {
            itemId,
            siteId: item.siteId,
            payUrl: item.machine.context.winOutcome?.payUrl ?? null
          },
          tenantId: this.tenantId
        });
      } catch {
        // notification failure already logged in audit; do not crash overdue path
      }
    }
    this.eventBus?.emit({
      topic: 'sniper1:item:payment_overdue',
      tenantId: this.tenantId,
      payload: { itemId }
    });
  }

  getPaymentDeadline(itemId) {
    const item = this.#item(itemId);
    return item.machine.context.winOutcome?.payDeadline ?? null;
  }

  #scheduleDeadlineEvent(itemId, payDeadline) {
    if (!this.scheduler?.schedule) return;
    const handle = this.scheduler.schedule({
      triggerAt: payDeadline,
      leadTimeMs: 0,
      warmupMs: 0,
      onTrigger: async () => {
        this.deadlineHandles.delete(itemId);
        await this.markPaymentOverdue(itemId);
      }
    });
    this.deadlineHandles.set(itemId, handle);
  }

  #cancelDeadlineHandle(itemId) {
    const handle = this.deadlineHandles.get(itemId);
    if (handle && this.scheduler?.cancel) this.scheduler.cancel(handle);
    this.deadlineHandles.delete(itemId);
  }

  #lastBidAmount(item) {
    const last = item.machine.context.bidHistory.at(-1);
    return last?.amountCents ?? 0;
  }

  #item(itemId) {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Unknown item: ${itemId}`);
    return item;
  }

  #view(item) {
    const ctx = item.machine.context;
    return {
      itemId: item.itemId,
      siteId: item.siteId,
      urlOrId: item.urlOrId,
      state: item.machine.state,
      budgetCents: this.budget.committedCents(item.itemId),
      createdAt: item.createdAt,
      winOutcome: ctx.winOutcome ?? null
    };
  }
}

export function shouldBumpOnTie(itemContext, snapshot) {
  const lastBid = itemContext.bidHistory.at(-1);
  if (itemContext.bumpUsage.tieUsed) return { bump: false, reason: 'tie bump already used' };
  if (!lastBid) return { bump: false, reason: 'no previous bid' };
  const tied = snapshot.highBidderIsMe === false && snapshot.currentPriceCents === lastBid.amountCents;
  if (!tied) return { bump: false, reason: 'not tied at last bid amount' };
  return { bump: true, amountCents: snapshot.currentPriceCents + snapshot.minIncrementCents, reason: 'tie bump' };
}

export function shouldBumpOnOutbid(itemContext, snapshot, rng = Math.random) {
  if (itemContext.bumpUsage.outbidUsed) return { bump: false, reason: 'outbid bump already used' };
  if (!itemContext.hasBeenWinningOnce || snapshot.highBidderIsMe) return { bump: false, reason: 'not newly outbid' };
  const range = itemContext.bumpStrategies?.onOutbid?.rangeUsd ?? [5, 10];
  const bumpCents = Math.round((range[0] + rng() * (range[1] - range[0])) * 100);
  const amountCents = snapshot.currentPriceCents + bumpCents;
  if (amountCents > itemContext.budgetCents) return { bump: false, reason: 'bump exceeds budget' };
  return { bump: true, amountCents, reason: 'outbid bump' };
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
