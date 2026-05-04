# Error Codes

Single enum used by all components. Defined in `packages/core/domain-types/error-codes.ts`.

```ts
type ErrorCode =
  // Acquire phase
  | 'acquire_failed'                     // generic acquire failure
  | 'acquire_expired'                    // reservation expired before payment slot
  | 'stock_sold_out'                     // detected during acquire
  | 'price_guard_violated'               // price > maxUnitPrice
  | 'variant_unavailable'                // required & all fallbacks out of stock
  
  // Settle phase
  | 'payment_failed'                     // generic payment failure
  | 'payment_timeout'                    // reservation expired during pay
  | 'payment_declined'                   // bank/card decline
  | 'payment_otp_timeout'                // 3DS / OTP not entered in time
  
  // Bid (Sniper1)
  | 'auction_ended'
  | 'bid_amount_too_low'
  | 'bid_amount_exceeds_budget'
  
  // Network / session
  | 'network_error'
  | 'rate_limited'
  | 'session_expired'
  | 'time_drift_excessive'
  
  // Adapter / flow
  | 'flow_outdated'                      // selector not found, structure changed
  | 'flow_version_unsupported'           // adapter doesn't support this flow version
  | 'flow_validation_failed'             // schema invalid
  | 'flow_step_timeout'
  | 'adapter_not_found'                  // no adapter for site
  
  // Anti-detection
  | 'captcha_encountered'
  | 'fingerprint_inconsistent'           // adapter detected its own fingerprint leak
  
  // Vault / credentials
  | 'vault_unavailable'                  // daemon down
  | 'credential_not_found'
  | 'credential_invalid'                 // login failed with stored credential
  
  // Resources
  | 'no_acquire_slot'                    // AcquirePool full, timeout waiting
  | 'payment_channel_full'               // queue at maxQueueSize
  | 'payment_channel_frozen'             // can't enqueue while frozen
  
  // User / state
  | 'user_cancelled'
  | 'user_confirmation_timeout'          // stale watch confirmation expired
  | 'task_already_terminal'              // tried to act on succeeded/failed/cancelled task
  | 'budget_exceeded'
  
  // System
  | 'internal_error';
```

## Code Properties Table

For each code, recovery is one of: `retry`, `manual`, `terminal`. Default user-visible severity is one of: `info`, `warn`, `error`.

| Code | Recovery | Severity |
|---|---|---|
| `acquire_failed` | retry | warn |
| `acquire_expired` | terminal | warn |
| `stock_sold_out` | terminal | info |
| `price_guard_violated` | terminal | info |
| `variant_unavailable` | terminal | info |
| `payment_failed` | retry | error |
| `payment_timeout` | terminal | error |
| `payment_declined` | manual | error |
| `payment_otp_timeout` | manual | warn |
| `auction_ended` | terminal | info |
| `bid_amount_too_low` | retry | warn |
| `bid_amount_exceeds_budget` | terminal | warn |
| `network_error` | retry | warn |
| `rate_limited` | retry | warn |
| `session_expired` | retry | warn |
| `time_drift_excessive` | manual | error |
| `flow_outdated` | manual | error |
| `flow_version_unsupported` | manual | error |
| `flow_validation_failed` | manual | error |
| `flow_step_timeout` | retry | warn |
| `adapter_not_found` | manual | error |
| `captcha_encountered` | manual | warn |
| `fingerprint_inconsistent` | retry | warn |
| `vault_unavailable` | retry | error |
| `credential_not_found` | manual | error |
| `credential_invalid` | manual | error |
| `no_acquire_slot` | retry | warn |
| `payment_channel_full` | retry | warn |
| `payment_channel_frozen` | retry | info |
| `user_cancelled` | terminal | info |
| `user_confirmation_timeout` | terminal | info |
| `task_already_terminal` | terminal | error |
| `budget_exceeded` | terminal | warn |
| `internal_error` | retry | error |

## Usage

Every failure path returns a typed `ErrorCode`. Adapters/services never throw raw strings.

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode; message?: string; cause?: Error };
```

`message` is for logging; user-facing copy is keyed by `ErrorCode` in i18n table.

## Implementation File

```
packages/core/domain-types/error-codes.ts
```

i18n strings:
```
packages/web-ui/src/i18n/error-messages.ts
```
