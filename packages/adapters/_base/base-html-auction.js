import { renderTemplate, renderBody } from './_common/template.js';
import { parseByRule } from './_common/parsers.js';
import { applyMiddleware } from './_common/middleware-egress.js';
import { csrfHeaders } from './_common/csrf.js';
import { computeServerTimeOffsetMs } from './_common/server-time.js';
import { detectCaptcha } from './_common/captcha-detection.js';
import { computePayDeadline } from './_common/pay-deadline.js';
import { lookupIncrement } from './_common/increment-tables.js';
import { validateAuctionSiteConfig } from './site-config-schema.js';

/**
 * Site-agnostic HTML auction adapter. Behavior is fully driven by the
 * SITE_CONFIG passed to the constructor; subclasses are reserved for
 * irreducible per-site quirks and must carry an @override-reason JSDoc.
 *
 * Public surface mirrors AuctionAdapter (02-core/adapter-interface.md).
 */
export class BaseHtmlAuctionAdapter {
  constructor(config) {
    const result = validateAuctionSiteConfig(config);
    if (!result.ok) {
      throw new Error(`Site config invalid for ${config?.siteId ?? '?'}: ${result.errors.join('; ')}`);
    }
    this.config = config;
    this.siteId = config.siteId;
    this.identifyHosts = [...config.identifyHosts];
    this.capabilities = config.capabilities;
  }

  identify(urlOrId) {
    const subject = String(urlOrId);
    return this.identifyHosts.some((host) => subject.includes(host));
  }

