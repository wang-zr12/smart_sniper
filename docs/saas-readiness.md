# SaaS-Ready Interfaces

11 abstract interfaces. Each has a local impl now, swap to SaaS impl later. Business code depends only on interface.

---

## 1. tenant_id Column

Every table:
```sql
tenant_id TEXT NOT NULL DEFAULT 'local-user'
```

Drizzle middleware auto-injects `WHERE tenant_id = ?` from `AsyncLocalStorage`. No raw SQL allowed.

```ts
withTenant(tenantId, async (tx) => {
  // all tx.select() auto-filtered
});
```

ESLint rule: forbid `db.select` outside `withTenant` context.

---

## 2. CredentialStore

```ts
interface CredentialStore {
  store(tenantId: string, ref: CredentialRef, secret: Secret): Promise<void>;
  retrieve(tenantId: string, ref: CredentialRef): Promise<Secret>;
  list(tenantId: string, siteId?: string): Promise<CredentialRefMetadata[]>;
  delete(tenantId: string, ref: CredentialRef): Promise<void>;
}
```

| Impl | Backend |
|---|---|
| `KeychainBackedStore` | `@napi-rs/keyring` (Win Cred Manager / libsecret) |
| `KmsBackedStore` (future) | AWS KMS / similar |
| `BrowserSideStore` (future) | client-side encryption, server holds ciphertext |

---

## 3. NetworkEgress

```ts
interface NetworkEgress {
  fetch(req: HttpRequest): Promise<HttpResponse>;
  newBrowserContext(opts: BrowserContextOpts): Promise<BrowserContext>;
  releaseBrowserContext(ctx: BrowserContext): Promise<void>;
}
```

| Impl | Egress |
|---|---|
| `DirectEgress` | local NIC |
| `ProxyPoolEgress` (future) | per-tenant residential proxy |

Adapters call `egress.fetch`, never direct `fetch()`. Enforced by ESLint rule.

---

## 4. EventBus

```ts
interface EventBus {
  emit(event: AppEvent): void;
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe;
}
```

| Impl | Backend |
|---|---|
| `InMemoryBus` | custom dispatcher (not Node EventEmitter) |
| `RedisBus` (future) | Redis pub/sub |

---

## 5. JobQueue

```ts
interface JobQueue {
  enqueue(job: Job): Promise<JobId>;
  schedule(job: Job, runAt: Date): Promise<JobId>;
  cancel(jobId: JobId): Promise<void>;
  getStatus(jobId: JobId): Promise<JobStatus>;
}
```

| Impl | Backend |
|---|---|
| `SqliteBackedQueue` | SQLite WAL, survives crash |
| `BullMQBackedQueue` (future) | Redis |

---

## 6. Config Layering

```
%APPDATA%\smart-sniper\
├── instance.json          # machine-level
└── tenants\
    └── local-user.json    # tenant-level
```

```ts
ConfigService.getInstanceConfig(): InstanceConfig
ConfigService.getTenantConfig(tenantId): TenantConfig
```

Future SaaS: `getTenantConfig` reads from API, signature unchanged.

---

## 7. AuthService

```ts
interface AuthService {
  validateToken(token: string): Promise<AuthContext | null>;
}

interface AuthContext {
  userId: string;          // 'local-user' for MVP
  tenantId: string;        // same
  scopes: string[];
  expiresAt: Date;
}
```

| Impl | Token type |
|---|---|
| `LocalTokenAuth` | random token in `%LOCALAPPDATA%\smart-sniper\auth.token` |
| `JwtAuth` (future) | signed JWT |

---

## 8. RateLimiter

```ts
interface RateLimiter {
  acquire(key: string, weight?: number): Promise<RateLimitToken>;
  getRemaining(key: string): Promise<RateLimitInfo>;
}
```

Key format: `tenant:{id}:site:{site}:{action}`

| Impl | Backend |
|---|---|
| `MemoryRateLimiter` | in-process token bucket |
| `RedisRateLimiter` (future) | shared across nodes |

---

## 9. Logger

```ts
interface Logger {
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, error: Error, context?: LogContext): void;
}

interface LogContext {
  tenantId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
}
```

Uses `pino`. Request entry middleware injects `requestId`, `tenantId` into AsyncLocalStorage. All log calls auto-attach.

---

## 10. DataExporter

```ts
interface DataExporter {
  exportAll(tenantId: string, format: 'json' | 'csv'): Promise<Stream>;
  exportRange(tenantId: string, scope: SniperScope, range: DateRange): Promise<Stream>;
  importFrom(tenantId: string, archive: Stream): Promise<ImportReport>;
}
```

Local impl: dump from SQLite. SaaS impl: same interface, GDPR-compatible.

---

## 11. tenant_id Enforcement Middleware

Drizzle helper:

```ts
function withTenant<T>(tenantId: string, fn: (tx: Transaction) => T): T {
  return AsyncLocalStorage.run({ tenantId }, () => {
    return db.transaction(fn);
  });
}
```

Custom Drizzle prepare hook auto-appends `eq(table.tenant_id, currentTenant)` to every query.

---

## Acceptance Criteria for M0

- [ ] All 11 interfaces defined in `packages/core/`
- [ ] Each has at least one impl + contract test
- [ ] ESLint rules in place: forbid raw `fetch`, forbid raw keychain access, forbid raw db queries outside `withTenant`
- [ ] Logger adds `requestId` + `tenantId` automatically
- [ ] Audit log writes are append-only (DB constraint or trigger)
