import { BaseHtmlAuctionAdapter } from '../_base/base-html-auction.js';

/**
 * Template for new auction sites. Copy this file to sites/<your-site>.js and
 * fill in TODOs. See `docs/05-operations/adding-a-site.md` for the checklist.
 *
 * Hard rules (also enforced by check-source-policy.js):
 *  - No imports outside `../_base/...`
 *  - No `egress.fetch`, no `globalThis.fetch`, no `process.*`
 *  - iOS mobile path is forbidden; only Android is supported
 *  - Subclassing requires JSDoc `@override-reason`
 */
export const TEMPLATE_SITE_CONFIG = Object.freeze({
  siteId: 'template-site',                          // TODO: stable short id
  family: 'html-auction',
  identifyHosts: ['template-site.test'],            // TODO: real hosts

  urls: Object.freeze({
    snapshot:      'https://template-site.test/item/${itemId}',     // TODO
    bid:           'https://template-site.test/api/bid',            // TODO
    payPage:       'https://template-site.test/orders/${itemId}',   // TODO
    paymentStatus: null,                                            // optional
    login:         'https://template-site.test/login',
    serverTime:    null
  }),

  parsers: Object.freeze({
    currentPriceCents: { type: 'regex', pattern: /TODO/i, units: 'dollars' },
    minIncrementCents: { type: 'regex', pattern: /TODO/i, units: 'dollars' },
    endsAt:            { type: 'regex', pattern: /TODO/i, units: 'date' },
    highBidderIsMe:    { type: 'regex-presence', pattern: /TODO/i },
    bidCount:          { type: 'regex', pattern: /TODO/i, units: 'integer' }
  }),

  bid: Object.freeze({
    method: 'POST',
    contentType: 'application/json',
    bodyTemplate: { itemId: '${itemId}', amount: '${amountDollars}' },
    csrf: undefined,                                                // TODO if site uses CSRF
    successRegex: /TODO/i,
    amountTooLowRegex: /TODO/i,
    sessionExpiredStatuses: [401, 403]
  }),

  businessRules: Object.freeze({
    paymentDeadlineDays: 7,                          // TODO: site-specific
    bidIncrementTable: 'ebay_v1',                    // TODO: pick or add to _common/increment-tables.js
    serverTimeSource: 'response-date-header',
    requiresLogin: true,
    captchaFlavor: 'none',
    pollProfile: 'balanced'
  }),

  capabilities: Object.freeze({
    siteId: 'template-site',
    supportedFlowVersions: [2],
    supportsHttpStrategy: true,
    supportsBrowserStrategy: false,
    supportsMobileStrategy: false,
    maxAcquireConcurrent: 1,
    acquireSafeBurstWindow: 1000,
    typicalAcquireDurationMs: 1500,
    typicalSettleDurationMs: 0,
    reservationTypicalTtlMs: 0,
    paymentChannelTypes: [],
    recommendedPollProfile: 'balanced',
    supportsPushUpdates: false
  }),

  hooks: Object.freeze({})
});

export function createTemplateSiteAuctionAdapter() {
  return new BaseHtmlAuctionAdapter(TEMPLATE_SITE_CONFIG);
}
