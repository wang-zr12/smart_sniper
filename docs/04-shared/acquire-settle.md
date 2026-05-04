# Acquire / Settle Two-Phase Execution

Used by Sniper2 and Sniper3.

## Concept

Order flow:
1. **Acquire**: navigate to checkout page, capture reservation token. Inventory locked at this point.
2. **Settle**: pay. Must complete within reservation timeout (typically 10 min).

## Phase Definitions

| Phase | Goal | Concurrency | Risk profile |
|---|---|---|---|
| Acquire | reach checkout, capture `reservation_token` | parallel via `AcquirePool` | low (mass-checkout is normal user behavior) |
| Settle | complete payment | serialized per `PaymentChannel` | high (rapid same-card charges trigger bank fraud) |

## State Machine (Sniper2 ScheduledTask)

```
... → striking → acquiring
                     → acquire_failed       (terminal failure)
                     → acquired             (milestone: stock locked)
                         → queued_for_payment
                             → paying
                                 → succeeded
                                 → payment_failed
                                 → payment_timeout      (during pay)
                             → acquire_expired          (before pay started)
```

UI displays "已锁定库存,准备支付" when state = `acquired` or `queued_for_payment`.

## Failure Distinction

| State | Meaning |
|---|---|
| `acquire_expired` | reservation expired before this task's slot in payment queue arrived |
| `payment_timeout` | payment in progress when reservation expired |

Different log codes, different recovery semantics.

## AcquirePool

```ts
interface AcquirePool {
  acquire(siteId: string, taskRef: TaskRef): Promise<AcquireSlot>;
  release(slot: AcquireSlot): void;
  setMaxConcurrentPerSite(siteId: string, n: number): void;
  setGlobalMaxConcurrent(n: number): void;
}
```

Defaults:
- Global max concurrent: 5 (browser instances)
- Per-site max concurrent: 3
- Slot wait timeout: 60s (give up if no slot)

Adapter declares per-site override:
```ts
capabilities: {
  maxAcquireConcurrent: number;
  acquireSafeBurstWindow: number;     // ms within which N starts is safe
}
```

## PaymentChannel

See `payment-channel.md`. Summary:
- One channel per payment method
- FIFO queue with EDF rebalance
- Min interval between successive payments: 30s default
- Captcha freezes entire channel
- `inspect()` returns position, ETA, risk classification

## Flow Script Phase Annotation

```yaml
flow_id: ebay.buy-product
version: 2

phases:
  acquire:
    - id: select_variant
    - id: click_buy_now
    - id: confirm_on_checkout
      action: assert
      capture_as: reservation_token
      capture_field:
        type: url_param      # | cookie | dom_attribute
        name: order_token

  settle:
    - id: validate_reservation
      action: navigate_with_state
      use: reservation_token
      # required first step in settle phase, by id and action convention
    - id: input_payment_info
    - id: confirm_pay
    - id: verify_success
```

Constraints:
- Acquire phase **must** end with a step having `capture_as: reservation_token`
- Settle phase **must** start with step matching: `id=validate_reservation, action=navigate_with_state, use=reservation_token`

See `flow-script-spec.md` for full grammar.

## Failure Matrix

| Failure | Acquire phase | Settle phase |
|---|---|---|
| Network transient | retry 3× backoff | retry 3× backoff, do not dequeue |
| Element not found | mark `flow_outdated` | mark `flow_outdated` |
| Captcha | notify user, freeze channel (if any) | freeze channel, notify |
| 3DS / OTP | n/a | push notification, 60s window |
| Bank decline | n/a | mark `payment_failed`, dequeue |
| Reservation expired | n/a | mark `payment_timeout` |
| Stock sold out | mark `acquire_failed` | n/a |
| Price exceeds maxPrice | mark `acquire_failed` (price guard) | n/a |

## UI Requirements

Task card must show:
```
status: acquired | queued_for_payment(#N/M) | paying | …
inventory countdown: mm:ss
estimated payment start: in mm:ss
risk: safe | tight | will_miss
```

PaymentChannel panel (independent widget) shows queue per payment method.

When `risk == will_miss`:
- 30s user decision window
- Options: skip / force_now (override interval) / accept_risk
- Default after 30s: skip

When channel frozen (captcha):
- top banner alert
- system notification
- "resume queue" button

## Sniper3 Integration

Multiple watch hits run acquire in parallel. Stale-watch confirmations sent at `queued_for_payment` entry, not at trigger time.

## Implementation Files

```
packages/server/order-shared/
├── acquire-pool/
│   ├── pool.ts
│   ├── slot-allocator.ts
│   └── browser-context-pool.ts
├── payment-channel/             # see payment-channel.md
├── flow-orchestration/
├── execution-engine/
│   ├── http-engine.ts
│   ├── browser-engine.ts
│   └── mobile-engine.ts
├── safety-gate-framework/
└── checkpoint/

packages/core/state-machine/templates/
└── acquire-settle-execution.machine.ts
```
