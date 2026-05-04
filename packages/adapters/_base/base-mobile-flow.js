import { renderTemplate } from './_common/template.js';
import { validateMobileFlowSiteConfig } from './site-config-schema.js';

/**
 * Base adapter for app-only sites without a shopping cart (TGTG, Pop Mart,
 * 闲鱼/淘宝, etc.). Reservation = ephemeral pre-payment state captured after
 * the user taps "Reserve"; settle = tap "Pay" to confirm. Sites where
 * reserve and pay collapse into a single screen still split logically into
 * acquire/settle so that PaymentChannel can serialize same-method payments
 * (Invariant #14).
 *
 * In M0 there is no real Appium runner. When `ctx.mobileSession.runFlowStep`
 * is provided, the base delegates; otherwise it returns config-driven mock
 * snapshots so the rest of the pipeline (RestockIntent → ScheduledOrderIntent
 * → Sniper2 task → state machine) is exercisable end-to-end with fixtures.
 */
export class BaseMobileFlowOrderingAdapter {
  constructor(config) {
    const result = validateMobileFlowSiteConfig(config);
    if (!result.ok) {
      throw new Error(`Site config invalid for ${config?.siteId ?? '?'}: ${result.errors.join('; ')}`);
    }
    this.config = config;
    this.siteId = config.siteId;
    this.identifyHosts = [...config.identifyHosts];
    this.capabilities = config.capabilities;
  }

  identify(urlOrAppId) {
    const subject = String(urlOrAppId);
    if (subject === this.siteId) return true;
    if (this.config.app?.androidPackage && subject === this.config.app.androidPackage) return true;
    return this.identifyHosts.some((host) => subject.includes(host));
  }

  async fetchProductSnapshot(storeIdOrUrl, ctx = {}) {
    const session = ctx.mobileSession ?? ctx.mobileBridge?.session;
    if (session?.runFlowStep && this.config.flows?.fetchSnapshot) {
      const result = await session.runFlowStep(this.config.flows.fetchSnapshot, {
        storeId: storeIdOrUrl,
        ...(ctx.input ?? {})
      });
      // Session may return `{ snapshot: null }` as a sentinel for "I have nothing,
      // fall back to your fixture path" — common in test mocks. Otherwise:
      //   - { snapshot: <obj> } → return inner
      //   - <plain snapshot>    → return as-is
      if (result && typeof result === 'object') {
        if (result.snapshot != null) return result.snapshot;
        if (!('snapshot' in result)) return result;
      }
      // fall through to fixture
    }
    const requestedDate = ctx.input?.pickupDate;
    const baseVariants = this.config.fixtureVariants ?? [];
    const variants = baseVariants.map((variant) => ({
      ...variant,
      attributes: { ...variant.attributes, pickupDate: requestedDate ?? variant.attributes?.pickupDate }
    }));
    return {
      siteId: this.siteId,
      storeId: storeIdOrUrl,
      productUrl: this.config.urls?.storeUrl
        ? renderTemplate(this.config.urls.storeUrl, { storeId: storeIdOrUrl })
        : storeIdOrUrl,
      fetchedAt: new Date(),
      inStock: variants.some((variant) => variant.inStock),
      variants
    };
  }

  resolveVariant(snapshot, requiredVariants) {
    if (!snapshot?.variants?.length || !requiredVariants) return null;
    return snapshot.variants.find((variant) =>
      variant.inStock && Object.entries(requiredVariants).every(([key, value]) => variant.attributes?.[key] === value)
    ) ?? null;
  }

  selectEngine() {
    return 'mobile-android';
  }

  /**
   * Post-settle order status (3.2 / 3.3). When `config.flows.fetchOrderStatus`
   * is defined and a mobile session is provided, delegates to the session.
   * Otherwise returns 'unknown' so the verifier can decide via its unknown-streak
   * heuristic whether to treat the order as timed-out.
   *
   * @returns {Promise<'confirmed' | 'pending' | 'cancelled' | 'refunded' | 'unknown'>}
   */
  async fetchOrderStatus(orderConfirmation, ctx = {}) {
    const session = ctx?.mobileSession ?? ctx?.mobileBridge?.session;
    if (session?.runFlowStep && this.config.flows?.fetchOrderStatus) {
      const result = await session.runFlowStep(this.config.flows.fetchOrderStatus, {
        orderId: orderConfirmation?.orderId,
        ...(ctx.input ?? {})
      });
      const status = result?.status ?? result;
      const valid = ['confirmed', 'pending', 'cancelled', 'refunded', 'unknown'];
      return valid.includes(status) ? status : 'unknown';
    }
    return 'unknown';
  }
}
