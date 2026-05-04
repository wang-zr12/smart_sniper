# Smart Sniper — Spec

Version: v0.5
Status: implementation spec for code agents

---

## Products

| ID | Function | Lifecycle |
|---|---|---|
| Sniper1 | Auction proxy bidding (eBay, Goodwill, web only) | Short |
| Sniper2 | Scheduled / immediate ordering (web + Android app) | Short |
| Sniper3 | Long-term restock monitoring (web + Android app) | Long |

Three products are independent: no shared state, no shared budget, no cross-product cancellation.

## Hard Constraints

- iOS app automation: **not supported** in any deployment form
- Apple device required for: nothing (project never depends on macOS)
- Mobile automation target: Android only (local USB or cloud emulator)
- Credentials: never stored as plaintext, never sent to cloud
- Time decisions: based on server time, not local clock
- All DB queries: must filter by `tenant_id` (single value `'local-user'` for MVP)
- All HTTP calls: go through `NetworkEgress`, never direct `fetch()`
- All credential operations: go through Vault IPC, never direct keychain access
- **Auction wins do NOT trigger automated payment.** Sniper1 ends at `pending_user_payment`; the system notifies the user and they pay manually within the site's grace window. Restock and order flows (Sniper2/3) auto-pay by default.
- **Site knowledge lives in `packages/adapters/sites/<site>.js` only.** Adapters in `packages/adapters/_base/` must not name specific sites; site files must not call `egress.fetch` directly.
- **All adapter HTTP traffic flows through `MiddlewareEgress`** (rate-limit, header consistency, captcha detection, backoff classification).
- **All user-facing transitions go through `NotificationService`.** No service prints, toasts, or emails directly.

## Deployment Form

Current: local Windows + future SaaS readiness via abstract interfaces.

Mobile execution paths:
1. Local Android via USB/ADB — current dev primary
2. Cloud Android emulator pool — for SaaS form

iOS: never.

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript on Node.js 20+ LTS |
| API | Fastify + ws |
| DB | better-sqlite3 + Drizzle ORM |
| Browser automation | Playwright + playwright-extra + stealth |
| Mobile automation | Appium 2.x + UIAutomator2 |
| State machine | XState v5 |
| Frontend | React 18 + Vite + Tailwind + shadcn/ui |
| Tables/charts | TanStack Table / Recharts |
| Crypto | Node `crypto` (AES-256-GCM) + `argon2` |
| Keychain | `@napi-rs/keyring` |
| Test | Vitest + Playwright Test |
| Monorepo | pnpm workspaces + Turborepo |
| Packaging | Node SEA / pkg |

## Repository Layout

```
smart-sniper/
├── packages/
│   ├── core/
│   │   ├── scheduler/
│   │   ├── state-machine/
│   │   ├── adapter-interface/
│   │   ├── budget-engine/
│   │   ├── event-bus/                 # impl: InMemoryBus
│   │   ├── credential-store/          # impl: KeychainBackedStore
│   │   ├── network-egress/            # impl: DirectEgress
│   │   ├── job-queue/                 # impl: SqliteBackedQueue
│   │   ├── tenant-context/
│   │   ├── notification-service/      # impl: in-app channel; system/email later
│   │   └── domain-types/
│   ├── adapters/
│   │   ├── _base/                    # shared base adapters (no site names allowed)
│   │   │   ├── base-html-auction.js
│   │   │   ├── base-api-auction.js
│   │   │   ├── base-shopify-ordering.js
│   │   │   ├── base-magento-ordering.js
│   │   │   ├── base-queue-gated.js
│   │   │   ├── base-mobile-flow.js
│   │   │   ├── site-config-schema.js
│   │   │   └── _common/              # shared helpers between bases
│   │   │       ├── parsers.js
│   │   │       ├── template.js
│   │   │       ├── middleware-egress.js
│   │   │       ├── csrf.js
│   │   │       ├── server-time.js
│   │   │       ├── increment-tables.js
│   │   │       ├── captcha-detection.js
│   │   │       └── pay-deadline.js
│   │   ├── sites/                    # one file per site, config + factory only
│   │   │   ├── ebay.js
│   │   │   ├── shopgoodwill.js
│   │   │   ├── _template-site.js
│   │   │   └── ...
│   │   ├── _template/                # FixtureAdapters for tests
│   │   └── registry.ts
│   ├── vault/
│   │   ├── daemon/
│   │   ├── ipc-protocol/
│   │   ├── keychain-bindings/
│   │   └── crypto/
│   ├── mobile-bridge/
│   │   ├── appium-client/
│   │   ├── adb-client/
│   │   ├── emulator-pool/             # cloud Android emulator
│   │   ├── flow-recorder/
│   │   └── humanize/
│   ├── server/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── persistence/
│   │   ├── order-shared/
│   │   │   ├── flow-orchestration/
│   │   │   ├── execution-engine/
│   │   │   ├── safety-gate-framework/
│   │   │   ├── checkpoint/
│   │   │   ├── acquire-pool/
│   │   │   └── payment-channel/
│   │   ├── sniper1-service/
│   │   ├── sniper2-service/
│   │   └── sniper3-service/
│   └── web-ui/
├── apps/
│   └── launcher/
├── tools/
│   ├── adapter-cli/
│   └── flow-recorder-ui/
└── docs/
```

