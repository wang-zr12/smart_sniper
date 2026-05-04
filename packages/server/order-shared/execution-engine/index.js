import { isErrorCode, ERROR_META } from '../../../core/domain-types/index.js';
import { validateFlow, executePhase, interpolate } from '../flow-orchestration/index.js';
import { applyMiddleware } from '../../../adapters/_base/_common/middleware-egress.js';

// Standard 3DS / ACS challenge fingerprints across major issuers (illustrative).
const THREE_DS_HOST_PATTERNS = [
  /\bacs[\w-]*\./i,                // *.acs.bank.com
  /3dsecure|3ds-?challenge/i,
  /\bcardinalcommerce\./i,
  /\bgpayments\./i
];
const THREE_DS_BODY_FIELDS = ['acsUrl', 'PaReq', 'paReq', 'threeDSServerTransID', 'creq'];

const GENERIC_DECLINE_MAP = [
  { match: /insufficient\s+funds|nsf/i,                                           code: 'insufficient_funds' },
  { match: /(?:lost|stolen|expired)\s+card|card\s+(?:lost|stolen|expired)/i,       code: 'payment_declined_hard' },
  { match: /(?:card\s+)?declined|refused|do\s+not\s+honor/i,                       code: 'payment_declined' }
];

export class HttpExecutionEngine {
  constructor({ egress, logger, clock = () => new Date(), siteConfig } = {}) {
    if (!egress) throw new TypeError('egress is required');
    // When the calling service knows which site this run targets, pass siteConfig
    // so flow steps share the same MiddlewareEgress (rate-limit, header
    // consistency, captcha detect, backoff classify) the adapter would apply.
    this.egress = siteConfig ? applyMiddleware(egress, siteConfig) : egress;
    this.logger = logger;
    this.clock = clock;
  }

  async runStep(step, context = {}) {
    const retry = step.retry ?? { max: 0, backoff_ms: 0 };
    const max = retry.max ?? 0;
    const baseMs = retry.backoff_ms ?? 0;
    const strategy = retry.strategy ?? 'exponential';
    const cap = retry.max_backoff_ms ?? 30000;
    let attempt = 0;
    for (;;) {
      try {
        return await this.#runOnce(step, context);
      } catch (error) {
        // Don't retry terminal / manual-recovery errors — they won't get better.
        const meta = ERROR_META?.[error.code] ?? null;
        if (meta && meta.recovery !== 'retry') throw error;
        if (attempt >= max) throw error;
        attempt += 1;
        await sleep(computeBackoff(strategy, baseMs, attempt, cap));
      }
    }
  }

  async #runOnce(step, context) {
    const state = context.executionState ?? createExecutionState();
    context.executionState = state;

    if (step.when && !evaluateWhen(step.when, context)) {
      return { ok: true, skipped: true };
    }

