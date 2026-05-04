# Adapter Interface

Every site adapter implements one of two interfaces. Capabilities are declared statically.

## AuctionAdapter (Sniper1)

```ts
interface AuctionAdapter {
  readonly siteId: string;
  readonly capabilities: AdapterCapabilities;
  
  identify(url: string): boolean;
  fetchSnapshot(itemId: ItemId, ctx: AdapterContext): Promise<ItemSnapshot>;
  placeBid(itemId: ItemId, amountCents: Money, ctx: AdapterContext): Promise<BidResult>;
  getServerTimeOffsetMs(ctx: AdapterContext): Promise<number>;
  
  // Optional: real-time push via WebSocket if site supports
  subscribeUpdates?(itemId: ItemId, onUpdate: (s: ItemSnapshot) => void): Unsubscribe;
}
```

## OrderingAdapter (Sniper2 / Sniper3)

```ts
interface OrderingAdapter {
  readonly siteId: string;
  readonly capabilities: AdapterCapabilities;
  
  identify(urlOrAppId: string): boolean;
  fetchProductSnapshot(productUrl: string, ctx: AdapterContext): Promise<ProductSnapshot>;
  resolveVariant(snapshot: ProductSnapshot, requiredVariants: Record<string, string>): VariantSnapshot | null;
  
  // Acquire/settle phases run via flow scripts; adapter exposes engine selection only.
  selectEngine(ctx: AdapterContext): 'http' | 'browser' | 'mobile-android';
}
```

## AdapterContext

```ts
interface AdapterContext {
  credentialRef: CredentialRef;             // not the secret itself
  egress: NetworkEgress;                    // injected, never use global fetch
  browserPool?: BrowserContextPool;
  mobileBridge?: MobileBridge;
  logger: Logger;
  scope: SniperScope;                       // for audit
  tenantId: TenantId;
  dryRunMode: boolean;                      // adapter must respect, never write data on dry run
}
```

## AdapterCapabilities

```ts
interface AdapterCapabilities {
  siteId: string;
  
  // Flow versioning
  supportedFlowVersions: number[];
  
  // Execution strategies (at least one true)
  supportsHttpStrategy: boolean;
  supportsBrowserStrategy: boolean;
  supportsMobileStrategy: boolean;
  
  // Mobile (only if supportsMobileStrategy)
  mobile?: {
    supportedPaths: ('local-usb' | 'cloud-emulator')[];
    recommendedPath: 'local-usb' | 'cloud-emulator';
    apkSource: 'play-store' | 'internal' | 'none-needed';
    apkPackageName?: string;                // if play-store/internal
  };
  
  // Concurrency limits
  maxAcquireConcurrent: number;             // simultaneous acquire on this site
  acquireSafeBurstWindow: number;           // ms within which N parallel acquire is safe
  
  // Timing estimates (used by EDF predictor)
  typicalAcquireDurationMs: number;
  typicalSettleDurationMs: number;
  
  // Reservation behavior
  reservationTypicalTtlMs: number;          // how long site usually holds checkout
  
  // Payment
  paymentChannelTypes: ('creditcard' | 'wallet' | 'balance')[];
  
  // Anti-detection profile recommendation
  recommendedPollProfile: 'conservative' | 'balanced' | 'aggressive';
  
  // Real-time price updates available?
  supportsPushUpdates: boolean;
}
```

## Adapter Registry

```ts
interface AdapterRegistry {
  registerAuction(adapter: AuctionAdapter): void;
  registerOrdering(adapter: OrderingAdapter): void;
  
  resolveAuction(siteIdOrUrl: string): AuctionAdapter | null;
  resolveOrdering(siteIdOrUrl: string): OrderingAdapter | null;
  
  list(kind?: 'auction' | 'ordering'): AdapterMetadata[];
}
```

## Identification Convention

`identify(url)` returns true if this adapter handles the URL/site. Registry tries adapters in registration order; first match wins.

## Implementation Files

```
packages/core/adapter-interface/
├── auction-adapter.ts
├── ordering-adapter.ts
├── adapter-context.ts
├── adapter-capabilities.ts
└── adapter-registry.ts

packages/adapters/
├── ebay/
│   ├── adapter.ts                # implements AuctionAdapter
│   ├── capabilities.ts
│   ├── http-strategy.ts
│   ├── browser-strategy.ts
│   └── time-sync.ts
├── goodwill/
├── _template/                    # scaffold for new adapters
└── registry.ts                   # registers all adapters at startup
```
