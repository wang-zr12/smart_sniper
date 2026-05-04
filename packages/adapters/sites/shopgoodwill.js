import { BaseHtmlAuctionAdapter } from '../_base/base-html-auction.js';

/**
 * shopgoodwill.com HTML auction config. Browser fallback is mandatory because
 * Cloudflare Turnstile is occasionally enforced; HTTP works during low-traffic
 * windows. payment deadline is 7 days per Goodwill terms.
 */
export const SHOPGOODWILL_CONFIG = Object.freeze({
  siteId: 'shopgoodwill',
  family: 'html-auction',
  identifyHosts: ['shopgoodwill.com', 'goodwill.', 'shopgoodwill.'],

  urls: Object.freeze({
    snapshot:      'https://shopgoodwill.com/item/${itemId}',
    bid:           'https://shopgoodwill.com/api/Item/PlaceBid',
    payPage:       'https://shopgoodwill.com/cart',
    paymentStatus: 'https://shopgoodwill.com/buyer/orders/${itemId}',
    login:         'https://shopgoodwill.com/login',
    serverTime:    null
  }),

  parsers: Object.freeze({
    currentPriceCents: { type: 'regex', pattern: /Current\s+Price:\s*\$([0-9,]+\.[0-9]{2})/i, units: 'dollars' },
    minIncrementCents: { type: 'regex', pattern: /Bid\s+Increment:\s*\$([0-9,]+\.[0-9]{2})/i, units: 'dollars' },
    endsAt:            { type: 'regex', pattern: /Auction\s+Ends:\s*([^<]+?PT)/i, format: 'tz=America/Los_Angeles' },
    highBidderIsMe:    { type: 'regex-presence', pattern: /You\s+are\s+the\s+high\s+bidder/i },
    bidCount:          { type: 'regex', pattern: /Bids:\s*([0-9]+)/i, units: 'integer' }
  }),

  bid: Object.freeze({
    method: 'POST',
    contentType: 'application/json',
    bodyTemplate: { itemId: '${itemId}', bidAmount: '${amountDollars}' },
    csrf: { source: 'cookie', name: '__RequestVerificationToken', injectAs: 'header:X-RequestVerificationToken' },
    successRegex: /BidPlaced|high\s+bidder/i,
    amountTooLowRegex: /below.*minimum|raise\s+your\s+bid/i,
    sessionExpiredStatuses: [401, 403],
    accountBlockedRegex: /account.+(suspended|banned|disabled)|access\s+denied/i,
    declineReasons: [
      { match: /insufficient\s+funds|nsf/i,         code: 'insufficient_funds' },
      { match: /lost.*card|stolen.*card|expired/i,  code: 'payment_declined_hard' },
      { match: /declined|refused/i,                  code: 'payment_declined' }
    ]
  }),

  businessRules: Object.freeze({
    paymentDeadlineDays: 7,
    bidIncrementTable: 'shopgoodwill_v2',
    serverTimeSource: 'response-date-header',
    requiresLogin: true,
    captchaFlavor: 'cloudflare-turnstile',
    pollProfile: 'conservative'
  }),

  capabilities: Object.freeze({
    siteId: 'shopgoodwill',
    supportedFlowVersions: [2],
    supportsHttpStrategy: true,
    supportsBrowserStrategy: true,
    supportsMobileStrategy: false,
    maxAcquireConcurrent: 1,
    acquireSafeBurstWindow: 1500,
    typicalAcquireDurationMs: 2000,
    typicalSettleDurationMs: 0,
    reservationTypicalTtlMs: 0,
    paymentChannelTypes: [],
    recommendedPollProfile: 'conservative',
    supportsPushUpdates: false
  }),

  hooks: Object.freeze({})
});

export function createShopgoodwillAuctionAdapter() {
  return new BaseHtmlAuctionAdapter(SHOPGOODWILL_CONFIG);
}
