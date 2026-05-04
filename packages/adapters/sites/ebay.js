import { BaseHtmlAuctionAdapter } from '../_base/base-html-auction.js';

/**
 * eBay HTML auction config. Selectors / regex are illustrative — verify
 * against current pages before turning on production bidding.
 *
 * Family: html-auction (alternative API path lives in sites/ebay-api.js, M+).
 */
export const EBAY_CONFIG = Object.freeze({
  siteId: 'ebay',
  family: 'html-auction',
  identifyHosts: ['ebay.com', 'ebay.', '.ebay.'],

  urls: Object.freeze({
    snapshot:      'https://www.ebay.com/itm/${itemId}',
    bid:           'https://offer.ebay.com/ws/eBayISAPI.dll',
    payPage:       'https://pay.ebay.com/?itemId=${itemId}',
    paymentStatus: 'https://www.ebay.com/mye/myebay/v2/purchase?itemId=${itemId}',
    login:         'https://signin.ebay.com/',
    serverTime:    null
  }),

  parsers: Object.freeze({
    currentPriceCents: { type: 'regex', pattern: /US\s*\$([0-9,]+\.[0-9]{2})/i, units: 'dollars' },
    minIncrementCents: { type: 'regex', pattern: /minimum\s+bid:\s*US\s*\$([0-9,]+\.[0-9]{2})/i, units: 'dollars' },
    endsAt:            { type: 'regex', pattern: /data-end-time=["']([^"']+)["']/i, units: 'date' },
    highBidderIsMe:    { type: 'regex-presence', pattern: /You\s+are\s+the\s+high\s+bidder/i },
    bidCount:          { type: 'regex', pattern: /([0-9]+)\s+bids?/i, units: 'integer' }
  }),

  bid: Object.freeze({
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    bodyTemplate: { MfcISAPICommand: 'MakeBid', item: '${itemId}', maxbid: '${amountDollars}' },
    csrf: { source: 'cookie', name: 'ebay_xsrf', injectAs: 'header:X-Ebay-Csrf' },
    successRegex: /You\s+are\s+the\s+high\s+bidder/i,
    amountTooLowRegex: /below\s+the\s+minimum/i,
    sessionExpiredStatuses: [302, 401, 403],
    accountBlockedRegex: /account.+(suspended|restricted|on\s+hold)|sign\s+in.+blocked/i,
    declineReasons: [
      { match: /insufficient\s+funds/i,             code: 'insufficient_funds' },
      { match: /declined|do\s+not\s+honor/i,         code: 'payment_declined' }
    ]
  }),

  businessRules: Object.freeze({
    paymentDeadlineDays: 4,
    bidIncrementTable: 'ebay_v1',
    serverTimeSource: 'response-date-header',
    requiresLogin: true,
    captchaFlavor: 'none',
    pollProfile: 'balanced'
  }),

  capabilities: Object.freeze({
    siteId: 'ebay',
    supportedFlowVersions: [2],
    supportsHttpStrategy: true,
    supportsBrowserStrategy: true,
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

export function createEbayAuctionAdapter() {
  return new BaseHtmlAuctionAdapter(EBAY_CONFIG);
}
