import { NOOP_UNSUBSCRIBE } from '../../core/adapter-interface/index.js';

export const fixtureCapabilities = Object.freeze({
  siteId: 'fixture',
  supportedFlowVersions: [1, 2],
  supportsHttpStrategy: true,
  supportsBrowserStrategy: true,
  supportsMobileStrategy: false,
  maxAcquireConcurrent: 3,
  acquireSafeBurstWindow: 1000,
  typicalAcquireDurationMs: 2000,
  typicalSettleDurationMs: 3000,
  reservationTypicalTtlMs: 600000,
  paymentChannelTypes: ['creditcard', 'wallet'],
  recommendedPollProfile: 'balanced',
  supportsPushUpdates: false
});

export class FixtureAuctionAdapter {
  constructor({ siteId = 'fixture-auction', identifyHost = 'example.test' } = {}) {
    this.siteId = siteId;
    this.identifyHost = identifyHost;
    this.capabilities = { ...fixtureCapabilities, siteId, supportsMobileStrategy: false };
    this.snapshots = new Map();
  }

  identify(url) {
    return String(url).includes(this.identifyHost) || String(url).includes(this.siteId);
  }

  async fetchSnapshot(itemId, ctx = {}) {
    if (ctx.dryRunMode === false && ctx.liveAuction?.snapshotRequest) {
      return fetchLiveAuctionSnapshot(this.siteId, itemId, ctx);
    }
    return this.snapshots.get(itemId) ?? {
      itemId,
      fetchedAt: new Date(),
      serverTime: new Date(),
      currentPriceCents: 1000,
      minIncrementCents: 100,
      endsAt: new Date(Date.now() + 60000),
      highBidderIsMe: false,
      bidCount: 0
    };
  }

  async placeBid(itemId, amountCents, ctx = {}) {
    if (ctx.dryRunMode === false) {
      return placeLiveAuctionBid(this.siteId, itemId, amountCents, ctx);
    }
    const snapshot = await this.fetchSnapshot(itemId);
    const accepted = amountCents >= snapshot.currentPriceCents + snapshot.minIncrementCents;
    if (!accepted) return { ok: false, reason: 'amount_too_low', retriable: true, serverTime: new Date() };
    const next = { ...snapshot, currentPriceCents: amountCents, highBidderIsMe: true, bidCount: snapshot.bidCount + 1 };
    this.snapshots.set(itemId, next);
    return { ok: true, newPriceCents: amountCents, highBidderIsMe: true, serverTime: new Date() };
  }

  async getServerTimeOffsetMs() {
    return 0;
  }

  subscribeUpdates(_itemId, _onUpdate) {
    return NOOP_UNSUBSCRIBE;
  }

  payDeadlineFromOutcome(_outcome, { now = new Date() } = {}) {
    const days = this.paymentDeadlineDays ?? 7;
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  payUrlFor(itemId) {
    return `https://${this.identifyHost.replace(/\.$/, '')}/pay/${itemId}`;
  }

  async fetchPaymentStatus(_itemId, _ctx) {
    return 'unknown';
  }
}

async function fetchLiveAuctionSnapshot(siteId, itemId, ctx) {
  const request = renderLiveRequest(ctx.liveAuction.snapshotRequest, { itemId, itemUrl: ctx.itemUrl });
  const response = await ctx.egress.fetch(request);
  if (response.status === 401 || response.status === 403) {
    throw codeError('session_expired', `Snapshot request was not authenticated for ${siteId}`);
  }
  if (response.status === 429) throw codeError('rate_limited', `Snapshot request was rate limited for ${siteId}`);
  if (response.status >= 500) throw codeError('network_error', `Snapshot request failed for ${siteId}`);
  const html = response.bodyText ?? '';
  return {
    itemId,
    fetchedAt: new Date(),
    serverTime: parseServerTime(response.headers?.date) ?? new Date(),
    currentPriceCents: parseCents(html, ctx.liveAuction.currentPriceRegex, 'current price'),
    minIncrementCents: parseCents(html, ctx.liveAuction.minIncrementRegex, 'minimum increment'),
    endsAt: parseDateCapture(html, ctx.liveAuction.endsAtRegex) ?? new Date(Date.now() + 60000),
    highBidderIsMe: parseBoolean(html, ctx.liveAuction.highBidderRegex),
    bidCount: parseInteger(html, ctx.liveAuction.bidCountRegex) ?? 0,
    rawHtml: ctx.liveAuction.keepRawHtml ? html : undefined
  };
}

async function placeLiveAuctionBid(siteId, itemId, amountCents, ctx) {
  if (!ctx.liveTransactionAllowed) throw codeError('user_cancelled', 'Live bid blocked by transaction guard');
  if (!ctx.liveAuction?.bidRequest) throw codeError('flow_outdated', `Missing live bid request mapping for ${siteId}`);
  const request = renderLiveRequest(ctx.liveAuction.bidRequest, {
    itemId,
    itemUrl: ctx.itemUrl,
    amountCents,
    amountDollars: (amountCents / 100).toFixed(2)
  });
  const response = await ctx.egress.fetch(request);
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'session_expired', retriable: true, serverTime: parseServerTime(response.headers?.date) ?? new Date() };
  }
  if (response.status === 429) {
    return { ok: false, reason: 'rate_limited', retriable: true, serverTime: parseServerTime(response.headers?.date) ?? new Date() };
  }
  if (response.status >= 500) {
    return { ok: false, reason: 'network_error', retriable: true, serverTime: parseServerTime(response.headers?.date) ?? new Date() };
  }
  const body = response.bodyText ?? '';
  const success = ctx.liveAuction.bidSuccessRegex ? new RegExp(ctx.liveAuction.bidSuccessRegex, 'i').test(body) : response.status < 400;
  if (!success) {
    const reason = ctx.liveAuction.amountTooLowRegex && new RegExp(ctx.liveAuction.amountTooLowRegex, 'i').test(body)
      ? 'amount_too_low'
      : 'network_error';
    return { ok: false, reason, retriable: reason !== 'amount_too_low', serverTime: parseServerTime(response.headers?.date) ?? new Date() };
  }
  const newPriceCents = ctx.liveAuction.newPriceRegex ? parseCents(body, ctx.liveAuction.newPriceRegex, 'new price') : amountCents;
  return {
    ok: true,
    newPriceCents,
    highBidderIsMe: ctx.liveAuction.highBidderRegex ? parseBoolean(body, ctx.liveAuction.highBidderRegex) : true,
    serverTime: parseServerTime(response.headers?.date) ?? new Date()
  };
}

