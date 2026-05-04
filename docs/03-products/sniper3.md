# Sniper3 — Long-term Restock Monitoring

Signal-driven. Watches run for days/months. See `04-shared/acquire-settle.md` for execution.

## RestockIntent

```ts
interface RestockIntent {
  product: ProductSelector;
  constraints: {
    maxUnitPrice: Money;
    requiredVariants: Record<string, string>;
    fallbackVariants?: Array<Record<string, string>>;
    maxQuantity: number;
  };
  policy: RestockPolicy;
  payment: { methodRef: CredentialRef };
  shipping: { addressRef: CredentialRef };
  flow: FlowRef;
  
  fallbackBehavior: 'abort_if_price_changed' | 'continue_within_tolerance';
  priceTolerance?: { type: 'percent' | 'absolute'; value: number };
}

interface RestockPolicy {
  expiresAt?: Date;
  triggerOn: 
    | 'any_stock'
    | { minStock: number }
    | { variantInStock: VariantSelector };
  continueAfterSuccess: boolean;       // default false
  maxOrders?: number;                  // default 1
  pollProfile: 'idle' | 'hint';
  requireConfirmation: boolean;
}
```

## Function Inventory

### Watch Management

```ts
createWatch(intent: RestockIntent): Promise<WatchId>
listWatches(filter: WatchFilter): Promise<WatchView[]>
getWatch(watchId: WatchId): Promise<WatchDetail>
pauseWatch(watchId: WatchId, reason: string): Promise<void>
resumeWatch(watchId: WatchId): Promise<void>
cancelWatch(watchId: WatchId): Promise<void>
getWatchHistory(watchId: WatchId): Promise<WatchHistoryReport>
```

### Signal Sources

```ts
interface SignalSource {
  readonly id: string;
  readonly siteId: string;
  readonly type: 'polling' | 'email' | 'rss' | 'webhook' | 'push' | 'thirdparty';
  start(watchId: WatchId, callback: SignalCallback): SignalSubscription;
  stop(subscription: SignalSubscription): void;
  health(): SignalSourceHealth;
}

interface StockSignal {
  watchId: WatchId;
  detectedAt: Date;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  snapshot?: ItemSnapshot;
}

registerSignalSource(siteId: string, source: SignalSource): void
listSignalSources(siteId?: string): SignalSourceMetadata[]
```

MVP impl: `polling` only. Interface allows adding `email` etc. without core changes.

### Signal Fusion

```ts
mergeSignals(watchId: WatchId, signals: StockSignal[]): FusedSignal
shouldTriggerAction(fusedSignal: FusedSignal, intent: RestockIntent): TriggerDecision
```

Confidence rules:
- 2+ sources both high → trigger immediately
- 1 source high → re-validate via polling once, then trigger
- only low/medium → re-validate, escalate cautiously

### Lifecycle

```ts
heartbeat(watchId: WatchId): HeartbeatStatus
requireConfirmationIfStale(watchId: WatchId, decision: TriggerDecision): ConfirmationRequest | null
detectPriceDrift(watchId: WatchId, snapshot: ItemSnapshot): PriceDriftReport
detectSpecDrift(watchId: WatchId, snapshot: ItemSnapshot): SpecDriftReport
```

Stale threshold: `userPreferences.sniper3.defaultStaleDays` (default 30). When stale watch triggers, send confirmation request as the watch enters `queued_for_payment` state (not when it triggers, to avoid blocking on user input during acquire).

### Safety Gate

```ts
checkRestockFreshness(watchId: WatchId): GuardResult
checkPriceDrift(snapshot, intent): GuardResult
checkSpecDrift(snapshot, intent): GuardResult
checkStockLegitimacy(snapshot): GuardResult       // detects fake stock signals
```

### History

```ts
interface WatchHistoryReport {
  watchId: WatchId;
  createdAt: Date;
  totalChecks: number;
  signalEvents: SignalEvent[];
  priceTimeline: PricePoint[];
  triggerAttempts: TriggerAttempt[];
  averageStockoutDuration?: number;
}
```

UI plots: price timeline + signal events + trigger results, on one chart.

### Budget (scope: sniper3)

Isolated. Cap from `userPreferences.sniper3.budgetCents`.

## Multi-watch Concurrent Hits

When multiple watches hit simultaneously:
- All hits run acquire phase in parallel (subject to `AcquirePool`)
- Watches that get reservation enter `PaymentChannel` queue
- Same payment method → EDF serialized
- Watches that fail acquire → return to `monitoring`

No mutual exclusion between watches. User may end up with multiple orders if they configured overlapping watches.

## Idle Tier Anti-detection

See `02-core/polling-tiers.md` § Idle Tier Special Rules.

## Implementation Files

```
packages/server/sniper3-service/
├── watch-management/
├── signal-sources/
│   ├── _interface/
│   ├── polling/
│   ├── email/                  # M7
│   ├── rss/                    # M7+
│   └── webhook/                # M7+
├── signal-fusion/
├── lifecycle/
├── budget/
├── safety-gate/
├── history/
└── routes.ts
```
