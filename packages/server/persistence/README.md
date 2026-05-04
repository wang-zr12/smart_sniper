# Persistence

Zero-dependency DAO skeleton for the local scaffold.

Current implementation:

- `InMemoryPersistence`
- `TenantScopedDao`
- all reads filter by `tenantId`

Future replacement:

- keep DAO method shape
- replace backing arrays with better-sqlite3 + Drizzle
- enforce `tenant_id` at query builder/middleware level
