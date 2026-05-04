# Polling Tiers

## Tier Table — Deadline-driven (Sniper1, Sniper2 scheduled)

| Tier | Trigger | Interval | Jitter |
|---|---|---|---|
| Cold | distance > 30 min | 5–15 min | ±15% gaussian |
| Warm | 30 min – 2 min | 60–120 s | ±15% gaussian |
| Hot | 2 min – 15 s | 5–15 s | ±15% gaussian |
| Strike | 15 s – trigger | 1–2 s, ramp | none |
| Post | trigger – 30 s after | 2 s × 5 max | none |

## Tier Table — Long-monitor (Sniper3)

| Tier | Trigger | Interval |
|---|---|---|
| Idle | default | 5–15 min, large random |
| Hint | user-provided window | 60–120 s |
| Detected | stock signal received | 1 s for ≤ 5s, then escalate |

After Detected, escalate to Hot/Strike from deadline-driven table.

## Jitter Rule

```
actual_interval = uniform(lower, upper) * gaussian(mean=1, std=0.15)
```

Forbidden:
- `setInterval`
- intervals that are exact whole seconds (`% 1000 == 0`)

## RequestSpreader

When N items enter the same tier simultaneously, spread requests across the interval window. No two outbound requests within the same 800ms window per site.

## Backoff Rules

| Response | Action |
|---|---|
| 429 | item drops one tier, hold 30 min before allowed to escalate |
| 5xx | same |
| Captcha | item → `suspended`, notify user, freeze affected PaymentChannel |

## Hard Caps (enforced by adapter middleware)

- Same-origin min interval: 800 ms
- Per-session UA / Accept-Language / sec-ch-ua: stable
- Referer chain: must be plausible
- Browser-engine click/scroll inter-action: random 300–1200 ms
- Cookies: full round-trip
- Per-session request count: < 1500 / hour

## Idle Tier Special Rules (Sniper3)

- 1/5 chance follow full path (list → detail), not direct API fetch
- Prefer passive signal sources (email subscriptions) when available
- Multi-account rotation if user configures it: monitor and order on different accounts

## Strike Mode Add-ons (Sniper1)

- Re-sync server time every 2s
- Pre-parse bid form, hold CSRF token
- HTTP keep-alive
- Switch from polling to active push (precise setTimeout)

## Profile Override

`tenants/{id}.json`:
```json
{
  "polling": {
    "profile": "balanced",
    "tierOverrides": {
      "cold": { "min": 300000, "max": 900000 }
    }
  }
}
```

| Profile | Effect |
|---|---|
| conservative | -30% frequency |
| balanced | default |
| aggressive | +50% frequency |

## Implementation Files

```
packages/core/scheduler/
├── polling-loop.ts             # 500ms global loop
├── tier-resolver.ts            # decide tier from deadline distance
├── request-spreader.ts         # spread logic
└── jitter.ts                   # interval generation

packages/adapters/_common/middleware/
├── rate-limit.ts               # 800ms enforcement
├── header-consistency.ts       # UA / Accept-Language stability
└── backoff.ts                  # 429/5xx handling
```
