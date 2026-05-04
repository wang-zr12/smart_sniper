# Sniper2 — Scheduled / Immediate Ordering

Web + Android app. See `04-shared/acquire-settle.md` for execution model.

## Task Types

```ts
type Sniper2Task = ScheduledTask | ImmediateTask;
```

## ScheduledOrderIntent

```ts
interface ScheduledOrderIntent {
  product: {
    siteId: string;
    productUrl: string;
    requiredVariants: Record<string, string>;
    fallbackVariants?: Array<Record<string, string>>;
  };
  quantity: 
    | { type: 'exact'; value: number }
    | { type: 'range'; min: number; max: number; preferred: number };
  priceGuard: {
    maxUnitPrice: Money;
    abortOnExceed: true;          // must be true
  };
  scheduling: {
    triggerAt: Date;
    triggerEarliestAt?: Date;
    triggerLatestAt?: Date;       // hard abort
  };
  payment: { methodRef: CredentialRef };
  shipping: { addressRef: CredentialRef };
  flow: FlowRef;
}
```

## ImmediateOrderIntent

Same as `ScheduledOrderIntent` minus `scheduling.triggerAt`. Triggers `now() + 5s`.

## Prewarm Schedule (T = trigger time)

| Time | Action |
|---|---|
| T − 30 min | Register, validate credentials, dryrun flow if cache > 24h old |
| T − 10 min | Launch browser/emulator, log in, navigate to product page |
| T − 5 min | Enter Warm tier, validate elements, price, variants |
| T − 90 s | Enter Hot tier, refresh stock |
| T − 30 s | Run all `phases.acquire` steps before "buy now" button |
| T − 5 s | Strike: time sync only |
| T = 0 | Trigger: execute remaining acquire steps |

## Function Inventory

### Task Management

```ts
createTask(intent: ScheduledOrderIntent | ImmediateOrderIntent): Promise<TaskId>
createScheduledTask(intent: ScheduledOrderIntent): Promise<TaskId>
createImmediateTask(intent: ImmediateOrderIntent): Promise<TaskId>
getTask(taskId: TaskId): Promise<TaskView>
pauseTask(taskId: TaskId): Promise<void>
resumeTask(taskId: TaskId): Promise<void>
cancelTask(taskId: TaskId): Promise<void>
```

### Variant / Quantity

```ts
resolveVariant(snapshot: ProductSnapshot, intent): ResolvedVariant | null
allocateQuantity(intent, availableStock?: number): AllocatedQuantity
```

`fallbackVariants` are tried in user-specified order. System never picks variants not listed.

### Prewarm

```ts
schedulePrewarm(taskId: TaskId, triggerAt: Date): void
prewarmSession(taskId: TaskId): Promise<PrewarmResult>
keepSessionAlive(taskId: TaskId): void
abortIfPrewarmFailed(taskId: TaskId): void
```

### Execution (delegates to acquire-settle)

```ts
runAcquirePhase(taskId: TaskId, ctx: ExecutionContext): Promise<AcquireResult>
enqueueForSettle(taskId: TaskId, token: ReservationToken): Promise<EnqueueResult>
runSettlePhase(taskId: TaskId, ctx: ExecutionContext): Promise<SettleResult>
```

### Safety Gate

```ts
checkPriceGuard(snapshot, intent): GuardResult
checkVariantMatch(snapshot, intent): GuardResult
checkPaymentLimit(intent, recentSpending): GuardResult
checkUserConfirmation(taskId): GuardResult
```

### Budget (scope: sniper2)

Same shape as sniper1, isolated instance. Cap from `userPreferences.sniper2.budgetCents`.

## Engine Selection

```ts
selectEngine(intent: OrderIntent): 'http' | 'browser' | 'mobile-android'
```

Order: HTTP if adapter declares API support → Browser → mobile-android.

`mobile-android` resolves to:
- local USB device if available
- cloud emulator pool otherwise (requires `mobile-bridge/emulator-pool/`)

iOS is never selected (no `'mobile-ios'` value exists).

## Implementation Files

```
packages/server/sniper2-service/
├── scheduled-task/
├── immediate-task/
├── prewarm-pipeline/
├── variant-matching/
├── reservation/
├── safety-gate/
├── budget/
└── routes.ts
```
