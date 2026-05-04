# Smart Sniper Docs

Code-agent execution spec. Style: declarative rules, types, file paths. No design rationale.

## Tree

```
docs/
├── DESIGN.md                              # top-level baseline + index
│
├── 01-architecture/
│   ├── saas-readiness.md                  # 11 abstract interfaces
│   └── platform-support.md                # OS / browser / mobile matrix + CI
│
├── 02-core/
│   ├── domain-types.md                    # cross-package type defs
│   ├── error-codes.md                     # unified ErrorCode enum
│   ├── adapter-interface.md               # adapter interfaces + capabilities
│   ├── scheduler.md                       # high-precision scheduler
│   ├── polling-tiers.md                   # tier rules
│   ├── vault-protocol.md                  # Vault IPC
│   ├── state-machines.md                  # machine list + conventions
│   ├── notification-service.md            # NotificationService (v0.5)
│   ├── site-config-spec.md                # sites/<site>.js config schema (v0.5)
│   └── websocket-events.md                # WS event schemas
│
├── 03-products/
│   ├── sniper1.md                         # auction
│   ├── sniper2.md                         # ordering
│   └── sniper3.md                         # restock
│
├── 04-shared/
│   ├── flow-script-spec.md                # YAML flow grammar
│   ├── acquire-settle.md                  # two-phase scheduling
│   ├── payment-channel.md                 # payment queue + EDF
│   ├── anti-detection.md                  # detection avoidance rules
│   └── mobile-execution.md                # local USB + cloud emulator
│
└── 05-operations/
    ├── testing-strategy.md
    ├── adding-a-site.md                   # how to add a new site adapter (v0.5)
    └── windows-dev-notes.md
```

## Implementation Reading Order

For implementing a milestone, read in order:

**M0 (scaffold + interfaces)**:
1. `DESIGN.md`
2. `02-core/domain-types.md`
3. `02-core/error-codes.md`
4. `02-core/adapter-interface.md`
5. `02-core/websocket-events.md`
6. `01-architecture/saas-readiness.md`
7. `01-architecture/platform-support.md`
8. `05-operations/windows-dev-notes.md`

**M1–M3 (Sniper1)**:
1. `03-products/sniper1.md`
2. `02-core/scheduler.md`
3. `02-core/polling-tiers.md`
4. `02-core/state-machines.md`

**M4–M5 (Sniper2)**:
1. `03-products/sniper2.md`
2. `04-shared/acquire-settle.md`
3. `04-shared/payment-channel.md`
4. `04-shared/flow-script-spec.md`
5. `04-shared/mobile-execution.md`

**M6–M7 (Sniper3)**:
1. `03-products/sniper3.md`
2. (revisit acquire-settle, payment-channel)
3. `04-shared/anti-detection.md`

## Doc Update Rules

- Each doc < 500 lines; split if over
- Decision change → update target doc + bump `DESIGN.md` version history
- Implementation details (concrete code) → in package READMEs, not in `docs/`
