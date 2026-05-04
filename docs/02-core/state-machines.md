# State Machines

XState v5. Each sniper has independent machines. Persisted to SQLite.

## Machine List

| File | Scope |
|---|---|
| `sniper1-item.machine.ts` | Auction item lifecycle |
| `sniper2-scheduled-task.machine.ts` | Scheduled order |
| `sniper2-immediate-task.machine.ts` | Immediate order |
| `sniper3-watch.machine.ts` | Long-term restock watch |
| `acquire-settle-execution.machine.ts` | Acquire/Settle sub-machine, invoked by sniper2/3 |

## Sniper1 Item

States:
```
draft
  → watching
      → armed
          → bidding
              → winning
              → outbid → (auto-bump?)
                  → bidding
                  → lost
              → bid_failed
      → won
          → pending_user_payment       (terminal of automation; user pays manually)
              → paid                   (terminal; user marked paid OR adapter detected)
              → payment_overdue        (terminal; deadline passed)
      → lost
  → cancelled
  → expired
```

Sniper1 never enters PaymentChannel. Once `won`, the system emits a `NotificationService.notify({ category: 'auction_won', ... })` carrying `payDeadline` + `payUrl`, schedules a reminder at `payDeadline - 24h`, and waits for the user to either confirm payment (`userMarkPaid` event → `paid`) or for the deadline to elapse (`paymentDeadlineHit` event → `payment_overdue`). Optionally, an adapter that supports `fetchPaymentStatus` may detect payment and emit `adapterDetectPaid`.

Events:
- `arm` / `disarm`
- `tick` (polling update)
- `executeBid`
- `bidResult`
- `bumpDecision`
- `markWon` (transitions `winning → won`, then immediately `won → pending_user_payment` via auto-action)
- `userMarkPaid` (UI / API — user confirmed they completed payment)
- `adapterDetectPaid` (optional, via periodic `fetchPaymentStatus` polling)
- `paymentDeadlineHit` (reminder scheduler fires past deadline)
- `cancel`
- `markExpired`

Context:
```ts
interface ItemContext {
  itemId: string;
  budgetCents: number;
  bumpStrategies?: BumpStrategies;
  bumpUsage: { tieUsed: boolean; outbidUsed: boolean };
  hasBeenWinningOnce: boolean;
  bidHistory: BidEvent[];
  lastSnapshot: ItemSnapshot;
  // populated when state enters `pending_user_payment`
  winOutcome?: {
    finalPriceCents: Money;
    payDeadline: Date;
    payUrl: string;
    notifiedAt: Date;
    reminderScheduledAt?: Date;
  };
}
```

Terminal states for sniper1Item: `paid`, `payment_overdue`, `lost`, `cancelled`, `expired`.

## Sniper2 ScheduledTask

States:
```
draft
  → configured
  → prewarming
  → armed
  → striking
  → acquiring
      → acquire_failed
      → acquired
          → queued_for_payment
              → paying
                  → succeeded
                  → payment_failed
                  → payment_timeout
              → acquire_expired
  → cancelled
  → missed
```

Events:
- `configure`
- `prewarm` / `prewarmDone` / `prewarmFailed`
- `strike`
- `acquireResult`
- `enqueueResult`
- `paymentStart` / `paymentResult`
- `cancel`
- `markMissed`

## Sniper2 ImmediateTask

Subset of ScheduledTask: skips `prewarming` and `armed`, goes directly `configured → striking`.

## Sniper3 Watch

States:
```
draft
  → configured
  → monitoring ⇄ suspended
  → triggered
      → confirming         (if requireConfirmation)
      → executing          (invokes acquire-settle machine)
          → succeeded
              → continued (if continueAfterSuccess)
              → exhausted
          → failed
              → continued
              → exhausted
  → expired
  → cancelled
```

Events:
- `configure`
- `signal` (from SignalSource)
- `confirmFromUser`
- `executionResult`
- `pause` / `resume`
- `cancel`
- `markExpired`

## AcquireSettleExecution (sub-machine)

States:
```
acquiring
  → acquire_failed
  → acquired
  → queued_for_payment
  → paying
      → succeeded
      → payment_failed
      → payment_timeout
  → acquire_expired
```

Invoked by sniper2 task or sniper3 watch via XState `invoke`.

## Conventions

- All states persisted to `{scope}_tasks.state` column on transition
- All transitions emit event on EventBus
- Guards are pure functions, importable for unit test
- Actions invoke services (async), sub-machines via `invoke`
- Machine restored on process restart from persisted snapshot

## Persistence Format

```sql
CREATE TABLE {scope}_tasks (
  ...
  machine_state TEXT NOT NULL,        -- e.g. 'acquiring'
  machine_context JSON NOT NULL,      -- xstate context
  updated_at TIMESTAMP NOT NULL
);
```

## Test Strategy

- Unit test every machine: cover all transitions
- Property test: from any state, all event sequences end in a final state (no deadlock)
- Coverage target: > 95% on machine files
