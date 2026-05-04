# Sniper1 — Auction

eBay / Goodwill / similar HTML auction sites. Bid 5s before auction end. Web only.

**Sniper1 never auto-pays.** On `won`, the system transitions to `pending_user_payment`, calls `NotificationService.notify({ category: 'auction_won' })`, and waits for the user to pay manually within the site's grace window. See `02-core/state-machines.md` for the win-flow state machine.

## Defaults

- Auto-bump: **off**, opt-in per item
- Tie bump: max 1 trigger per item
- Outbid bump: max 1 trigger per item
- Notification on win: enabled by default
- Reminder before payDeadline: 24h ahead

## Function Inventory

### WatchList

```ts
addWatchedItem(siteId: string, urlOrId: string, options: AddOptions): Promise<ItemId>
removeWatchedItem(itemId: ItemId, refundPolicy: RefundPolicy): Promise<void>
listWatchedItems(filter: ItemFilter): Promise<ItemView[]>
getItemDetail(itemId: ItemId): Promise<ItemDetail>
refreshItemNow(itemId: ItemId): Promise<ItemSnapshot>      // 5s rate-limited
```

### Polling

```ts
registerForPolling(itemId: ItemId, endsAt: Date): void
unregisterFromPolling(itemId: ItemId): void
getPollingTier(itemId: ItemId): PollingTier
forcePollingTier(itemId: ItemId, tier: PollingTier, durationMs: number): void
```

### Bidding

```ts
armItem(itemId: ItemId, strategy: BidStrategy): void
disarmItem(itemId: ItemId): void
computeBidAmount(itemId: ItemId, snapshot: ItemSnapshot): Money    // pure
executeBid(itemId: ItemId, amount: Money): Promise<BidResult>
handleBidOutcome(itemId: ItemId, result: BidResult): Promise<void>
```

### AutoBump

```ts
shouldBumpOnTie(itemId, snapshot, history): BumpDecision           // pure
shouldBumpOnOutbid(itemId, snapshot, history): BumpDecision        // pure
applyBump(itemId, decision): Promise<BidResult>
```

### Win-flow (NEW in v0.5)

```ts
notifyWinAndScheduleReminders(itemId: ItemId, outcome: BidResult): Promise<void>
markPaymentCompleted(itemId: ItemId, confirmedAt?: Date): Promise<void>
markPaymentOverdue(itemId: ItemId): Promise<void>
getPaymentDeadline(itemId: ItemId): Date | null
fetchPaymentStatus(itemId: ItemId): Promise<'unpaid' | 'paid' | 'overdue' | 'unknown'>  // optional, requires adapter support
```

`notifyWinAndScheduleReminders` is invoked automatically by `handleBidOutcome` when `result.ok && result.markedWon`. It:

1. Reads `payDeadline = adapter.payDeadlineFromOutcome(outcome)`
2. Reads `payUrl = adapter.payUrlFor(itemId)`
3. Sends `NotificationService.notify({ scope: 'sniper1', category: 'auction_won', severity: 'urgent', payload: { itemId, siteId, finalPriceCents, payDeadline, payUrl }, reminderAt: payDeadline - 24h })`
4. Schedules `paymentDeadlineHit` event for the state machine via `PrecisionScheduler` at `payDeadline + 1ms`
5. Stores `winOutcome` in machine context
6. State transitions: `won → pending_user_payment`

`markPaymentCompleted` is called by:
- API `POST /api/v1/sniper1/items/:id/markPaid` (user UI)
- Or `fetchPaymentStatus` polling if adapter supports it (returns `'paid'`)

### Budget (scope: sniper1)

```ts
allocateBudgetTo(itemId: ItemId, amount: Money): Promise<void>
redistributeBudget(sourceItemId: ItemId, policy: AllocationPolicy): Promise<AllocationResult>
```

Strategies: `Proportional` | `Targeted`.

### Stats

```ts
getSpendingStats(range: DateRange, groupBy: GroupBy): SpendingReport
getBidHistory(filter: BidHistoryFilter): BidEvent[]
getWinLossStats(range: DateRange): WinLossReport
```

## Bump Rules (precise)

### Tie

- Trigger: `bidResult.highBidderIsMe == false && currentPrice == myLastBidAmount`
- Action: bid `currentPrice + minIncrement`
- Limit: `bumpUsage.tieUsed == false`
- Timing: immediately after `handleBidOutcome`, no waiting for next poll

### Outbid

- Trigger: `hasBeenWinningOnce == true && currentSnapshot.highBidderIsMe == false`
- Action: bid `currentPrice + uniform(rangeUsd[0], rangeUsd[1]) * 100`
- Limit: `bumpUsage.outbidUsed == false`
- Hard cap: result must not exceed `budgetCents`

Both counters in `ItemContext.bumpUsage`, persisted in machine state.

## Options Schema

```ts
interface AddOptions {
  budget: Money;
  bumpStrategies?: {
    onTie?: { enabled: true; maxTimes: 1 };
    onOutbid?: { enabled: true; rangeUsd: [number, number]; maxTimes: 1 };
  };
  notifyOnWin?: boolean;             // default true (NEW v0.5)
  reminderLeadMs?: number;           // default 86400000 = 24h (NEW v0.5)
}
```

If `bumpStrategies` undefined, fall back to `userPreferences.sniper1.defaultBumpStrategies`.

## Cancel Flow

`cancelItem(itemId, refundPolicy)`:

- `refundPolicy: 'redistribute_proportional'` — reallocate to other active items by their original budget weight
- `refundPolicy: 'redistribute_to'` — `targetItemIds` required
- `refundPolicy: 'return_to_pool'` — back to total budget

UI must prompt user to choose if not specified.

Cancel after `won → pending_user_payment` cancels reminders and notifications but does NOT refund budget (the auction was won; the money obligation is real even if the user lets payment lapse). Budget commit transitions to `spent` on `userMarkPaid`, or stays `committed` (effectively orphaned) on `payment_overdue` until the user explicitly resolves.

## Invariants

- All items' current_budget + spent ≤ total_budget
- Bump counter persisted in state machine context only
- Redistribute is transactional: source debit + target credits in one DB transaction
- All money operations write `sniper1_budget_ledger` event
- Sniper1 never enters `PaymentChannel`
- `won → pending_user_payment` MUST emit a `NotificationService.notify` and schedule the deadline reminder

## Implementation Files

```
packages/server/sniper1-service/
├── watchlist/
├── polling/
├── bidding/
├── auto-bump/
│   ├── tie-rule.ts
│   ├── outbid-rule.ts
│   └── apply-bump.ts
├── win-flow/                         # NEW v0.5
│   ├── notify-win.ts
│   ├── reminder-scheduler.ts
│   └── payment-status-poll.ts        # optional, adapter-dependent
├── budget/
│   ├── engine.ts                     # instantiates BudgetEngine('sniper1')
│   ├── allocation-strategies/
│   └── ledger.ts
├── stats/
└── routes.ts
```
