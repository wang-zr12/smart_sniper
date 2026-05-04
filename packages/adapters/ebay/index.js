import { FixtureOrderingAdapter } from '../_template/index.js';

/**
 * eBay ordering adapter — still a fixture pending Sniper2 ordering family
 * migration to `sites/`. Auction adapter has moved to `sites/ebay.js`.
 */
export class EbayOrderingAdapter extends FixtureOrderingAdapter {
  constructor() {
    super({ siteId: 'ebay', identifyHost: 'ebay.' });
  }
}
