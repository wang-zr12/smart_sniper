# PaymentChannel

FIFO queue per payment method, EDF rebalance, captcha freeze.

## Interface

```ts
interface PaymentChannel {
  readonly id: string;                 // 'channel:visa-1234'
  readonly methodRef: CredentialRef;
  readonly type: 'creditcard' | 'wallet' | 'balance';
  readonly minIntervalMs: number;      // default 30000
  readonly typicalDurationMs: number;  // adapter-declared
  readonly hasOTP: boolean;

  enqueue(task: PaymentTask): EnqueueResult;
  dequeue(taskId: string): void;
  rebalance(): void;
  inspect(): QueueState;
  freeze(reason: string): void;
  unfreeze(): void;
}
```

## Types

```ts
interface PaymentTask {
  taskId: string;
  acquiredAt: Date;
  reservationExpiresAt: Date;
  estimatedDurationMs: number;
  flowSettlePhase: FlowStep[];
  reservationToken: ReservationToken;
  maxRetries: number;
  retryBackoffMs: number;
}

interface EnqueueResult {
  position: number;
  estimatedStartAt: Date;
  willCompleteBy: Date;
  isSafe: boolean;
  risk: 'safe' | 'tight' | 'will_miss';
  warnings: string[];
}

interface QueueState {
  channelId: string;
  isFrozen: boolean;
  frozenReason?: string;
  currentlyProcessing: ProcessingTask | null;
  pending: PendingTask[];
  averageActualDurationMs: number;
  recentSuccessRate: number;
}
```

## EDF Rebalance Algorithm

```
function rebalance(queue):
  pending = queue.filter(state == queued)
  pending.sort(asc by reservationExpiresAt)
  
  last_finish = currentlyProcessing?.expectedFinishAt ?? now
  
  for task in pending:
    earliest_safe_start = max(now, last_finish + minIntervalMs)
    estimated_finish = earliest_safe_start + estimatedDurationMs
    
    margin = task.reservationExpiresAt - estimated_finish
    
    if margin < 0:
      task.risk = 'will_miss'
    elif margin < 120_000:
      task.risk = 'tight'
    else:
      task.risk = 'safe'
    
    task.estimatedStartAt = earliest_safe_start
    last_finish = estimated_finish
```

Triggered on:
- new task enqueued
- task dequeued or completed
- failure / retry rescheduling

## Adaptive Duration

```
estimatedDurationMs starts at adapter's `typicalDurationMs`.
After N >= 5 successful payments on this channel, replace with running median.
Persist to DB so survives restart.
```

## Risk Threshold

| Margin | Risk | UI |
|---|---|---|
| `< 0` | `will_miss` | red, prompt user decision |
| `0 – 120s` | `tight` | yellow, info only |
| `>= 120s` | `safe` | green |

## Will-Miss User Decision

30s window. Options:
- `skip`: mark task `acquire_expired`, dequeue
- `force_now`: bypass minIntervalMs (one-time, this task only)
- `accept_risk`: keep schedule

Timeout default: `skip`.

`force_now` warning UI text: notes risk of bank decline / fraud detection.

## Freeze Behavior

```
freeze(reason):
  isFrozen = true
  current task: pause if mid-execution
  pending: hold
  emit event 'channel.frozen'
  push notification

unfreeze():
  isFrozen = false
  resume current task or move to next pending
  emit event 'channel.unfrozen'
```

Auto-unfreeze conditions:
- captcha resolved (adapter detects)
- OTP confirmed
- 5 min timeout (default) → all pending tasks fail with `payment_timeout` if their reservations expire

## Configuration

`tenants/{id}.json`:
```json
{
  "paymentChannels": [
    {
      "id": "visa-1234",
      "credentialRef": "cred:visa-1234",
      "type": "creditcard",
      "minIntervalMs": 30000,
      "hasOTP": true,
      "maxQueueSize": 10
    }
  ]
}
```

## Invariants

- Same channel: ≥ minIntervalMs between successive payment starts (unless `force_now` override)
- Frozen channel: no new task starts
- Reservation-expired payment: not interrupted mid-flight; allowed to complete
- One in-flight task per channel max

## Implementation Files

```
packages/server/order-shared/payment-channel/
├── payment-channel.ts
├── edf-scheduler.ts
├── risk-predictor.ts
├── freeze-manager.ts
├── duration-estimator.ts
├── persistence.ts
└── __tests__/
    ├── edf-rebalance.test.ts
    ├── will-miss-decision.test.ts
    ├── freeze-unfreeze.test.ts
    └── duration-adaptation.test.ts
```