function renderLiveRequest(template, values) {
  const headers = {};
  for (const [key, value] of Object.entries(template.headers ?? {})) headers[key] = renderTemplate(value, values);
  const body = typeof template.body === 'string'
    ? renderTemplate(template.body, values)
    : template.body
      ? JSON.stringify(Object.fromEntries(Object.entries(template.body).map(([key, value]) => [key, renderTemplate(String(value), values)])))
      : undefined;
  return {
    method: template.method ?? 'GET',
    url: renderTemplate(template.url, values),
    headers,
    body,
    timeoutMs: template.timeoutMs
  };
}

function renderTemplate(value, values) {
  return String(value).replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(values[key] ?? ''));
}

function parseCents(text, regex, label) {
  if (!regex) throw codeError('flow_outdated', `Missing regex for ${label}`);
  const match = String(text).match(new RegExp(regex, 'i'));
  if (!match) throw codeError('flow_outdated', `Could not parse ${label}`);
  const raw = String(match[1] ?? match[0]).replace(/[$,\s]/g, '');
  const value = Number(raw);
  if (!Number.isFinite(value)) throw codeError('flow_outdated', `Parsed ${label} is not numeric`);
  return Math.round(value * 100);
}

function parseInteger(text, regex) {
  if (!regex) return undefined;
  const match = String(text).match(new RegExp(regex, 'i'));
  return match ? Number.parseInt(match[1] ?? match[0], 10) : undefined;
}

function parseBoolean(text, regex) {
  if (!regex) return false;
  return new RegExp(regex, 'i').test(String(text));
}

function parseDateCapture(text, regex) {
  if (!regex) return undefined;
  const match = String(text).match(new RegExp(regex, 'i'));
  if (!match) return undefined;
  const date = new Date(match[1] ?? match[0]);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseServerTime(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class FixtureOrderingAdapter {
  constructor({ siteId = 'fixture-shop', identifyHost = 'shop.test' } = {}) {
    this.siteId = siteId;
    this.identifyHost = identifyHost;
    this.capabilities = { ...fixtureCapabilities, siteId };
  }

  identify(urlOrAppId) {
    return String(urlOrAppId).includes(this.identifyHost) || String(urlOrAppId).includes(this.siteId);
  }

  async fetchProductSnapshot(productUrl) {
    return {
      siteId: this.siteId,
      productUrl,
      fetchedAt: new Date(),
      inStock: true,
      variants: [
        { attributes: { size: '42', color: 'black' }, sku: 'sku-42-black', unitPriceCents: 12000, inStock: true, stockHint: 2 },
        { attributes: { size: '43', color: 'black' }, sku: 'sku-43-black', unitPriceCents: 12000, inStock: false }
      ]
    };
  }

  resolveVariant(snapshot, requiredVariants) {
    return snapshot.variants.find((variant) => variant.inStock && Object.entries(requiredVariants).every(([key, value]) => variant.attributes[key] === value)) ?? null;
  }

  selectEngine() {
    return 'http';
  }

  /**
   * Post-settle order status — used by `Sniper2Service.scheduleOrderVerification`
   * to detect 支付中途超时 (3.2) and 支付后库存回滚 (3.3) without baking that
   * logic into every site. Default is 'unknown' (adapter has no real endpoint).
   * Concrete adapters override; the verifier short-circuits on 'unknown' twice
   * in a row → emits payment_timeout notification.
   *
   * @returns {Promise<'confirmed' | 'pending' | 'cancelled' | 'refunded' | 'unknown'>}
   */
  async fetchOrderStatus(_orderConfirmation, _ctx) {
    return 'unknown';
  }
}
