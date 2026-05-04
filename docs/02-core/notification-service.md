# NotificationService

Single-process pub-sub for user-facing events. Every product service writes here instead of printing, toasting, or emailing directly.

## Responsibilities

- Accept structured notification requests from services
- Fan out to one or more channels (in-app / system / email / web push)
- Schedule reminders via `PrecisionScheduler` (e.g. "remind me 24h before payDeadline")
- Persist a record per notification for the audit log and for /api/v1/notifications
- Filter by `tenantId` (Invariant 11)

## Interface

```ts
interface NotificationService {
  notify(request: NotifyRequest): Promise<NotificationId>;
  cancelReminder(reminderId: string): Promise<void>;
  list(filter: NotificationFilter): Promise<NotificationView[]>;
}

interface NotifyRequest {
  scope: 'sniper1' | 'sniper2' | 'sniper3' | 'shared';
  category: NotifyCategory;
  severity: 'info' | 'warn' | 'urgent';
  payload: Record<string, unknown>;
  channels?: NotifyChannel[];      // overrides default per OD-004
  reminderAt?: Date;               // optional follow-up
  tenantId: TenantId;
}

type NotifyCategory =
  | 'auction_won'                  // sniper1 - urgent
  | 'payment_required'             // sniper1 reminder before payDeadline
  | 'payment_overdue'              // sniper1 deadline passed
  | 'restock_signal'               // sniper3 - info
  | 'confirmation_required'        // sniper3 requireConfirmation gate
  | 'task_completed'               // sniper2/3 success
  | 'task_failed'                  // sniper1/2/3 fail
  | 'budget_low'                   // shared - warn
  | 'system_alert';                // shared - urgent
```

## Channels

| Channel | When | Status |
|---|---|---|
| `in-app` | Always default; emits to `/ws/v1/events` topic `shared:notification:*` and stores in `shared_notifications` table | M0 |
| `system` | Windows toast / macOS Notification Center (no macOS in scope) | M5 (after `@napi-rs/notify` available) |
| `email` | SMTP via Vault-stored credentials | M7 |
| `webpush` | Browser push API | M7+ |

Channel default per OD-004 (resolved): `['in-app']` in MVP; `['in-app', 'system']` from M5 onward.

## Default channels by category

| Category | Default channels | Severity |
|---|---|---|
| `auction_won` | `['in-app', 'system']` (when system is available) | urgent |
| `payment_required` | same | urgent |
| `payment_overdue` | same | urgent |
| `restock_signal` | `['in-app']` | info |
| `confirmation_required` | `['in-app', 'system']` | warn |
| `task_completed` | `['in-app']` | info |
| `task_failed` | `['in-app']` | warn |
| `budget_low` | `['in-app']` | warn |
| `system_alert` | `['in-app', 'system']` | urgent |

## Reminders

`reminderAt` schedules a follow-up notification through `PrecisionScheduler`. The reminder uses the same payload by default; channels can be overridden per reminder.

Sniper1 win flow uses two reminders:
1. `payDeadline - 24h` → `payment_required` with payload referencing `payUrl`
2. `payDeadline + 1ms` → `payment_overdue` and emits the `paymentDeadlineHit` event to the item state machine.

## Event topology

Every `notify()` emits a corresponding bus event so the WebSocket clients see it immediately:

```
shared:notification:created       { id, scope, category, severity, payload, at, tenantId }
shared:notification:reminder      { id, parentId, firedAt, ... }
shared:notification:dismissed     { id, dismissedAt, dismissedBy }
```

The `shared:audit:event` is also written for `urgent` notifications.

## Persistence (M0 in-memory; M1+ SQLite)

```sql
CREATE TABLE shared_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload JSON NOT NULL,
  channels JSON NOT NULL,
  created_at TIMESTAMP NOT NULL,
  reminder_at TIMESTAMP,
  fired_reminders JSON NOT NULL DEFAULT '[]',
  dismissed_at TIMESTAMP
);
```

## API surface

```
GET    /api/v1/notifications?since=...&unreadOnly=...
POST   /api/v1/notifications/:id/dismiss
POST   /api/v1/sniper1/items/:id/markPaid       # body: { confirmedAt? }
```

WebSocket clients should subscribe to `shared:notification:*` to receive in-app notifications without polling the REST endpoint.

## Implementation Files

```
packages/core/notification-service/
├── index.js                      # NotificationService + Channel registry
├── reminder-scheduler.js         # adapts PrecisionScheduler
└── channels/
    ├── in-app.js                 # default; emits via EventBus
    ├── system-toast.js           # M5
    ├── email.js                  # M7
    └── webpush.js                # M7+
```

## Test Strategy

- Unit: each channel can be mocked; assertion on event bus emission
- Unit: reminder schedules call PrecisionScheduler with the correct delay
- Integration: end-to-end win flow places `auction_won` and reminders correctly
- Cross-tenant: `notify({ tenantId: 'a' })` is invisible to `list({ tenantId: 'b' })`