    if (step.action === 'wait') {
      await sleep(step.duration_ms ?? step.wait_for?.timeout_ms ?? 0);
      return { ok: true };
    }
    if (step.action === 'checkpoint') {
      state.checkpoints.push({ id: step.id, at: this.clock() });
      return { ok: true };
    }
    if (step.action === 'humanize') return { ok: true };
    if (step.action === 'abort') throw codeError(normalizeErrorCode(step.reason), step.reason ?? 'Flow aborted');
    if (['input', 'select'].includes(step.action)) {
      state.inputs[step.selector] = interpolate(step.value, context);
      return { ok: true };
    }
    if (step.action === 'navigate') {
      const request = buildRequest(step, context, { method: step.method ?? 'GET', url: step.url });
      return this.#request(step, request, context);
    }
    if (step.action === 'navigate_with_state') {
      const token = context.captured?.[step.use] ?? state.captured?.[step.use];
      if (!token) throw codeError('acquire_expired', `Missing state token: ${step.use}`);
      const raw = typeof token === 'string' ? token : token.raw;
      const url = step.url ? interpolate(step.url, { ...context, captured: { ...context.captured, [step.use]: raw } }) : raw;
      if (!/^https?:\/\//i.test(url)) {
        state.currentReservationToken = token;
        return { ok: true, value: token };
      }
      return this.#request(step, buildRequest(step, context, { method: step.method ?? 'GET', url }), context);
    }
    if (step.action === 'tap') {
      if (!step.url && !step.request) {
        throw codeError('flow_outdated', `HTTP engine cannot tap selector without a request mapping: ${step.id}`);
      }
      const request = buildRequest(step, context, { method: step.method ?? step.request?.method ?? 'POST', url: step.url ?? step.request?.url });
      return this.#request(step, request, context);
    }
    if (step.action === 'assert') {
      assertLastResponse(step, state);
      return { ok: true };
    }
    if (step.action === 'capture') {
      const value = captureValue(step.capture_field, state);
      if (step.capture_as) {
        const stored = toReservationToken(value, step.capture_field);
        state.captured[step.capture_as] = stored;
        context.captured[step.capture_as] = stored;
        return { ok: true, value: stored };
      }
      return { ok: true, value };
    }
    if (step.capture_as) {
      const value = captureValue(step.capture_field, state);
      const stored = toReservationToken(value, step.capture_field);
      state.captured[step.capture_as] = stored;
      context.captured[step.capture_as] = stored;
      return { ok: true, value: stored };
    }
    throw codeError('flow_validation_failed', `Unsupported flow action: ${step.action}`);
  }

  async #request(step, request, context) {
    if (!request.url) throw codeError('flow_validation_failed', `Step ${step.id} is missing url`);
    if (context.dryRunMode && isMutatingRequest(request)) {
      throw codeError('user_cancelled', `Dry run blocked mutating request in step ${step.id}`);
    }
    const response = await this.egress.fetch(request);
    const state = context.executionState;
    state.lastRequest = request;
    state.lastResponse = response;
    state.currentUrl = response.url ?? request.url;
    // 3DS detection runs before status mapping. A 200 with an ACS form or a
    // 30x redirect to issuer.com is the typical pattern. Only meaningful in
    // settle phase — surface as payment_3ds_required so the caller can freeze
    // the PaymentChannel + push the user to confirm on their phone.
    if (context.phase === 'settle' && detect3dsChallenge(response)) {
      throw codeError('payment_3ds_required', `Step ${step.id}: bank requires 3DS / MFA`);
    }
    if (response.status === 429) throw codeError('rate_limited', `Rate limited at step ${step.id}`);
    if (response.status >= 500) throw codeError('network_error', `Server error at step ${step.id}`);
    if (response.status >= 400) {
      // Parse decline body for granular reason; site adapter overrides win.
      const declineCode = context.phase === 'settle'
        ? matchDeclineReason(response.bodyText ?? '', context.siteDeclineReasons)
        : null;
      const fallback = context.phase === 'settle' ? 'payment_failed' : 'acquire_failed';
      throw codeError(declineCode ?? fallback, `HTTP ${response.status} at step ${step.id}`);
    }
    if (step.capture_as) {
      const value = captureValue(step.capture_field, state);
      const stored = toReservationToken(value, step.capture_field);
      state.captured[step.capture_as] = stored;
      context.captured[step.capture_as] = stored;
      return { ok: true, response, value: stored };
    }
    return { ok: true, response };
  }
}

export class BrowserExecutionEngine {
  constructor({ browserPool, logger }) {
    this.browserPool = browserPool;
    this.logger = logger;
  }

  async runStep(step, context = {}) {
    const browserContext = context.browserContext ?? await this.browserPool?.acquire?.();
    if (!browserContext?.runFlowStep) {
      throw codeError('flow_outdated', 'Browser execution requires a browser context with runFlowStep(step, ctx)');
    }
    return browserContext.runFlowStep(step, context);
  }
}

export class MobileExecutionEngine {
  constructor({ mobileBridge, session }) {
    this.mobileBridge = mobileBridge;
    this.session = session;
  }

  async runStep(step, context = {}) {
    const session = this.session ?? context.mobileSession;
    if (!session?.runFlowStep) throw codeError('flow_outdated', 'Mobile execution requires an Android session');
    return session.runFlowStep(step, context);
  }
}

export async function runAcquirePhase({ taskId, flow, adapter, engine, intent, snapshot, context = {} }) {
  const validation = validateFlow(flow, adapter.capabilities);
  if (!validation.ok) return { ok: false, reason: validation.errors.includes('flow_version_unsupported') ? 'flow_version_unsupported' : 'flow_validation_failed', retriable: false };
  try {
    const captured = await executePhase(flow, 'acquire', engine, context);
    const token = captured.reservation_token;
    if (!token?.raw && typeof token !== 'string') return { ok: false, reason: 'acquire_failed', retriable: true };
    return {
      ok: true,
      reservationToken: typeof token === 'string' ? { raw: token, source: 'url_param' } : token,
      reservationExpiresAt: new Date(Date.now() + adapter.capabilities.reservationTypicalTtlMs),
      resolvedVariant: context.resolvedVariant ?? resolveVariantFromSnapshot(snapshot, intent)
    };
  } catch (error) {
    return {
      ok: false,
      reason: normalizeErrorCode(error.code ?? 'acquire_failed'),
      retriable: ['network_error', 'rate_limited', 'flow_step_timeout', 'acquire_failed'].includes(error.code)
    };
  }
}

