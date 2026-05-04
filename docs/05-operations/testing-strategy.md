# Testing Strategy

## Pyramid

| Layer | Tool | Count target |
|---|---|---|
| Unit | Vitest | ~500+ |
| Integration | Vitest + real components | ~50 |
| E2E | Playwright Test | ~10 critical paths |

## Coverage Targets

| Module | Target |
|---|---|
| `budget-engine` | > 95 % |
| `state-machine` machines | > 95 % |
| `auto-bump` rules | 100 % |
| `edf-scheduler` | > 90 % |
| Adapters | > 70 % (with recorded fixtures) |
| API routes | > 80 % |
| Web UI | > 60 % |

## Required Test Patterns

### Time-sensitive

```ts
import { vi } from 'vitest';
vi.useFakeTimers();
// simulate sleep, drift, timeouts
```

Test:
- scheduler drift correction
- strike mode precision
- system sleep during warmup

### State machines

- Cover every transition explicitly
- Property-based: from any state, all event sequences terminate
- Use `fast-check`

### PaymentChannel

- Simulated reservation countdown
- EDF reorder correctness
- Freeze / unfreeze paths
- will_miss decision window

### Adapters

- Record HTTP fixtures with `nock` or saved snapshots
- Mock server replays responses
- Never depend on real sites in CI

### SaaS-ready interfaces

- "Contract test" suite: every implementation runs the same suite
- Future SaaS impl reuses tests

## CI

```yaml
# .github/workflows/ci.yml
strategy:
  matrix:
    os: [windows-latest, ubuntu-latest]
    node: [20.x]

steps:
  - lint
  - typecheck
  - vitest --run
  - playwright test (e2e)
  - benchmark (weekly)
```

Both OS must pass. Block merge on failure.

## Performance Benchmarks

| Metric | Target (p99) |
|---|---|
| Scheduler trigger precision | < 200 ms drift |
| State transition latency | < 5 ms |
| API response (local) | < 100 ms |
| Adapter HTTP fetch | < 500 ms (excluding network) |

Run weekly, alert on regression.

## Fixture Management

```
packages/adapters/{site}/fixtures/
├── browse-page.html
├── product-page.html
├── checkout-page.html
└── http-recordings/
    ├── login-success.json
    ├── bid-success.json
    └── bid-outbid.json
```

Fixtures versioned; site changes require fixture re-record + adapter version bump.
