# Mobile Execution

Android only. Two execution paths.

## Paths

| Path | Use case | Control host |
|---|---|---|
| `local-usb` | dev / single-user | any OS, ADB connection to USB-attached Android |
| `cloud-emulator` | SaaS / no physical device | Linux server with KVM, Android emulator pool |

iOS not supported at any layer. No `mobile-ios` value exists in any enum.

## Engine Selection Logic

```ts
function selectMobileExecution(
  context: ExecutionContext
): 'local-usb' | 'cloud-emulator' | null:
  if context.deploymentForm == 'local':
    if hasUsbConnectedAndroid():
      return 'local-usb'
    if hasLocalEmulatorRunning():
      return 'cloud-emulator'    // local emulator uses same backend
    return null
  
  if context.deploymentForm == 'saas':
    if cloudEmulatorPool.hasCapacity():
      return 'cloud-emulator'
    return null
```

## Local USB Path

- Driver: ADB + UIAutomator2 (via Appium 2.x)
- Setup: user plugs in Android phone with USB debugging enabled
- Auth: account credentials (managed by Vault), not device-specific

## Cloud Emulator Path

- Backend: Linux KVM running Android x86 image
- Pool: pre-warmed emulators, allocated per-task
- Lifecycle:
  ```
  request → allocate fresh emulator from pool →
    install app (or attach pre-installed) →
    log in with credential →
    run flow →
    snapshot/wipe → return to pool
  ```
- Per-tenant isolation: each tenant's tasks get different emulator instances; account state never persisted across tasks

## Account Login Model

Critical: **the user account, not the user's physical device, is what matters.**

User registers Nike account on iPhone → system uses same email/password to log in:
- nike.com web (preferred, no mobile needed)
- Nike Android app on cloud emulator (if web-only path doesn't work)

The user's physical iPhone is never touched.

## Mobile Bridge Interface

```ts
interface MobileBridge {
  acquireSession(opts: SessionOpts): Promise<MobileSession>;
  releaseSession(session: MobileSession): Promise<void>;
}

interface MobileSession {
  readonly id: string;
  readonly path: 'local-usb' | 'cloud-emulator';
  
  installApp(apkRef: ApkRef): Promise<void>;
  loginWithCredential(credRef: CredentialRef): Promise<void>;
  runFlowStep(step: FlowStep, ctx: StepContext): Promise<StepResult>;
  captureScreenshot(): Promise<Blob>;
  captureXmlHierarchy(): Promise<string>;       // for debugging
}
```

## Capabilities Declaration

Each mobile site adapter declares:
```ts
capabilities: {
  supportedPaths: ['local-usb', 'cloud-emulator'];
  recommendedPath: 'cloud-emulator';
  apkSource: 'play-store' | 'internal' | 'none-needed';   
  // 'none-needed' means web works fine, mobile is only fallback
}
```

## Implementation Files

```
packages/mobile-bridge/
├── _interface/
│   └── mobile-bridge.ts            # interface above
├── appium-client/                  # appium driver wrapper
├── adb-client/                     # direct ADB for local-usb
├── emulator-pool/
│   ├── pool.ts                     # allocator
│   ├── emulator-runner.ts          # KVM/Android emulator lifecycle
│   └── snapshot-manager.ts         # fresh-state recovery
├── flow-recorder/
│   └── android-recorder/           # Appium Inspector wrapper
└── humanize/
    ├── tap-pattern.ts
    └── input-rhythm.ts
```

## Decision Matrix for Sniper2/3 Mobile Tasks

```
Web flow exists & works → use web
Web flow blocked (heavy anti-bot, app-only feature) → use mobile
  → Local form & user has Android USB → local-usb
  → Otherwise → cloud-emulator
```

## SaaS Considerations

Cloud emulator pool sizing:
- Pre-warm pool: 5–10% of expected concurrent demand
- Cold start time: ~30s; allocate before T-90s for scheduled tasks
- Per-tenant rate cap: configurable, default 3 concurrent

Cost note: KVM Android emulators ≈ 1 GB RAM + 0.5 vCPU each. Plan capacity accordingly.