export async function runSettlePhase({ taskId, flow, adapter, engine, paymentTask, context = {} }) {
  const validation = validateFlow(flow, adapter.capabilities);
  if (!validation.ok) return { ok: false, reason: validation.errors.includes('flow_version_unsupported') ? 'flow_version_unsupported' : 'flow_validation_failed', retriable: false };
  try {
    const captured = await executePhase(flow, 'settle', engine, {
      ...context,
      captured: {
        ...(context.captured ?? {}),
        reservation_token: paymentTask.reservationToken
      }
    });
    return {
      ok: true,
      orderConfirmation: {
        orderId: String(captured.order_confirmation?.raw ?? captured.order_id ?? `order:${taskId}:${Date.now()}`),
        totalChargedCents: paymentTask.totalCents ?? 0,
        confirmedAt: new Date(),
        rawReceiptUrl: captured.receipt_url?.raw ?? captured.receipt_url
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: normalizeErrorCode(error.code ?? 'payment_failed'),
      retriable: ['network_error', 'rate_limited', 'flow_step_timeout', 'payment_failed'].includes(error.code)
    };
  }
}

function buildRequest(step, context, defaults) {
  const source = { ...(step.request ?? {}), ...defaults };
  const headers = {};
  for (const [key, value] of Object.entries(source.headers ?? {})) headers[key] = interpolate(String(value), context);
  return {
    method: source.method ?? 'GET',
    url: interpolate(source.url, context),
    headers,
    body: renderBody(source.body ?? step.body, context),
    timeoutMs: step.timeout_ms
  };
}

function renderBody(body, context) {
  if (body == null) return undefined;
  if (typeof body === 'string') return interpolate(body, context);
  const rendered = {};
  for (const [key, value] of Object.entries(body)) rendered[key] = interpolate(String(value), context);
  return JSON.stringify(rendered);
}

function assertLastResponse(step, state) {
  const response = state.lastResponse ?? {};
  const body = response.bodyText ?? '';
  const status = response.status ?? 0;
  if (step.exists && !body) {
    throw codeError('flow_outdated', `Assert ${step.id}: response body is empty`);
  }
  if (Number.isFinite(step.status_code) && status !== step.status_code) {
    throw codeError('flow_outdated', `Assert ${step.id}: expected status ${step.status_code}, got ${status}`);
  }
  if (Array.isArray(step.status_in) && !step.status_in.includes(status)) {
    throw codeError('flow_outdated', `Assert ${step.id}: status ${status} not in [${step.status_in.join(',')}]`);
  }
  if (step.text_match && !new RegExp(step.text_match).test(body)) {
    throw codeError('flow_outdated', `Assert ${step.id}: text_match did not match`);
  }
  if (step.text_not_match && new RegExp(step.text_not_match).test(body)) {
    throw codeError('flow_outdated', `Assert ${step.id}: text_not_match matched (forbidden)`);
  }
  if (step.json_path) {
    const data = safeJson(body);
    const value = jsonPathGet(data, step.json_path);
    if (step.equals !== undefined && value !== step.equals) {
      throw codeError('flow_outdated', `Assert ${step.id}: json_path ${step.json_path} expected ${JSON.stringify(step.equals)}, got ${JSON.stringify(value)}`);
    }
    if (step.exists_path === true && value === undefined) {
      throw codeError('flow_outdated', `Assert ${step.id}: json_path ${step.json_path} not found`);
    }
  }
  if (step.selector) {
    // CSS / XPath selector assertions are only valid against a real DOM, which
    // the HTTP engine does not have. Fail loudly so flows requiring DOM checks
    // are routed to BrowserExecutionEngine instead of silently passing on a
    // substring match against raw HTML.
    throw codeError('flow_outdated', `Assert ${step.id}: selector assertions are not supported by HttpExecutionEngine; use the browser engine`);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function jsonPathGet(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((acc, key) => acc?.[key], obj);
}

function captureValue(captureField = {}, state) {
  const response = state.lastResponse ?? {};
  const currentUrl = state.currentUrl ?? state.lastRequest?.url;
  if (captureField.type === 'url_param') {
    const url = new URL(currentUrl);
    const value = url.searchParams.get(captureField.name);
    if (!value) throw codeError('acquire_failed', `Missing URL param capture: ${captureField.name}`);
    return value;
  }
  if (captureField.type === 'response_header') {
    const value = response.headers?.[captureField.name.toLowerCase()] ?? response.headers?.[captureField.name];
    if (!value) throw codeError('acquire_failed', `Missing response header capture: ${captureField.name}`);
    return value;
  }
  if (captureField.type === 'cookie') {
    const cookieHeader = response.headers?.['set-cookie'] ?? response.headers?.['Set-Cookie'] ?? '';
    const match = String(cookieHeader).match(new RegExp(`${escapeRegex(captureField.name)}=([^;]+)`));
    if (!match) throw codeError('acquire_failed', `Missing cookie capture: ${captureField.name}`);
    return match[1];
  }
  const body = response.bodyText ?? '';
  if (captureField.regex) {
    const match = body.match(new RegExp(captureField.regex));
    if (!match) throw codeError('flow_outdated', 'Capture regex did not match');
    return match[1] ?? match[0];
  }
  if (captureField.type === 'dom_text') return body;
  throw codeError('flow_validation_failed', `Unsupported capture field: ${captureField.type}`);
}

function toReservationToken(value, captureField = {}) {
  if (captureField.type && ['url_param', 'cookie', 'dom_attribute', 'response_header'].includes(captureField.type)) {
    return { raw: String(value), source: captureField.type };
  }
  return value;
}

function resolveVariantFromSnapshot(snapshot, intent) {
  if (!snapshot?.variants?.length || !intent?.product?.requiredVariants) return undefined;
  const required = intent.product.requiredVariants;
  const exact = snapshot.variants.find((variant) => variant.inStock && Object.entries(required).every(([key, value]) => variant.attributes[key] === value));
  if (exact) return { variant: exact, matchedFromList: 'required' };
  for (const [fallbackIndex, fallback] of (intent.product.fallbackVariants ?? []).entries()) {
    const variant = snapshot.variants.find((candidate) => candidate.inStock && Object.entries(fallback).every(([key, value]) => candidate.attributes[key] === value));
    if (variant) return { variant, matchedFromList: 'fallback', fallbackIndex };
  }
  return undefined;
}

function createExecutionState() {
  return { captured: {}, inputs: {}, checkpoints: [] };
}

function evaluateWhen(expression, context) {
  if (expression === 'true') return true;
  if (expression === 'false') return false;
  const match = String(expression).match(/^\$\{(input|captured|env)\.([a-zA-Z0-9_]+)\}$/);
  if (!match) return true;
  return Boolean(context[match[1]]?.[match[2]]);
}

function isMutatingRequest(request) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(request.method ?? 'GET').toUpperCase());
}

function normalizeErrorCode(value) {
  return isErrorCode(value) ? value : 'internal_error';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Compute next retry delay. Default strategy is exponential with full jitter:
 *   delay = random(0, min(cap, base * 2^attempt))
 * (AWS-style "full jitter" reduces thundering herd vs. fixed exponential.)
 */
export function computeBackoff(strategy, baseMs, attempt, capMs = 30000) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (strategy === 'fixed') return Math.min(baseMs, capMs);
  if (strategy === 'linear') return Math.min(baseMs * attempt, capMs);
  // exponential with full jitter (default)
  const expo = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * (expo + 1));
}

