# Site Config Spec

`packages/adapters/sites/<site>.js` is the only place site-specific knowledge lives. Files there are pure data + a factory; behavior comes from `packages/adapters/_base/`.

## Required exports

```js
export const SITE_CONFIG = Object.freeze({ ... });
export function createXxxAdapter() { return new BaseXxxAdapter(SITE_CONFIG); }
```

## Hard rules (enforced by lint + registry validator)

1. No `import` outside `../_base/...`. No `core/`, `server/`, `vault/`, `mobile-bridge/`.
2. No `egress.fetch`, no `globalThis.fetch`, no `process.*`.
3. No string `'mobile-ios'` (Hard Constraint).
4. `SITE_CONFIG` must pass `validate{Family}SiteConfig` from `_base/site-config-schema.js`.
5. If a `class extends Base*Adapter` exists, it must carry `@override-reason` JSDoc explaining why config + hooks are not enough.

## Common config shape (auction example)

```js
{
  siteId: 'shopgoodwill',
  family: 'html-auction',
  identifyHosts: ['shopgoodwill.com'],

  urls: {
    snapshot: 'https://shopgoodwill.com/item/{itemId}',
    bid:      'https://shopgoodwill.com/api/Item/PlaceBid',
    payPage:  'https://shopgoodwill.com/cart',
    paymentStatus: 'https://shopgoodwill.com/buyer/orders/{itemId}',
    login:    'https://shopgoodwill.com/login',
    serverTime: null,                                      // null → use response Date header
  },

  parsers: {
    currentPriceCents: { type: 'regex', pattern: /Current Price:\s*\$([0-9.,]+)/i, units: 'dollars' },
    minIncrementCents: { type: 'regex', pattern: /Bid Increment:\s*\$([0-9.,]+)/i, units: 'dollars' },
    endsAt:            { type: 'regex', pattern: /Auction Ends:\s*([^<]+?PT)/i, format: 'tz=America/Los_Angeles' },
    highBidderIsMe:    { type: 'regex-presence', pattern: /You are the high bidder/i },
    bidCount:          { type: 'regex', pattern: /Bids:\s*(\d+)/i },
  },

  bid: {
    method: 'POST',
    contentType: 'application/json',
    bodyTemplate: { itemId: '${itemId}', bidAmount: '${amountDollars}' },
    csrf: { source: 'cookie', name: '__RequestVerificationToken', injectAs: 'header:X-RequestVerificationToken' },
    successRegex:      /BidPlaced/i,
    amountTooLowRegex: /below.*minimum/i,
    sessionExpiredStatuses: [401, 403],
  },

  businessRules: {
    paymentDeadlineDays: 7,
    bidIncrementTable:   'shopgoodwill_v2',                // → _common/increment-tables.js
    serverTimeSource:    'response-date-header',
    requiresLogin:       true,
    captchaFlavor:       'cloudflare-turnstile',
    pollProfile:         'conservative',
  },

  capabilities: { /* AdapterCapabilities */ },

  hooks: { preBid: undefined, postBid: undefined, parseSnapshotOverride: undefined },
}
```

## Parser rule grammar

```ts
type ParserRule =
  | { type: 'regex'; pattern: RegExp; units?: 'dollars' | 'cents' | 'integer'; format?: string }
  | { type: 'regex-presence'; pattern: RegExp }                  // boolean
  | { type: 'jsonpath'; path: string; units?: ... }
  | { type: 'css'; selector: string; attribute?: string; units?: ... }
  | { type: 'response-header'; name: string; units?: ... }
  | { type: 'response-date' };                                   // returns Date from response.headers.date
```

`_base/_common/parsers.js` is the only place these rule types are interpreted.

## Family-specific config slots

| Family | Required slots beyond core |
|---|---|
| `html-auction` | `urls.snapshot`, `urls.bid`, `urls.payPage`, `parsers.{currentPriceCents,minIncrementCents,endsAt,highBidderIsMe,bidCount}`, `bid.*`, `businessRules.paymentDeadlineDays` |
| `api-auction` | `urls.api`, `auth.{kind,credentialMapping}`, no html parsers |
| `shopify-ordering` | `urls.{product,cart,checkout,pay}`, `selectors` (variant picker), `flow` ref |
| `magento-ordering` | similar to shopify with Magento-specific endpoints |
| `queue-gated` | `queue.{detect,waitStrategy,maxWaitMs}` |
| `mobile-flow` | `app.{androidPackage,androidActivity}`, `selectors` (Appium/UIAutomator2), `flow` ref |

## Escape hatches (minimize use)

### A. Hooks (preferred)

```js
hooks: {
  preBid:  async (ctx, requestBuilder) => { /* mutate builder */ },
  postBid: async (ctx, response, parsed) => { return parsed; /* or override */ },
  parseSnapshotOverride: async (ctx, response) => { /* full takeover, returns ItemSnapshot */ },
}
```

### B. `class extends Base*Adapter`

Last resort. Must have JSDoc:

```js
/**
 * @override-reason Site uses a non-standard CSRF rotation that requires fetching
 * a fresh token before every bid; cannot be expressed as a static `bid.csrf` config.
 */
class WeirdSiteAuctionAdapter extends BaseHtmlAuctionAdapter { ... }
```

policy-lint rejects subclasses without `@override-reason`.

## Registry validation

```js
// registry.js
import { validateAuctionSiteConfig } from './_base/site-config-schema.js';
for (const config of [SHOPGOODWILL_CONFIG, EBAY_CONFIG, ...]) {
  const result = validateAuctionSiteConfig(config);
  if (!result.ok) throw new Error(`${config.siteId}: ${result.errors.join('; ')}`);
}
```

## Adding a new site

See `05-operations/adding-a-site.md`.