  async fetchSnapshot(itemId, ctx = {}) {
    if (this.config.hooks?.parseSnapshotOverride) {
      return this.config.hooks.parseSnapshotOverride(ctx, this.config, itemId);
    }
    const egress = ensureEgress(ctx, this.config, this.siteId, 'fetchSnapshot');
    const url = renderTemplate(this.config.urls.snapshot, { itemId, ...(ctx.input ?? {}) });
    const response = await egress.fetch({
      method: 'GET',
      url,
      headers: ctx.headers ?? {}
    });
    // Account-block check runs before status-code mapping so a 200 page that
    // contains a "your account is suspended" body is still classified correctly.
    if (this.#isAccountBlocked(response)) {
      throw codeError('account_blocked', `${this.siteId}: account flagged as blocked`);
    }
    if (response.status === 429) throw codeError('rate_limited', `${this.siteId}: snapshot rate limited`);
    if (response.status >= 500) throw codeError('network_error', `${this.siteId}: snapshot HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      // session_expired = retriable (relogin); account_blocked = terminal.
      // The session_expired path is wired to NotificationService at the service
      // level (Sniper1/2/3) — adapter only classifies.
      throw codeError('session_expired', `${this.siteId}: snapshot auth failed`);
    }
    if (detectCaptcha(response, this.config.businessRules?.captchaFlavor ?? 'none')) {
      throw codeError('captcha_encountered', `${this.siteId}: captcha at snapshot`);
    }
    const text = response.bodyText ?? '';
    const p = this.config.parsers ?? {};
    const snapshot = {
      itemId,
      fetchedAt: new Date(),
      serverTime: parseByRule(response, { type: 'response-date' }) ?? new Date(),
      currentPriceCents: parseByRule(text, p.currentPriceCents),
      minIncrementCents: this.#resolveMinIncrement(text, p.minIncrementCents),
      endsAt: parseByRule(text, p.endsAt),
      highBidderIsMe: Boolean(parseByRule(text, p.highBidderIsMe)),
      bidCount: parseByRule(text, p.bidCount) ?? 0
    };
    if (this.config.businessRules?.keepRawHtml) snapshot.rawHtml = text;
    return snapshot;
  }

  async placeBid(itemId, amountCents, ctx = {}) {
    if (!ctx.liveTransactionAllowed) {
      throw codeError('user_cancelled', `${this.siteId}: live bid blocked by transaction guard`);
    }
    if (this.config.hooks?.preBid) await this.config.hooks.preBid(ctx, this.config);
    const bid = this.config.bid;
    if (!bid) throw codeError('flow_outdated', `${this.siteId}: bid config missing`);
    const egress = ensureEgress(ctx, this.config, this.siteId, 'placeBid');
    const url = renderTemplate(this.config.urls.bid, { itemId, ...(ctx.input ?? {}) });
    const variables = {
      itemId,
      amountCents,
      amountDollars: (amountCents / 100).toFixed(2),
      ...(ctx.input ?? {})
    };
    const headersFromCsrf = await csrfHeaders(bid.csrf, ctx);
    const renderedBody = bid.bodyTemplate ? renderBody(bid.bodyTemplate, variables) : undefined;
    const body = bid.contentType?.includes('application/json') && renderedBody && typeof renderedBody === 'object'
      ? JSON.stringify(renderedBody)
      : (typeof renderedBody === 'string' ? renderedBody : (renderedBody ? new URLSearchParams(renderedBody).toString() : undefined));
    const response = await egress.fetch({
      method: bid.method ?? 'POST',
      url,
      headers: {
        'content-type': bid.contentType ?? 'application/json',
        ...(ctx.headers ?? {}),
        ...headersFromCsrf
      },
      body,
      timeoutMs: bid.timeoutMs
    });
    const expiredStatuses = bid.sessionExpiredStatuses ?? [401, 403];
    const serverTime = new Date(response.headers?.date ?? Date.now());
    if (this.#isAccountBlocked(response)) {
      return { ok: false, reason: 'account_blocked', retriable: false, serverTime };
    }
    if (expiredStatuses.includes(response.status)) {
      return { ok: false, reason: 'session_expired', retriable: true, serverTime };
    }
    if (response.status === 429) return { ok: false, reason: 'rate_limited', retriable: true, serverTime };
    if (response.status >= 500) return { ok: false, reason: 'network_error', retriable: true, serverTime };
    const text = response.bodyText ?? '';
    const success = bid.successRegex
      ? toRegex(bid.successRegex).test(text)
      : response.status >= 200 && response.status < 400;
    if (!success) {
      const tooLow = bid.amountTooLowRegex && toRegex(bid.amountTooLowRegex).test(text);
      const declineCode = !tooLow ? this.#detectDeclineReason(text, bid) : null;
      return {
        ok: false,
        reason: declineCode ?? (tooLow ? 'bid_amount_too_low' : 'network_error'),
        retriable: !tooLow && !declineCode,
        serverTime
      };
    }
    const result = {
      ok: true,
      newPriceCents: parseByRule(text, this.config.parsers?.currentPriceCents) ?? amountCents,
      highBidderIsMe: Boolean(parseByRule(text, this.config.parsers?.highBidderIsMe)) || true,
      serverTime
    };
    if (this.config.hooks?.postBid) {
      const hooked = await this.config.hooks.postBid(ctx, response, result);
      return hooked ?? result;
    }
    return result;
  }

  async getServerTimeOffsetMs(ctx = {}) {
    return computeServerTimeOffsetMs(this.config.businessRules?.serverTimeSource, ctx, this.config);
  }

  payDeadlineFromOutcome(_outcome = {}, opts = {}) {
    return computePayDeadline(this.config.businessRules?.paymentDeadlineDays ?? 7, { now: opts.now });
  }

  payUrlFor(itemId) {
    return renderTemplate(this.config.urls.payPage, { itemId });
  }

  async fetchPaymentStatus(itemId, ctx = {}) {
    if (!this.config.urls.paymentStatus) return 'unknown';
    const egress = ctx.egress ? applyMiddleware(ctx.egress, this.config) : null;
    if (!egress) return 'unknown';
    const url = renderTemplate(this.config.urls.paymentStatus, { itemId });
    const response = await egress.fetch({ method: 'GET', url, headers: ctx.headers ?? {} });
    const text = response.bodyText ?? '';
    if (this.config.parsers?.paymentPaid && toRegex(this.config.parsers.paymentPaid.pattern ?? this.config.parsers.paymentPaid).test(text)) return 'paid';
    if (this.config.parsers?.paymentOverdue && toRegex(this.config.parsers.paymentOverdue.pattern ?? this.config.parsers.paymentOverdue).test(text)) return 'overdue';
    if (response.status >= 200 && response.status < 400) return 'unpaid';
    return 'unknown';
  }

  subscribeUpdates(_itemId, _onUpdate) {
    return () => {};
  }

  #isAccountBlocked(response) {
    const re = this.config.bid?.accountBlockedRegex ?? this.config.businessRules?.accountBlockedRegex;
    if (!re) return false;
    return toRegex(re).test(response?.bodyText ?? '');
  }

  #detectDeclineReason(text, bid) {
    const reasons = bid?.declineReasons ?? [];
    for (const entry of reasons) {
      if (entry?.match && toRegex(entry.match).test(text)) return entry.code;
    }
    return null;
  }

  #resolveMinIncrement(text, ruleOrTable) {
    if (ruleOrTable) {
      const value = parseByRule(text, ruleOrTable);
      if (Number.isFinite(value) && value > 0) return value;
    }
    if (this.config.businessRules?.bidIncrementTable) {
      const current = parseByRule(text, this.config.parsers?.currentPriceCents);
      if (Number.isFinite(current)) {
        const inc = lookupIncrement(this.config.businessRules.bidIncrementTable, current);
        if (Number.isFinite(inc)) return inc;
      }
    }
    return undefined;
  }
}

function ensureEgress(ctx, siteConfig, siteId, where) {
  if (!ctx.egress) {
    throw codeError('internal_error', `${siteId}: ctx.egress required for ${where}`);
  }
  return applyMiddleware(ctx.egress, siteConfig);
}

function toRegex(value) {
  if (value instanceof RegExp) return value;
  return new RegExp(value);
}

function codeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
