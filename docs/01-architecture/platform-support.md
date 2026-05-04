# Platform Support

## Local Runtime

| Platform | Status |
|---|---|
| Windows 10/11 | Primary dev |
| WSL2 (Ubuntu) | Secondary, models future Linux server |
| Linux native | Should work, not actively tested |
| macOS | Not supported, do not introduce Unix-only assumptions |

## Browser Targets (Web UI)

| Browser | Status |
|---|---|
| Chrome / Edge (Chromium) | Primary |
| Firefox | Tested |
| Safari | Tested via Playwright WebKit |

## Mobile Automation

| Target | Status | Control host |
|---|---|---|
| Android local USB | Supported | Any OS |
| Android emulator (local dev) | Supported | Any OS |
| Android cloud emulator pool | Supported (future SaaS) | Linux server |
| iOS (any) | **Never supported** | — |

## CI Matrix

```yaml
matrix:
  os: [windows-latest, ubuntu-latest]
  node: [20.x]
```

Both must pass on every PR.

Not in CI: macOS (no runner), Android real device (manual), iOS (n/a).

## Packaging

| Target | Status |
|---|---|
| Windows .exe (Node SEA) | M8 |
| Linux Docker image | M8 |
| macOS .dmg | Not on roadmap |

## Cross-Platform Rules

| Concern | Rule |
|---|---|
| Path separators | Use `path.join`, never string concat |
| File encoding | Always UTF-8, explicit on read/write |
| IPC paths | Use `buildIpcPath(name)` helper |
| Keychain | Via `CredentialStore` interface |
| Notifications | Via `NotificationService` interface |
| Process spawn | `execa` with explicit `encoding: 'utf8'` and `LANG` env |
| Temp dir | `os.tmpdir()`, never `/tmp` literal |
| Case sensitivity | Treat filesystem as case-insensitive |
| Shell scripts | Forbidden. Cross-platform scripts in Node only |

See `05-operations/windows-dev-notes.md` for Windows specifics.
