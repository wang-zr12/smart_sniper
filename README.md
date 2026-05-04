# Smart Sniper

Local MVP code generated from `docs/` v0.5. See [`PLAN.md`](PLAN.md) for the consolidated milestone plan post-review.

This repository is intentionally zero-dependency for the first runnable scaffold because the current machine exposes Node but no package manager. It keeps the package boundaries and interfaces from the spec, and implements the core behaviors with Node built-ins:

- domain types and error metadata
- SaaS-ready local interfaces
- tenant context, logger, event bus, credential store, network egress, job queue, rate limiter, config, exporter
- scheduler, polling tiers, request spreading
- adapter registry and fixture eBay/Goodwill adapters
- Vault IPC framing and a local daemon entry
- acquire pool, payment channel EDF scheduling, flow validation
- Sniper1, Sniper2, Sniper3 service skeletons with real in-memory behavior
- small local HTTP API and operational dashboard
- Node built-in tests plus source policy guard

## M0 Implementation Status

| Area | Status | Notes |
|---|---|---|
| Domain types / error codes | done | Runtime constants and helpers are in `packages/core/domain-types`. |
| Adapter interfaces / registry | done | Registry and capability validation are implemented. v0.5 splits site config (`sites/`) from base behavior (`_base/`) — see milestones F-H in PLAN.md. |
| EventBus / WebSocket events | done | In-memory bus, wildcard subscriptions, replay, and `/ws/v1/events` are implemented. |
| Tenant context | done | AsyncLocalStorage context plus tenant-scoped DAO/store tests. |
| Credential boundary | partial | Main API rejects plaintext credentials; Vault daemon/client/proxy path exists; keyring backend awaits package manager. |
| NetworkEgress | partial | DirectEgress and VaultProxyEgress exist; `MiddlewareEgress` wiring is milestone L. |
| Budget ledger | done | Separate commit/spend events plus SHA-256 hash chain. |
| Scheduler / polling helpers | partial | Precision scheduler and tier helpers exist; durable job reload is still stubbed. |
| State machines | partial | SimpleMachine preserves send/snapshot boundary. v0.5 adds Sniper1 win-flow states (`pending_user_payment` / `paid` / `payment_overdue`). |
| **NotificationService** | **done (in-app)** | M0 in-app channel via EventBus; Sniper1 wins emit `auction_won` + reminder. System/email channels later milestones. |
| Persistence | stub | TenantScopedDao skeleton is present; SQLite/Drizzle swap is future work. |
| API / UI | partial | Core routes and compact dashboard exist; full Fastify/ws/React stack awaits package manager. |

Run:

```powershell
node --test
node tools/lint-guards/check-source-policy.js
node packages/server/api/server.js
```

Open the dashboard at `http://127.0.0.1:4317`.

Production integrations such as real browser automation, Appium, SQLite/Drizzle, Fastify/ws, XState, argon2/keyring, and React/Vite are represented behind interfaces so they can be swapped in once a package manager is available.

## Live Transaction Guard

Live bids and payments are blocked by default. To run a local developer-mode transaction, both environment variables and the request body must opt in:

```powershell
$env:SMART_SNIPER_DEVELOPER_MODE='1'
$env:SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS='1'
node packages/server/api/server.js
```

Request bodies for live endpoints must include:

```json
{
  "transactionControl": {
    "developerMode": true,
    "executeLive": true,
    "confirmationPhrase": "EXECUTE_LIVE_TRANSACTION"
  }
}
```

Relevant endpoints:

- `POST /api/v1/sniper1/items/:id/bid`
- `POST /api/v1/sniper2/flows`
- `POST /api/v1/sniper2/tasks/:id/acquire`
- `POST /api/v1/sniper2/tasks/:id/enqueue`
- `POST /api/v1/sniper2/tasks/:id/settle`

Authenticated HTTP can be routed through `VaultProxyEgress` when a Vault daemon is configured. The main API refuses plaintext credential creation.