## Data Persistence

Tables grouped by scope. All tables have `tenant_id TEXT NOT NULL DEFAULT 'local-user'`.

```
shared_credentials_meta
shared_audit_log
shared_settings
shared_jobs

sniper1_items
sniper1_bids
sniper1_budget_ledger

sniper2_tasks
sniper2_prewarm_logs
sniper2_budget_ledger
sniper2_reservations

sniper3_watches
sniper3_signals
sniper3_signal_events
sniper3_budget_ledger
```

No cross-group foreign keys.

Budget ledger schema (per scope):

```sql
CREATE TABLE {scope}_budget_ledger (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,        -- commit | release | spend | transfer_in | transfer_out
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  related_entry_id INTEGER,
  created_at TIMESTAMP NOT NULL
);
```

Append-only. Current budget = SUM.

## API Routes

```
GET    /api/v1/health
GET    /api/v1/credentials
POST   /api/v1/credentials
GET    /api/v1/stats/overview
GET    /api/v1/audit/events
GET    /api/v1/preferences
PATCH  /api/v1/preferences

# Sniper1
GET    /api/v1/sniper1/items
POST   /api/v1/sniper1/items
GET    /api/v1/sniper1/items/:id
PATCH  /api/v1/sniper1/items/:id
DELETE /api/v1/sniper1/items/:id
POST   /api/v1/sniper1/items/:id/cancel
GET    /api/v1/sniper1/budget
PATCH  /api/v1/sniper1/budget
GET    /api/v1/sniper1/stats

# Sniper2
GET    /api/v1/sniper2/tasks
POST   /api/v1/sniper2/tasks
GET    /api/v1/sniper2/tasks/:id
POST   /api/v1/sniper2/tasks/:id/pause
POST   /api/v1/sniper2/tasks/:id/resume
POST   /api/v1/sniper2/tasks/:id/cancel
GET    /api/v1/sniper2/flows
POST   /api/v1/sniper2/flows
POST   /api/v1/sniper2/flows/:id/dryrun
GET    /api/v1/sniper2/budget
PATCH  /api/v1/sniper2/budget
GET    /api/v1/sniper2/payment-channels

# Sniper3
GET    /api/v1/sniper3/watches
POST   /api/v1/sniper3/watches
GET    /api/v1/sniper3/watches/:id
POST   /api/v1/sniper3/watches/:id/pause
POST   /api/v1/sniper3/watches/:id/resume
POST   /api/v1/sniper3/watches/:id/cancel
GET    /api/v1/sniper3/watches/:id/history
GET    /api/v1/sniper3/signal-sources
POST   /api/v1/sniper3/signal-sources
GET    /api/v1/sniper3/budget
PATCH  /api/v1/sniper3/budget

# WebSocket
/ws/v1/events
  topics: ['sniper1:item:*', 'sniper2:task:*', 'sniper3:watch:*',
           'shared:payment-channel:*']
```

All endpoints require `Authorization: Bearer <token>`. Token contains `userId` field (fixed `'local-user'` for MVP).

## Implementation Milestones

| ID | Deliverable |
|---|---|
| M0 | Monorepo scaffold + Windows/WSL2 CI + Vault IPC + 11 SaaS-ready interfaces |
| M1 | eBay adapter (HTTP) + Scheduler + Sniper1 single-item e2e |
| M2 | Goodwill adapter (Browser) + multi-item aggregated UI |
| M3 | Sniper1 auto-bump + budget flow + cancel-redistribute + stats |
| M4 | Sniper2 web engine + Flow Recorder (web) + Acquire/Settle + scheduled e2e |
| M5 | Sniper2 Android (local USB) + mobile Flow Recorder + cloud emulator pool stub |
| M6 | Sniper3 polling signal source + long-term watch state machine + drift detection |
| M7 | Sniper3 multi-source (email) + overview stats + anti-detection hardening |
| M8 | Packaging (.exe + Linux Docker) |

