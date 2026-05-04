# Adding a Site

Step-by-step guide for adding a new site adapter. Target: a competent engineer can add a Shopify-class site in under 30 minutes.

## Prerequisites

- Read `02-core/adapter-interface.md`, `02-core/site-config-spec.md`
- Identify the family (auction / shopify-ordering / magento-ordering / queue-gated / mobile-flow / api-auction)
- Have a sample HTML page or JSON response for the site to cross-check parsers

## Steps

### 1. Copy the template

```bash
cp packages/adapters/sites/_template-site.js packages/adapters/sites/<your-site>.js
```

### 2. Fill in `siteId`, `family`, `identifyHosts`

- `siteId`: short stable string, used in DB and APIs (`'shopgoodwill'` not `'Shop Goodwill'`)
- `family`: must match an existing `_base/` adapter family
- `identifyHosts`: substrings the registry uses to dispatch URLs

### 3. Fill in `urls`

Resolve every URL the site uses for the operations the family supports. Use `{itemId}` etc. as templates. Variables are interpolated by `_common/template.js`.

### 4. Fill in `parsers`

Pick the parser rule type. Test in isolation:

```bash
node tools/adapter-cli/index.js validate-flow --site <your-site>
```

(adapter-cli will load your config + a saved fixture HTML and assert each rule produces the expected value).

### 5. Fill in `bid` / `cart` / `checkout` / `pay`

Look at the site's network tab. Capture:
- Method (`POST` typically)
- Content type
- Body shape (use `${itemId}`, `${amountDollars}` template variables)
- CSRF source (cookie / meta / hidden form input)
- Success regex / failure regex / session-expired statuses

### 6. Fill in `businessRules`

| Field | Source |
|---|---|
| `paymentDeadlineDays` | site terms ("Pay within X days") |
| `bidIncrementTable` | name in `_common/increment-tables.js`; add a new row if site is unusual |
| `serverTimeSource` | `'response-date-header'` (default) / `'ntp'` / `'custom-endpoint'` |
| `requiresLogin` | true if anonymous browsing fails |
| `captchaFlavor` | `'none'` / `'cloudflare-turnstile'` / `'hcaptcha'` / `'recaptcha-v2'` / `'recaptcha-v3'` / `'press-and-hold'` |
| `pollProfile` | `'conservative'` (rare/strict sites) / `'balanced'` (default) / `'aggressive'` (your own private API) |

### 7. Fill in `capabilities`

Be honest. If the site cannot be done over HTTP because it requires JS execution, set `supportsHttpStrategy: false` and `supportsBrowserStrategy: true`.

### 8. Register

Edit `packages/adapters/registry.js`:

```js
import { createYourSiteAdapter, YOUR_SITE_CONFIG } from './sites/your-site.js';
// ...
registry.registerAuction(createYourSiteAdapter());     // or registerOrdering
```

The registry runs `validate{Family}SiteConfig` and refuses invalid configs.

### 9. Test

Add a test in `tests/core.test.js`:

```js
test('your-site: registry resolves and capabilities are honest', () => {
  const registry = createDefaultAdapterRegistry();
  const adapter = registry.resolveAuction('https://your-site.com/item/123');
  assert.equal(adapter.siteId, 'your-site');
  assert.equal(adapter.capabilities.supportsHttpStrategy, true);
});
```

End-to-end testing against the real site is gated behind the LiveTransactionGuard (developer mode + explicit confirmation). Default tests use fixture responses only.

## Anti-patterns (rejected by review)

- ❌ Importing from `core/`, `server/`, or `vault/` in a `sites/*.js` file
- ❌ Calling `egress.fetch` from `sites/*.js`
- ❌ Adding a method to `sites/*.js` that contains business logic (parse, transform, decide) — push that into a hook or `_base/_common/`
- ❌ Subclassing without `@override-reason` JSDoc
- ❌ Capabilities that lie (e.g., `supportsBrowserStrategy: true` while the only code path is HTTP)

## After M5 (mobile)

Sites belonging to family `mobile-flow` additionally need:
- `app.androidPackage`
- Appium/UIAutomator2 selectors in `selectors`
- A FlowScript (`flow`) referencing the actions sequence
- `mobile-bridge/emulator-pool/` ready to acquire a session