/**
 * Detect 3DS / ACS challenge in a response. Returns true on either:
 *  - 30x redirect URL matching a known ACS host pattern
 *  - 200-OK body containing typical ACS form fields (PaReq / acsUrl / creq)
 *  - non-empty `response.threeDsRedirectUrl` (some adapters surface explicitly)
 */
export function detect3dsChallenge(response) {
  if (!response) return false;
  if (response.threeDsRedirectUrl) return true;
  const url = response.url ?? '';
  if (url && THREE_DS_HOST_PATTERNS.some((re) => re.test(url))) return true;
  const location = response.headers?.location;
  if (location && THREE_DS_HOST_PATTERNS.some((re) => re.test(String(location)))) return true;
  const body = response.bodyText ?? '';
  if (!body) return false;
  return THREE_DS_BODY_FIELDS.some((field) => body.includes(field));
}

function matchDeclineReason(text, siteRules) {
  // Site-specific rules take priority (caller passes adapter.config.bid.declineReasons).
  const rules = Array.isArray(siteRules) && siteRules.length ? siteRules : GENERIC_DECLINE_MAP;
  for (const entry of rules) {
    if (entry?.match) {
      const re = entry.match instanceof RegExp ? entry.match : new RegExp(entry.match, 'i');
      if (re.test(text)) return entry.code;
    }
  }
  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = normalizeErrorCode(code);
  return error;
}
