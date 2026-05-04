/**
 * @typedef {'http' | 'browser' | 'mobile-android'} ExecutionStrategy
 * @typedef {'creditcard' | 'wallet' | 'balance'} PaymentChannelType
 * @typedef {'conservative' | 'balanced' | 'aggressive'} PollProfile
 * @typedef {Object} AdapterCapabilities
 * @property {string} siteId
 * @property {number[]} supportedFlowVersions
 * @property {boolean} supportsHttpStrategy
 * @property {boolean} supportsBrowserStrategy
 * @property {boolean} supportsMobileStrategy
 * @property {number} maxAcquireConcurrent
 * @property {number} acquireSafeBurstWindow
 * @property {number} typicalAcquireDurationMs
 * @property {number} typicalSettleDurationMs
 * @property {number} reservationTypicalTtlMs
 * @property {PaymentChannelType[]} paymentChannelTypes
 * @property {PollProfile} recommendedPollProfile
 * @property {boolean} supportsPushUpdates
 */

export class AdapterRegistry {
  constructor() {
    this.auction = [];
    this.ordering = [];
  }

  registerAuction(adapter) {
    validateCapabilities(adapter.capabilities);
    this.auction.push(adapter);
  }

  registerOrdering(adapter) {
    validateCapabilities(adapter.capabilities);
    this.ordering.push(adapter);
  }

  resolveAuction(siteIdOrUrl) {
    return this.auction.find((adapter) => adapter.siteId === siteIdOrUrl || adapter.identify(siteIdOrUrl)) ?? null;
  }

  resolveOrdering(siteIdOrUrl) {
    return this.ordering.find((adapter) => adapter.siteId === siteIdOrUrl || adapter.identify(siteIdOrUrl)) ?? null;
  }

  list(kind) {
    const adapters = kind === 'auction' ? this.auction : kind === 'ordering' ? this.ordering : [...this.auction, ...this.ordering];
    return adapters.map((adapter) => ({
      siteId: adapter.siteId,
      kind: this.auction.includes(adapter) ? 'auction' : 'ordering',
      capabilities: adapter.capabilities
    }));
  }
}

export function validateCapabilities(capabilities) {
  if (!capabilities?.siteId) throw new TypeError('Adapter capability siteId is required');
  if (!Array.isArray(capabilities.supportedFlowVersions)) {
    throw new TypeError('supportedFlowVersions must be an array');
  }
  if (!capabilities.supportsHttpStrategy && !capabilities.supportsBrowserStrategy && !capabilities.supportsMobileStrategy) {
    throw new TypeError('Adapter must support at least one execution strategy');
  }
  if (capabilities.supportsMobileStrategy && capabilities.mobile?.supportedPaths?.some((platform) => String(platform).includes('ios'))) {
    throw new TypeError('Unsupported mobile automation platform');
  }
}

export function adapterContext({ credentialRef, egress, logger, scope, tenantId, browserPool, mobileBridge, dryRunMode = false }) {
  if (!credentialRef) throw new TypeError('credentialRef is required');
  if (!egress) throw new TypeError('egress is required');
  if (!logger) throw new TypeError('logger is required');
  if (!scope) throw new TypeError('scope is required');
  if (!tenantId) throw new TypeError('tenantId is required');
  return { credentialRef, egress, logger, scope, tenantId, browserPool, mobileBridge, dryRunMode };
}

export const NOOP_UNSUBSCRIBE = () => {};
