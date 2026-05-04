# WebSocket Events

Real-time push from server to Web UI. One channel: `/ws/v1/events`.

## Frame Format

```ts
type WsFrame =
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'event'; topic: string; payload: EventPayload };
```

Topics use `:` as separator. Wildcards: `sniper1:item:*` subscribes to all item events.

## Event Envelope

```ts
interface EventEnvelope<T> {
  topic: string;
  at: Date;                       // server time when emitted
  tenantId: TenantId;
  payload: T;
}
```

## Sniper1 Events

```ts
// topic: 'sniper1:item:state_changed'
interface ItemStateChanged {
  itemId: ItemId;
  fromState: string;
  toState: string;
  reason?: ErrorCode;
}

// topic: 'sniper1:item:price_updated'
interface ItemPriceUpdated {
  itemId: ItemId;
  snapshot: ItemSnapshot;
  tier: PollingTier;
}

// topic: 'sniper1:item:bid_executed'
interface ItemBidExecuted {
  itemId: ItemId;
  event: BidEvent;
}

// topic: 'sniper1:item:bump_triggered'
interface ItemBumpTriggered {
  itemId: ItemId;
  bumpType: 'tie' | 'outbid';
  amountCents: Money;
}

// topic: 'sniper1:budget:changed'
interface BudgetChanged {
  scope: SniperScope;
  totalCents: Money;
  committedCents: Money;
  spentCents: Money;
}
```

## Sniper2 Events

```ts
// topic: 'sniper2:task:state_changed'
interface TaskStateChanged {
  taskId: TaskId;
  fromState: string;
  toState: string;
  reason?: ErrorCode;
}

// topic: 'sniper2:task:prewarm_progress'
interface PrewarmProgress {
  taskId: TaskId;
  step: string;                   // e.g. 'logging_in', 'navigating', 'validating_variant'
  ok: boolean;
  detail?: string;
}

// topic: 'sniper2:task:acquired'
interface TaskAcquired {
  taskId: TaskId;
  reservationExpiresAt: Date;
  resolvedVariant: ResolvedVariant;
  estimatedPaymentStartAt: Date;  // from PaymentChannel
}

// topic: 'sniper2:task:will_miss_decision_required'
interface WillMissDecisionRequired {
  taskId: TaskId;
  channelId: string;
  decisionDeadline: Date;         // 30s window
  options: ('skip' | 'force_now' | 'accept_risk')[];
}
```

## Sniper3 Events

```ts
// topic: 'sniper3:watch:state_changed'
interface WatchStateChanged {
  watchId: WatchId;
  fromState: string;
  toState: string;
  reason?: ErrorCode;
}

// topic: 'sniper3:watch:signal_received'
interface SignalReceived {
  watchId: WatchId;
  signal: StockSignal;
}

// topic: 'sniper3:watch:confirmation_required'
interface ConfirmationRequired {
  watchId: WatchId;
  reason: 'stale' | 'price_drift' | 'spec_drift';
  decisionDeadline: Date;
  details: Record<string, unknown>;
}

// topic: 'sniper3:watch:price_drift_detected'
interface PriceDriftDetected {
  watchId: WatchId;
  originalPriceCents: Money;
  currentPriceCents: Money;
  toleranceExceeded: boolean;
}
```

## Shared Events

```ts
// topic: 'shared:payment_channel:state_changed'
interface PaymentChannelStateChanged {
  channelId: string;
  isFrozen: boolean;
  frozenReason?: string;
  queueLength: number;
}

// topic: 'shared:payment_channel:queue_changed'
interface PaymentChannelQueueChanged {
  channelId: string;
  queue: QueueState;
}

// topic: 'shared:vault:credential_changed'
interface VaultCredentialChanged {
  action: 'added' | 'updated' | 'deleted';
  ref: CredentialRef;
  metadata: CredentialRefMetadata;
}

// topic: 'shared:notification'
interface Notification {
  id: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  actions?: Array<{ id: string; label: string }>;
  dismissible: boolean;
}

// topic: 'shared:audit:event'
interface AuditEvent {
  id: number;
  scope: SniperScope | 'shared';
  category: string;               // 'bid' | 'payment' | 'budget_transfer' | ...
  payload: Record<string, unknown>;
  at: Date;
}
```

## Subscription Examples

```js
// subscribe to all sniper1 item state changes
ws.send({ type: 'subscribe', topics: ['sniper1:item:state_changed'] });

// subscribe to a specific task
ws.send({ type: 'subscribe', topics: ['sniper2:task:*:taskId=task-abc-123'] });

// subscribe to all
ws.send({ type: 'subscribe', topics: ['*'] });
```

Filter by entity ID via topic suffix: `sniper2:task:state_changed:taskId=<id>` (server expands to wildcards on subscription).

## Implementation Notes

- Backed by `EventBus` interface; `RedisBus` (future) will broadcast across nodes
- WS server filters per-connection by tenantId (all events scoped automatically)
- Heartbeat: 30s ping, 60s without pong closes connection
- Replay: connection accepts optional `?since=<eventId>` to replay missed events from `shared_audit_log`

## Implementation Files

```
packages/server/api/ws/
├── ws-server.ts
├── topic-router.ts
├── replay.ts
└── __tests__/
```
