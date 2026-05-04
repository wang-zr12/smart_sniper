# Vault Protocol

Separate Node.js process. Local IPC only. Never listens on TCP.

## IPC Path

```ts
buildIpcPath('vault'): string
  // Windows: \\.\pipe\smartsniper-vault
  // Unix:    {os.tmpdir()}/smartsniper-vault.sock
```

## Wire Format

JSON-RPC over IPC. Length-prefixed frames.

Request:
```json
{ "id": "msg-123", "method": "<methodName>", "params": { ... } }
```

Response:
```json
{ "id": "msg-123", "result": { ... } }
{ "id": "msg-123", "error": { "code": -32603, "message": "..." } }
```

## RPC Methods

```ts
proxyAuthedRequest(
  credentialRef: CredentialRef,
  request: HttpRequest
): Promise<HttpResponse>
```

```ts
injectCookiesIntoContext(
  credentialRef: CredentialRef,
  contextId: string
): Promise<void>
```

```ts
promptForNewCredential(
  siteId: string
): Promise<CredentialRef>
```

```ts
listCredentialRefs(
  siteId?: string
): Promise<CredentialRefMetadata[]>
```

```ts
deleteCredential(
  credentialRef: CredentialRef
): Promise<void>
```

```ts
healthCheck(): Promise<HealthStatus>
```

## Type Definitions

```ts
interface CredentialRef {
  id: string;                   // opaque
  siteId: string;
}

interface CredentialRefMetadata extends CredentialRef {
  label: string;
  createdAt: Date;
  lastUsedAt?: Date;
  // never includes secret material
}

interface HealthStatus {
  ok: boolean;
  uptime: number;
  storedCredentialsCount: number;
}
```

## Storage Backend

Default: `KeychainBackedStore` using `@napi-rs/keyring`.

Fallback for headless: `EncryptedFileVault`:
- key derivation: Argon2id (memory: 64 MiB, iterations: 3, parallelism: 4)
- cipher: AES-256-GCM
- master password prompted on daemon start, held in memory only

## Process Supervision

Main service supervisor:
```ts
spawnDaemon('vault', {
  restartPolicy: 'always',
  maxRestartsPerHour: 5,
  cwd: appDataDir,
})
```

If daemon crashes:
1. Main service detects via IPC disconnect
2. All in-flight `proxyAuthedRequest` calls fail with `vault_unavailable`
3. Supervisor relaunches daemon
4. Main service reconnects, no state restoration needed (daemon is stateless except for keychain access)

## Security Properties

- Main process never has plaintext credentials in memory
- Compromised main process leaks only `CredentialRef` IDs
- Vault enforces per-credential rate limits (default: 60 ops / minute)
- Vault writes audit log entry per operation

## Implementation Files

```
packages/vault/
├── daemon/
│   ├── main.ts                 # entry point
│   ├── ipc-server.ts
│   ├── method-handlers/
│   ├── audit.ts
│   └── rate-limiter.ts
├── ipc-protocol/
│   ├── messages.ts             # types
│   └── client.ts               # used by main service
├── keychain-bindings/
│   └── napi-keyring-adapter.ts
└── crypto/
    ├── argon2.ts
    └── aes-gcm.ts
```
