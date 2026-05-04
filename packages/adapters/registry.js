import { AdapterRegistry } from '../core/adapter-interface/index.js';
import { createEbayAuctionAdapter } from './sites/ebay.js';
import { createShopgoodwillAuctionAdapter } from './sites/shopgoodwill.js';
import { createTooGoodToGoAdapter } from './sites/too-good-to-go.js';
import { EbayOrderingAdapter } from './ebay/index.js';
import { FixtureOrderingAdapter } from './_template/index.js';

/**
 * Default adapter registry for the local MVP.
 *
 * Auction adapters and the mobile-flow TGTG adapter live in `sites/<site>.js`
 * (config + factory only) and use `_base/Base*Adapter`. Remaining ordering
 * adapters are still empty subclasses pending the rest of the family
 * migration (Shopify / Magento / queue-gated, M+).
 */
export function createDefaultAdapterRegistry() {
  const registry = new AdapterRegistry();
  registry.registerAuction(createEbayAuctionAdapter());
  registry.registerAuction(createShopgoodwillAuctionAdapter());
  registry.registerOrdering(new EbayOrderingAdapter());
  registry.registerOrdering(new FixtureOrderingAdapter({ siteId: 'fixture-shop', identifyHost: 'shop.test' }));
  registry.registerOrdering(createTooGoodToGoAdapter());
  return registry;
}
