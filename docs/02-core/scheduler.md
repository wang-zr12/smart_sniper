# Scheduler

High-precision task triggering. Target: ±200ms at trigger point.

## Interface

```ts
interface Scheduler {
  schedule(task: ScheduledTask): TaskHandle;
  cancel(handle: TaskHandle): void;
  reschedule(handle: TaskHandle, newTriggerAt: Date): void;
}

interface ScheduledTask {
  triggerAt: Date;                          // server time
  leadTimeMs: number;                       // 5000 for Sniper1
  warmupMs: number;                         // 60000 default
  onWarmup: () => Promise<void>;
  onTrigger: () => Promise<void>;
  onMiss?: (reason: MissReason) => void;
  serverTimeProvider: () => Promise<number>;
}

type MissReason = 'system_sleep' | 'network_outage' | 'warmup_failed' | 'time_drift_excessive';
```

## Behavior Rules

| Phase | Logic |
|---|---|
| `now() < triggerAt - leadTimeMs - 30s` | sleep with `setTimeout(realign in 30s)` |
| `30s > remaining > 10s` | sleep until `remaining = 5s` |
| `remaining ≤ 10s` | enter Strike mode |

## Strike Mode

- Polling interval: 100ms
- Re-sync server time every 2s
- Pre-parse bid form
- HTTP keep-alive maintained
- Trigger via precise `setTimeout` at `triggerAt - leadTimeMs`
- Tolerance: actual fire time within [target - 50ms, target + 200ms]

## Persistence

Scheduled tasks persist to `shared_jobs` table. On process restart, scheduler reloads pending tasks.

## Server Time Sync

```ts
function refreshServerTimeOffset(siteId: string): Promise<number>:
  samples = []
  for i in 0..3:
    t1 = Date.now()
    res = await fetch(siteId.timeEndpoint)
    t2 = Date.now()
    serverTime = parseDate(res.headers.Date)
    offset = serverTime - (t1 + t2) / 2
    samples.push(offset)
  return median(samples)
```

Cache per `siteId`. Refresh:
- on startup, once per site
- when item enters Hot tier
- every 2s during Strike mode
- alert if offset > 2000ms (clock or network anomaly)

## Failure Modes

| Condition | Action |
|---|---|
| Warmup fails | log warn, don't cancel; retry warmup at T-30s |
| Network down at trigger | retry once at remaining = 2s |
| Time drift > 5s | call `onMiss('time_drift_excessive')` |
| Process restart during warmup | reload from DB, redo warmup |

## Implementation Files

```
packages/core/scheduler/
├── scheduler.ts                # main interface + impl
├── strike-mode.ts              # last-10s precision logic
├── time-sync.ts                # server time offset
├── persistence.ts              # DB save/load
└── __tests__/
    ├── drift-correction.test.ts
    ├── strike-precision.test.ts
    └── persistence-recovery.test.ts
```
