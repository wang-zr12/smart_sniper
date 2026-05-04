# Anti-Detection

Three layers, all enforced in `packages/adapters/_common/middleware/`.

## Network Fingerprint

| Concern | Rule |
|---|---|
| User-Agent | stable per session, derived from real Chrome version |
| Accept-Language | stable per session |
| sec-ch-ua / Client Hints | match UA |
| TLS fingerprint | playwright-extra + stealth |
| HTTP/2 frame order | mimic real Chrome |
| Cookie roundtrip | full, including any "probe" cookies |

## Behavioral

| Concern | Rule |
|---|---|
| Mouse path | bezier curve, not straight line |
| Click/scroll inter-action | random 300–1200 ms |
| Typing rhythm | per-char gaussian (mean 80ms, std 30ms) |
| Idle browsing pattern | 1/5 chance: list page → product page (not direct API) |

Implementation: `mobile-bridge/humanize/` and `adapters/_common/humanize/`.

## Timing

| Concern | Rule |
|---|---|
| Same-origin min interval | 800 ms |
| Per-session request rate | < 1500 / hour |
| Tier interval jitter | ±15% gaussian |
| Concurrent same-tier items | spread via `RequestSpreader` |

## Captcha Handling

```
adapter detects → 
  emit 'captcha_encountered' event →
    affected task: state → suspended →
      affected PaymentChannel: freeze →
        notify user (UI banner + system notification + push)
```

No automated solving. Project does **not** integrate captcha-solving services.

User resolves manually:
- UI shows the captcha challenge in the browser/app
- After user solves, click "resume" in UI
- Adapter probes again; if clear, unfreeze

## Backoff Policy

| Trigger | Action | Recovery |
|---|---|---|
| 429 | item drops 1 tier | 30 min hold-down |
| 5xx (3 in 60s) | item drops 1 tier | 30 min hold-down |
| Captcha | item suspended | manual user action |
| Auth expired | retry vault re-login once | if fails, suspend |

## IP / Session Isolation

Local form: user's IP, no isolation needed.

Future SaaS form: per-tenant residential proxy via `ProxyPoolEgress`. Specifications in `01-architecture/saas-readiness.md` § 3.

## Multi-account Rotation (optional)

User may configure per-watch:
```
monitoringAccountRef: <CredentialRef>
purchaseAccountRef:   <CredentialRef>
```

If different, monitor traffic uses one account, order uses another. Reduces correlation risk.

## Implementation Files

```
packages/adapters/_common/middleware/
├── rate-limit.ts                   # 800ms enforce
├── header-consistency.ts           # UA / Lang stability
├── backoff.ts                      # 429 / 5xx
├── captcha-detector.ts             # detect & emit
└── humanize-orchestrator.ts        # behavioral injection
```
