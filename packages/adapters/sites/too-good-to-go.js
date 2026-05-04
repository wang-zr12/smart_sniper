import { BaseMobileFlowOrderingAdapter } from '../_base/base-mobile-flow.js';

/**
 * Too Good To Go (TGTG) — Android-only, no shopping cart. The user picks a
 * store, a pickup date / window, and a quantity (1 to N bags). Tapping
 * "Reserve" creates a 5-minute reservation; tapping "Pay" within that window
 * confirms the charge to the configured payment method. There is no separate
 * cart or checkout page.
 *
 * Required intent fields surfaced via `POST /api/v1/sniper3/tgtg-watches`:
 *   - storeId       (商家)
 *   - pickupDate    (日期, ISO yyyy-mm-dd)
 *   - maxQuantity   (数量, 1..5)
 *   - maxUnitPriceCents
 *   - payment.methodRef
 */
export const TGTG_CONFIG = Object.freeze({
  siteId: 'tgtg',
  family: 'mobile-flow',
  identifyHosts: ['toogoodtogo.com', 'toogoodtogo.', 'tgtg.', 'too-good-to-go'],

  app: Object.freeze({
    androidPackage: 'com.app.tgtg',
    androidActivity: 'com.app.tgtg.activities.MainActivity'
  }),

  urls: Object.freeze({
    storeUrl: 'https://share.toogoodtogo.com/store/${storeId}'
  }),

  selectors: Object.freeze({
    storeSearch:      'css=android.widget.EditText[resource-id$="search_input"]',
    pickupDateButton: 'css=android.widget.Button[contentDescription~="${pickupDate}"]',
    quantityIncrease: 'css=*[resource-id$="quantity_plus"]',
    quantityValue:    'css=*[resource-id$="quantity_text"]',
    reserveButton:    'css=android.widget.Button[text~="(?i)reserve"]',
    payButton:        'css=android.widget.Button[text~="(?i)pay"]',
    confirmModal:     'css=*[resource-id$="payment_confirm_modal"]'
  }),

  flows: Object.freeze({
    fetchSnapshot: 'tgtg.snapshot@1',
    acquire:       'tgtg.reserve@1',
    settle:        'tgtg.pay@1'
  }),

  businessRules: Object.freeze({
    paymentDeadlineDays: 0,                 // n/a: charge is automatic on pay tap
    quantityHardCap: 5,                     // TGTG per-order limit (validated by buildTgtgRestockIntent)
    monitorIntervalMs: 60000,               // signal-source poll cadence
    typicalDropTimes: ['16:00', '17:00', '18:00'],
    captchaFlavor: 'none',
    pollProfile: 'conservative'
  }),

  capabilities: Object.freeze({
    siteId: 'tgtg',
    supportedFlowVersions: [1, 2],
    supportsHttpStrategy: false,
    supportsBrowserStrategy: false,
    supportsMobileStrategy: true,
    mobile: { supportedPaths: ['mobile-android'] },
    maxAcquireConcurrent: 1,
    acquireSafeBurstWindow: 1500,
    typicalAcquireDurationMs: 3000,
    typicalSettleDurationMs: 2000,
    reservationTypicalTtlMs: 300000,
    paymentChannelTypes: ['creditcard', 'wallet'],
    recommendedPollProfile: 'conservative',
    supportsPushUpdates: false
  }),

  fixtureVariants: Object.freeze([
    Object.freeze({
      sku: 'tgtg-bag-evening',
      attributes: { pickupDate: '2026-05-04', timeWindow: '17:00-19:00', bagType: 'surprise' },
      unitPriceCents: 599,
      inStock: true,
      stockHint: 3
    })
  ]),

  hooks: Object.freeze({})
});

export function createTooGoodToGoAdapter() {
  return new BaseMobileFlowOrderingAdapter(TGTG_CONFIG);
}