## Invariants

1. Server time sync inside adapter interface, not scheduler
2. State transitions only by kernel, never by UI
3. Vault is a separate process from day 1
4. All timestamps stored as UTC
5. Budget commit and spend are separate ledger events
6. Flow scripts have `version` field, mismatch is failure
7. Three sniper budget engines are isolated instances
8. All money operations write audit log (append-only, hash-chained)
9. Credential operations route through Vault, plaintext never enters main process
10. Bump counters in state machine context, not in-memory variables
11. All DB queries filtered by `tenant_id` via middleware
12. Adapters call `egress.fetch`, never `fetch()` directly
13. Flow scripts split into `phases.acquire` and `phases.settle`
14. Same-PaymentChannel inter-payment interval ≥ minIntervalMs (default 30s)
15. Sniper1 win path is `won → pending_user_payment → paid | payment_overdue`; never enters PaymentChannel
16. `packages/adapters/sites/*.js` only export config + factory; no `egress.fetch`, no `vault*`, no cross-package imports outside `_base/`
17. Site adapter capabilities must pass `validateSiteAuctionConfig` / `validateSiteOrderingConfig` at registry time; mismatched capabilities reject registration

## Document Index

| Path | Content |
|---|---|
| `01-architecture/saas-readiness.md` | 11 abstract interfaces + impl strategy |
| `01-architecture/platform-support.md` | OS / browser / mobile matrix + CI |
| `02-core/domain-types.md` | Cross-package type definitions |
| `02-core/error-codes.md` | Unified ErrorCode enum + recovery table |
| `02-core/adapter-interface.md` | Adapter interfaces + capabilities |
| `02-core/scheduler.md` | High-precision scheduler |
| `02-core/polling-tiers.md` | Polling tier specification |
| `02-core/vault-protocol.md` | Vault IPC protocol |
| `02-core/state-machines.md` | State machine list and conventions |
| `02-core/websocket-events.md` | WS event payload schemas |
| `03-products/sniper1.md` | Auction product spec |
| `03-products/sniper2.md` | Ordering product spec |
| `03-products/sniper3.md` | Restock product spec |
| `04-shared/flow-script-spec.md` | Flow script schema |
| `04-shared/acquire-settle.md` | Two-phase scheduling |
| `04-shared/payment-channel.md` | Payment queue / EDF |
| `04-shared/anti-detection.md` | Anti-detection rules |
| `04-shared/mobile-execution.md` | Local USB + cloud emulator |
| `02-core/notification-service.md` | NotificationService channels, ReminderScheduler, payloads |
| `02-core/site-config-spec.md` | `packages/adapters/sites/*.js` config schema, escape hatches |
| `05-operations/testing-strategy.md` | Test pyramid / CI |
| `05-operations/windows-dev-notes.md` | Windows-specific rules |
| `05-operations/adding-a-site.md` | Step-by-step: add a new site adapter |

## Open Decisions

- [ ] Bump amount range user-configurable (current: $5–10 fixed)
- [ ] Sniper3 stale threshold (current default: 30 days)
- [ ] Multi-account rotation in MVP scope
- [x] **Default notification channels** — resolved v0.5: `['in-app']` MVP; add `'system'` after M5 desktop toast
- [ ] Windows Service registration
- [ ] Code signing budget

## Version History

| Version | Date | Change |
|---|---|---|
| v0.1 | 2026-05-04 | Initial integration |
| v0.2 | 2026-05-04 | Acquire/Settle, PaymentChannel, SaaS-ready interfaces, doc split |
| v0.3 | 2026-05-04 | Mobile clarified: cloud emulator + local Android. iOS removed entirely. Style switched to code-agent spec. |
| v0.4 | 2026-05-04 | Added: domain-types, error-codes, adapter-interface, websocket-events. Fixed validate_reservation inconsistency. |
| v0.5 | 2026-05-04 | Auction win never auto-pays (Sniper1 → `pending_user_payment`). Adapter family taxonomy: `_base/` + `sites/<site>.js` (config+factory only). NotificationService introduced. OD-004 resolved. New invariants 15–17. |
