# Domain Types

Single source of truth for cross-package types. Lives in `packages/core/domain-types/`.

## Money

```ts
type Money = number;            // integer cents (USD), e.g. 1250 = $12.50
```

Never use floats for money. All conversions at API boundary only.

## IDs

```ts
type ItemId = string;           // 'item:<uuid>'
type TaskId = string;           // 'task:<uuid>'
type WatchId = string;          // 'watch:<uuid>'
type FlowRef = string;          // '<flow_id>@<version>', e.g. 'ebay.buy-product@2'
type CredentialRef = string;    // 'cred:<uuid>'
type TenantId = string;         // 'local-user' for MVP
```

## Time

```ts
type ServerTime = number;       // unix ms, server-side
type LocalTime = number;        // unix ms, local clock
// Date objects in interfaces are always UTC
```

## Credentials

```ts
type Secret =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'cookie'; cookies: SerializedCookie[] }
  | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: Date }
  | { kind: 'creditcard'; number: string; cvv: string; exp: string; holder: string }
  | { kind: 'wallet'; provider: string; sessionToken: string };

interface CredentialRefMetadata {
  ref: CredentialRef;
  siteId: string;
  kind: Secret['kind'];
  label: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}
```

## Snapshots

```ts
interface ItemSnapshot {                  // auction
  itemId: ItemId;
  fetchedAt: Date;
  serverTime: Date;
  currentPriceCents: Money;
  minIncrementCents: Money;
  endsAt: Date;
  highBidderIsMe: boolean;
  bidCount: number;
  rawHtml?: string;                       // for debugging
}

interface ProductSnapshot {               // ordering / restock
  siteId: string;
  productUrl: string;
  fetchedAt: Date;
  variants: VariantSnapshot[];
  inStock: boolean;
  rawHtml?: string;
}

interface VariantSnapshot {
  attributes: Record<string, string>;     // { size: '42', color: 'black' }
  sku?: string;
  unitPriceCents: Money;
  inStock: boolean;
  stockHint?: number;                     // if site exposes it
}

interface ResolvedVariant {
  variant: VariantSnapshot;
  matchedFromList: 'required' | 'fallback';
  fallbackIndex?: number;                 // which fallback was used
}
```

## Bid Events

```ts
type BidResult =
  | { ok: true; newPriceCents: Money; highBidderIsMe: boolean; serverTime: Date }
  | { ok: false; reason: BidFailReason; retriable: boolean; serverTime: Date };

type BidFailReason =
  | 'auction_ended'
  | 'amount_too_low'
  | 'amount_exceeds_budget'
  | 'session_expired'
  | 'network_error'
  | 'rate_limited';

interface BidEvent {
  itemId: ItemId;
  amountCents: Money;
  result: BidResult;
  triggeredBy: 'scheduler' | 'tie_bump' | 'outbid_bump' | 'manual';
  at: Date;
}
```

## Order Execution

```ts
type ReservationToken = {
  raw: string;                            // adapter-specific opaque token
  source: 'url_param' | 'cookie' | 'dom_attribute' | 'response_header';
};

type AcquireResult =
  | { ok: true; reservationToken: ReservationToken; reservationExpiresAt: Date; resolvedVariant: ResolvedVariant }
  | { ok: false; reason: ErrorCode; retriable: boolean };

type SettleResult =
  | { ok: true; orderConfirmation: OrderConfirmation }
  | { ok: false; reason: ErrorCode; retriable: boolean };

interface OrderConfirmation {
  orderId: string;
  totalChargedCents: Money;
  confirmedAt: Date;
  rawReceiptUrl?: string;
}
```

## Polling

```ts
type PollingTier = 'cold' | 'warm' | 'hot' | 'strike' | 'post' | 'idle' | 'hint' | 'detected';
```

## Scope

```ts
type SniperScope = 'sniper1' | 'sniper2' | 'sniper3';
type Platform = 'web' | 'mobile-android';     // no mobile-ios
type DeploymentForm = 'local' | 'saas';
```

## Errors

See `02-core/error-codes.md` for full `ErrorCode` enum.

## Guard / Decision Outputs

```ts
type GuardResult =
  | { pass: true }
  | { pass: false; reason: ErrorCode; userMessage: string }
  | { defer: true; until: Date; reason: string };       // wait and recheck

type BumpDecision =
  | { bump: false; reason: string }
  | { bump: true; amountCents: Money; reason: string };

type TriggerDecision =
  | { trigger: true; confidence: 'high' | 'medium' }
  | { trigger: false; reason: string }
  | { revalidate: true; afterMs: number };
```

## Implementation File

```
packages/core/domain-types/
├── money.ts
├── ids.ts
├── time.ts
├── credentials.ts
├── snapshots.ts
├── bid-events.ts
├── order-execution.ts
├── polling.ts
├── scope.ts
├── guards.ts
└── index.ts                               # re-export everything
```

All other packages import from `@smart-sniper/core/domain-types`.
