import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { makeFlowRef, parseFlowRef, ErrorCodes, ERROR_META, userMessageFor } from '../packages/core/domain-types/index.js';
import { LiveTransactionGuard, LIVE_CONFIRMATION_PHRASE } from '../packages/core/developer-mode/index.js';
import { InMemoryBus, topicMatches } from '../packages/core/event-bus/index.js';
import { InMemoryCredentialStore } from '../packages/core/credential-store/index.js';
import { BudgetEngine } from '../packages/core/budget-engine/index.js';
import { resolveDeadlineTier, jitterInterval } from '../packages/core/scheduler/index.js';
import { transition, SimpleMachine, terminalStates } from '../packages/core/state-machine/index.js';
import { PaymentChannel } from '../packages/server/order-shared/payment-channel/index.js';
import { validateFlow } from '../packages/server/order-shared/flow-orchestration/index.js';
import { HttpExecutionEngine, runAcquirePhase, runSettlePhase } from '../packages/server/order-shared/execution-engine/index.js';
import { createDefaultAdapterRegistry } from '../packages/adapters/registry.js';
import { FixtureOrderingAdapter } from '../packages/adapters/_template/index.js';
import { Sniper1Service, shouldBumpOnTie, shouldBumpOnOutbid } from '../packages/server/sniper1-service/index.js';
import { resolveVariant, allocateQuantity, checkPriceGuard, Sniper2Service } from '../packages/server/sniper2-service/index.js';
import { Sniper3Service, restockToScheduledOrderIntent } from '../packages/server/sniper3-service/index.js';
import { createApp, createServer } from '../packages/server/api/server.js';
import { NotificationService, NOTIFY_CATEGORIES } from '../packages/core/notification-service/index.js';
import { BaseHtmlAuctionAdapter } from '../packages/adapters/_base/base-html-auction.js';
import { validateAuctionSiteConfig } from '../packages/adapters/_base/site-config-schema.js';
import { renderTemplate, renderBody } from '../packages/adapters/_base/_common/template.js';
import { parseByRule } from '../packages/adapters/_base/_common/parsers.js';
import { lookupIncrement, INCREMENT_TABLES } from '../packages/adapters/_base/_common/increment-tables.js';
import { applyMiddleware, MiddlewareEgress } from '../packages/adapters/_base/_common/middleware-egress.js';
import { computeBackoff, detect3dsChallenge } from '../packages/server/order-shared/execution-engine/index.js';
import { withRequestContext } from '../packages/core/tenant-context/index.js';
import { LockProvider, NoOpLockProvider, lockKeyFor } from '../packages/core/account-lock/index.js';
import { detectCaptcha } from '../packages/adapters/_base/_common/captcha-detection.js';
import { EBAY_CONFIG, createEbayAuctionAdapter } from '../packages/adapters/sites/ebay.js';
import { SHOPGOODWILL_CONFIG, createShopgoodwillAuctionAdapter } from '../packages/adapters/sites/shopgoodwill.js';
import { TGTG_CONFIG, createTooGoodToGoAdapter } from '../packages/adapters/sites/too-good-to-go.js';
import { validateMobileFlowSiteConfig } from '../packages/adapters/_base/site-config-schema.js';
import { BaseMobileFlowOrderingAdapter } from '../packages/adapters/_base/base-mobile-flow.js';

test('domain flow refs round-trip and error table is complete', () => {
  const ref = makeFlowRef('ebay.buy-product', 2);
  assert.deepEqual(parseFlowRef(ref), { flowId: 'ebay.buy-product', version: 2 });
  assert.ok(ErrorCodes.includes('flow_validation_failed'));
});

test('event bus supports wildcard topics and replay', () => {
  const bus = new InMemoryBus();
  const seen = [];
  const unsubscribe = bus.subscribe('sniper1:item:*', (event) => seen.push(event.topic));
  bus.emit({ topic: 'sniper1:item:state_changed', payload: { ok: true }, tenantId: 'local-user' });
  unsubscribe();
  bus.emit({ topic: 'sniper2:task:state_changed', payload: {}, tenantId: 'local-user' });
  assert.deepEqual(seen, ['sniper1:item:state_changed']);
  assert.equal(bus.replay({ topic: '*' }).length, 2);
  assert.equal(topicMatches('sniper1:*:state_changed', 'sniper1:item:state_changed'), true);
});

test('budget engine keeps isolated append-only ledger math', () => {
  const budget = new BudgetEngine('sniper1');
  budget.setTotalBudget(5000);
  budget.commit('item:1', 1500);
  budget.spend('item:1', 1000);
  budget.release('item:1', 500);
  assert.equal(budget.snapshot().totalCents, 5000);
  assert.equal(budget.snapshot().spentCents, 1000);
  assert.equal(budget.snapshot().availableCents, 4000);
  assert.equal(budget.ledger().length, 4);
  assert.equal(budget.verifyHashChain(), true);
  assert.equal(budget.ledger()[0].prevHash, null);
  assert.equal(typeof budget.ledger()[1].prevHash, 'string');
});

test('state machine rejects invalid transitions without mutating state', () => {
  assert.equal(transition('sniper1Item', 'draft', 'paymentStart'), 'draft');
  const events = [];
  const machine = new SimpleMachine('sniper1Item', 'draft', { itemId: 'item:1' }, (event) => events.push(event));
  assert.equal(machine.send('paymentStart').state, 'draft');
  assert.equal(events.length, 0);
});

test('budget engines stay isolated across sniper scopes', () => {
  const sniper1 = new BudgetEngine('sniper1');
  const sniper2 = new BudgetEngine('sniper2');
  const sniper3 = new BudgetEngine('sniper3');
  sniper1.setTotalBudget(1000);
  sniper2.setTotalBudget(2000);
  sniper3.setTotalBudget(3000);
  sniper1.commit('item:1', 500);
  assert.equal(sniper1.snapshot().availableCents, 500);
  assert.equal(sniper2.snapshot().availableCents, 2000);
  assert.equal(sniper3.snapshot().availableCents, 3000);
});

test('tenant-scoped stores filter credential metadata by tenant_id', async () => {
  const store = new InMemoryCredentialStore();
  await store.store('tenant-a', 'cred:a', { kind: 'cookie', siteId: 'site', cookies: [] }, { siteId: 'site', label: 'A' });
  await store.store('tenant-b', 'cred:b', { kind: 'cookie', siteId: 'site', cookies: [] }, { siteId: 'site', label: 'B' });
  assert.deepEqual((await store.list('tenant-a')).map((row) => row.ref), ['cred:a']);
  assert.deepEqual((await store.list('tenant-b')).map((row) => row.ref), ['cred:b']);
});

test('scheduler helpers resolve tiers and jitter avoids exact whole seconds', () => {
  assert.equal(resolveDeadlineTier(60000), 'hot');
  const value = jitterInterval(5000, 5000, { rng: () => 0.5 });
  assert.notEqual(value % 1000, 0);
});

test('payment channel rebalances by earliest reservation deadline', () => {
  const now = Date.UTC(2026, 4, 4, 12, 0, 0);
  const channel = new PaymentChannel({
    id: 'channel:visa',
    methodRef: 'cred:visa',
    minIntervalMs: 30000,
    typicalDurationMs: 10000,
    clock: () => now
  });
  channel.enqueue(task('late', now + 600000));
  channel.enqueue(task('early', now + 120000));
  const state = channel.inspect();
  assert.equal(state.pending[0].taskId, 'early');
  assert.equal(state.pending[0].risk, 'tight');
});

test('flow validator enforces acquire and settle constraints', () => {
  const flow = {
    flow_id: 'ebay.buy-product',
    version: 2,
    target: 'ebay',
    platform: 'web',
    variables: [{ name: 'size', type: 'string', required: true }],
    phases: {
      acquire: [
        { id: 'select_variant', action: 'tap', selector: 'css=.variant' },
        { id: 'capture_token', action: 'capture', selector: 'css=form', capture_as: 'reservation_token' }
      ],
      settle: [
        { id: 'validate_reservation', action: 'navigate_with_state', use: 'reservation_token' },
        { id: 'confirm_pay', action: 'tap', selector: 'role=button[name=Pay]' }
      ]
    }
  };
  assert.deepEqual(validateFlow(flow, { supportedFlowVersions: [2] }), { ok: true, errors: [] });
  flow.platform = `mobile-${'ios'}`;
  assert.equal(validateFlow(flow, { supportedFlowVersions: [2] }).ok, false);
});

test('sniper1 service can add fixture auction and compute bump decisions', async () => {
  const registry = createDefaultAdapterRegistry();
  const service = new Sniper1Service({ adapterRegistry: registry });
  const itemId = await service.addWatchedItem('ebay', 'https://www.ebay.test/itm/1', { budget: 3000 });
  assert.equal(service.listWatchedItems()[0].itemId, itemId);
  const context = {
    budgetCents: 3000,
    bumpUsage: { tieUsed: false, outbidUsed: false },
    hasBeenWinningOnce: true,
    bumpStrategies: { onOutbid: { enabled: true, rangeUsd: [5, 5], maxTimes: 1 } },
    bidHistory: [{ amountCents: 1200 }]
  };
  assert.equal(shouldBumpOnTie(context, { highBidderIsMe: false, currentPriceCents: 1200, minIncrementCents: 100 }).amountCents, 1300);
  assert.equal(shouldBumpOnOutbid(context, { highBidderIsMe: false, currentPriceCents: 1200 }, () => 0).amountCents, 1700);
});

test('sniper2 variant and quantity guards are deterministic', () => {
  const snapshot = {
    variants: [
      { attributes: { size: '42', color: 'black' }, unitPriceCents: 12000, inStock: false },
      { attributes: { size: '43', color: 'black' }, unitPriceCents: 12500, inStock: true }
    ]
  };
  const intent = {
    product: {
      requiredVariants: { size: '42', color: 'black' },
      fallbackVariants: [{ size: '43', color: 'black' }]
    },
    quantity: { type: 'range', min: 1, max: 3, preferred: 2 },
    priceGuard: { maxUnitPrice: 13000, abortOnExceed: true }
  };
  assert.equal(resolveVariant(snapshot, intent).matchedFromList, 'fallback');
  assert.deepEqual(allocateQuantity(intent, 1), { ok: true, quantity: 1 });
  assert.deepEqual(checkPriceGuard(snapshot, intent), { pass: true });
});

test('live transaction guard requires env and explicit request confirmation', () => {
  const guard = new LiveTransactionGuard({
    env: {
      SMART_SNIPER_DEVELOPER_MODE: '1',
      SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS: '1'
    }
  });
  assert.equal(guard.evaluate({ developerMode: true, executeLive: true, confirmationPhrase: LIVE_CONFIRMATION_PHRASE }).liveAllowed, true);
  assert.equal(guard.evaluate({ developerMode: true, executeLive: true, confirmationPhrase: 'NOPE' }).dryRunMode, true);
  assert.throws(() => guard.assertAllowed({ developerMode: true, executeLive: true, confirmationPhrase: 'NOPE' }), /Live transaction blocked/);
});

test('http execution engine blocks mutating requests in dry-run and can run acquire/settle live with egress', async () => {
  const calls = [];
  const egress = {
    async fetch(request) {
      calls.push(request);
      if (request.url.includes('reserve')) {
        return { status: 200, headers: { date: new Date().toUTCString() }, url: 'https://shop.test/checkout?order_token=tok-123', bodyText: 'reserved' };
      }
      return { status: 200, headers: { 'x-order-id': 'order-123' }, url: request.url, bodyText: 'paid' };
    }
  };
  const flow = {
    flow_id: 'fixture.buy-product',
    version: 2,
    target: 'fixture-shop',
    platform: 'web',
    phases: {
      acquire: [
        { id: 'reserve', action: 'navigate', url: 'https://shop.test/reserve' },
        { id: 'capture_token', action: 'capture', capture_as: 'reservation_token', capture_field: { type: 'url_param', name: 'order_token' } }
      ],
      settle: [
        { id: 'validate_reservation', action: 'navigate_with_state', use: 'reservation_token' },
        { id: 'confirm_pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' } },
        { id: 'capture_order', action: 'capture', capture_as: 'order_confirmation', capture_field: { type: 'response_header', name: 'x-order-id' } }
      ]
    }
  };
  const adapter = new FixtureOrderingAdapter({ siteId: 'fixture-shop' });
  const snapshot = await adapter.fetchProductSnapshot('https://shop.test/product/1');
  const intent = {
    product: { requiredVariants: { size: '42', color: 'black' } },
    flow: 'fixture.buy-product@2'
  };
  const engine = new HttpExecutionEngine({ egress });
  const acquire = await runAcquirePhase({ taskId: 'task:1', flow, adapter, engine, intent, snapshot, context: { captured: {}, dryRunMode: false } });
  assert.equal(acquire.ok, true);
  assert.equal(acquire.reservationToken.raw, 'tok-123');
  const settle = await runSettlePhase({
    taskId: 'task:1',
    flow,
    adapter,
    engine,
    paymentTask: { reservationToken: acquire.reservationToken, totalCents: 12000 },
    context: { captured: {}, dryRunMode: false }
  });
  assert.equal(settle.ok, true);
  assert.equal(settle.orderConfirmation.orderId, 'order-123');

  const dryRunEngine = new HttpExecutionEngine({ egress });
  await assert.rejects(
    () => dryRunEngine.runStep({ id: 'confirm_pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' } }, { captured: {}, dryRunMode: true, phase: 'settle' }),
    /Dry run blocked/
  );
  assert.equal(calls.length, 2);
});

test('main API rejects plaintext credentials before they enter storage', async () => {
  const app = createApp();
  const server = createServer(app);
  await listen(server);
  try {
    const response = await requestJson(server, 'POST', '/api/v1/credentials', {
      secret: { kind: 'password', username: 'u', password: 'p' }
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'vault_unavailable');
    assert.deepEqual(await app.credentialStore.list(app.tenantId), []);
  } finally {
    await closeServer(server);
  }
});

test('timestamps emitted by budget and event bus serialize as UTC', () => {
  const budget = new BudgetEngine('sniper1');
  budget.setTotalBudget(100);
  assert.match(budget.ledger()[0].createdAt.toISOString(), /Z$/);
  const bus = new InMemoryBus();
  const event = bus.emit({ topic: 'shared:audit:event', tenantId: 'local-user', payload: {} });
  assert.match(event.at.toISOString(), /Z$/);
});

test('notification service stores records, fans out via channels, and respects tenant filter', async () => {
  const bus = new InMemoryBus();
  const svc = new NotificationService({ eventBus: bus, tenantId: 'tenant-a' });
  const id = await svc.notify({
    scope: 'sniper1',
    category: 'auction_won',
    severity: 'urgent',
    payload: { itemId: 'item:1', siteId: 'ebay' },
    tenantId: 'tenant-a'
  });
  assert.ok(id.startsWith('notif:'));
  assert.equal(svc.list({ tenantId: 'tenant-a' }).length, 1);
  assert.equal(svc.list({ tenantId: 'tenant-b' }).length, 0);
  const created = bus.replay({ topic: 'shared:notification:created' });
  assert.equal(created.length, 1);
  assert.equal(created[0].payload.category, 'auction_won');
  // unknown category rejected
  await assert.rejects(() => svc.notify({ scope: 'sniper1', category: 'bogus', severity: 'info', tenantId: 'tenant-a' }));
  // every documented category is recognized
  assert.ok(NOTIFY_CATEGORIES.includes('auction_won'));
  assert.ok(NOTIFY_CATEGORIES.includes('payment_overdue'));
});

test('sniper1 win-flow transitions to pending_user_payment and emits auction_won notification', async () => {
  const bus = new InMemoryBus();
  const notificationService = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const registry = createDefaultAdapterRegistry();
  const service = new Sniper1Service({ adapterRegistry: registry, eventBus: bus, notificationService });
  const itemId = await service.addWatchedItem('ebay', 'https://www.ebay.test/itm/1', { budget: 5000 });
  // simulate the path bidding -> winning -> markWon
  service.items.get(itemId).machine.send('arm');
  service.items.get(itemId).machine.send('executeBid');
  service.items.get(itemId).machine.send('bidWinning', { hasBeenWinningOnce: true });
  const winOutcome = await service.markItemWon(itemId, { finalPriceCents: 4200 });
  assert.equal(service.items.get(itemId).machine.state, 'pending_user_payment');
  assert.equal(winOutcome.finalPriceCents, 4200);
  assert.ok(winOutcome.payDeadline instanceof Date);
  assert.ok(typeof winOutcome.payUrl === 'string' && winOutcome.payUrl.startsWith('https://'));
  assert.ok(winOutcome.payUrl.includes(itemId));
  const notifs = notificationService.list({ tenantId: 'local-user' });
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].category, 'auction_won');
  assert.equal(notifs[0].severity, 'urgent');
  assert.equal(notifs[0].payload.itemId, itemId);
  // user marks paid -> state is paid (terminal); spend recorded
  await service.markPaymentCompleted(itemId);
  assert.equal(service.items.get(itemId).machine.state, 'paid');
  assert.equal(terminalStates.has('paid'), true);
  assert.equal(service.budget.spentCents(itemId), 4200);
});

test('sniper1Item state machine includes pending_user_payment / paid / payment_overdue transitions', () => {
  assert.equal(transition('sniper1Item', 'won', 'promoteToPendingPayment'), 'pending_user_payment');
  assert.equal(transition('sniper1Item', 'pending_user_payment', 'userMarkPaid'), 'paid');
  assert.equal(transition('sniper1Item', 'pending_user_payment', 'paymentDeadlineHit'), 'payment_overdue');
  assert.equal(transition('sniper1Item', 'pending_user_payment', 'cancel'), 'cancelled');
  // `paid` and `payment_overdue` are terminal: no further transitions
  assert.equal(transition('sniper1Item', 'paid', 'userMarkPaid'), 'paid');
  assert.equal(transition('sniper1Item', 'payment_overdue', 'userMarkPaid'), 'payment_overdue');
  assert.equal(terminalStates.has('paid'), true);
  assert.equal(terminalStates.has('payment_overdue'), true);
  // `won` is no longer terminal — must promote
  assert.equal(terminalStates.has('won'), false);
});

test('http execution engine assert: status_code, regex, json_path; rejects css selectors', async () => {
  const calls = [];
  const egress = {
    async fetch(req) {
      calls.push(req);
      if (req.url.includes('/check')) {
        return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ status: 'ok', count: 3 }), url: req.url };
      }
      return { status: 200, headers: {}, bodyText: 'normal page', url: req.url };
    }
  };
  const engine = new HttpExecutionEngine({ egress });
  const ctx = { captured: {}, executionState: { captured: {}, inputs: {}, checkpoints: [] } };
  // navigate primes lastResponse
  await engine.runStep({ id: 'load', action: 'navigate', url: 'https://test/check' }, ctx);
  await engine.runStep({ id: 'a1', action: 'assert', status_code: 200 }, ctx);
  await assert.rejects(
    () => engine.runStep({ id: 'a2', action: 'assert', status_in: [201, 202] }, ctx),
    /status 200 not in/
  );
  await engine.runStep({ id: 'a3', action: 'assert', json_path: '$.status', equals: 'ok' }, ctx);
  await engine.runStep({ id: 'a4', action: 'assert', text_match: '"count":3' }, ctx);
  await assert.rejects(
    () => engine.runStep({ id: 'a5', action: 'assert', selector: 'css=.button' }, ctx),
    /selector assertions are not supported/
  );
});

test('site config schema rejects incomplete configs and accepts ebay/shopgoodwill', () => {
  assert.equal(validateAuctionSiteConfig(EBAY_CONFIG).ok, true);
  assert.equal(validateAuctionSiteConfig(SHOPGOODWILL_CONFIG).ok, true);
  const bad = validateAuctionSiteConfig({
    siteId: 'broken',
    family: 'html-auction',
    identifyHosts: ['broken.test'],
    urls: { snapshot: 'x' },                                 // missing bid + payPage
    parsers: {},                                             // missing currentPriceCents + endsAt
    businessRules: { paymentDeadlineDays: -1 },              // not positive
    capabilities: { siteId: 'broken', supportedFlowVersions: [] }  // no strategy
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('urls.bid')));
  assert.ok(bad.errors.some((e) => e.includes('urls.payPage')));
  assert.ok(bad.errors.some((e) => e.includes('currentPriceCents')));
  assert.ok(bad.errors.some((e) => e.includes('endsAt')));
  assert.ok(bad.errors.some((e) => e.includes('paymentDeadlineDays')));
  assert.ok(bad.errors.some((e) => e.includes('execution strategy')));
});

test('template rendering substitutes variables and rejects undefined keys', () => {
  assert.equal(renderTemplate('https://x/${id}', { id: 42 }), 'https://x/42');
  assert.throws(() => renderTemplate('${missing}', {}), /missing/);
  assert.deepEqual(renderBody({ a: '${id}', b: 'static' }, { id: '1' }), { a: '1', b: 'static' });
});

test('parsers handle regex / regex-presence / units / response-date', () => {
  const text = 'Current Price: $42.00 — 5 bids — auction ends';
  assert.equal(parseByRule(text, { type: 'regex', pattern: /\$([0-9.]+)/, units: 'dollars' }), 4200);
  assert.equal(parseByRule(text, { type: 'regex', pattern: /([0-9]+)\s+bids/, units: 'integer' }), 5);
  assert.equal(parseByRule(text, { type: 'regex-presence', pattern: /auction\s+ends/i }), true);
  assert.equal(parseByRule(text, { type: 'regex-presence', pattern: /not\s+present/i }), false);
  const stamp = '2026-05-04T12:00:00Z';
  const date = parseByRule({ headers: { date: stamp } }, { type: 'response-date' });
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString(), '2026-05-04T12:00:00.000Z');
});

test('increment table lookup picks the right tier per current price', () => {
  assert.equal(lookupIncrement('ebay_v1', 50), 5);
  assert.equal(lookupIncrement('ebay_v1', 250), 25);
  assert.equal(lookupIncrement('ebay_v1', 1500), 100);
  assert.equal(lookupIncrement('shopgoodwill_v2', 100), 50);
  assert.equal(lookupIncrement('shopgoodwill_v2', 5000), 500);
  assert.equal(lookupIncrement('unknown_table', 100), null);
  assert.ok(Object.keys(INCREMENT_TABLES).length >= 2);
});

test('MiddlewareEgress enforces same-origin spacing and tier-drop on 429', async () => {
  let calls = 0;
  const underlying = {
    async fetch(req) {
      calls += 1;
      if (calls === 2) return { status: 429, headers: {}, bodyText: 'rate limited', url: req.url };
      return { status: 200, headers: {}, bodyText: 'ok', url: req.url };
    }
  };
  let nowMs = 1_000_000;
  const wrapped = new MiddlewareEgress({
    underlying,
    siteId: 'shopgoodwill',
    minIntervalMs: 800,
    clock: () => nowMs
  });
  const r1 = await wrapped.fetch({ url: 'https://shopgoodwill.com/item/1' });
  assert.equal(r1.status, 200);
  // second call returns 429 → wrapper records backoff
  await wrapped.fetch({ url: 'https://shopgoodwill.com/item/2' });
  // third call should be blocked by backoff
  await assert.rejects(() => wrapped.fetch({ url: 'https://shopgoodwill.com/item/3' }), /backoff active/);
  // applyMiddleware is idempotent
  const inner = applyMiddleware(underlying, EBAY_CONFIG);
  const outer = applyMiddleware(inner, EBAY_CONFIG);
  assert.equal(inner, outer);
});

test('detectCaptcha distinguishes flavor vs none', () => {
  assert.equal(detectCaptcha({ bodyText: 'normal page' }, 'none'), false);
  assert.equal(detectCaptcha({ bodyText: 'cf-chl turnstile challenge' }, 'cloudflare-turnstile'), true);
  assert.equal(detectCaptcha({ bodyText: 'normal page' }, 'cloudflare-turnstile'), false);
  assert.equal(detectCaptcha({ bodyText: 'Please verify you are human.' }, 'cloudflare-turnstile'), true);
});

test('BaseHtmlAuctionAdapter parses snapshot and rejects bid without liveTransactionAllowed', async () => {
  const adapter = createEbayAuctionAdapter();
  assert.equal(adapter.siteId, 'ebay');
  assert.equal(adapter.identify('https://www.ebay.com/itm/12345'), true);
  assert.equal(adapter.identify('https://shopgoodwill.com/item/1'), false);

  const html = `
    <span data-end-time="2026-05-04T20:00:00Z">ends soon</span>
    Current Price: US $42.00
    minimum bid: US $1.00
    7 bids
    You are the high bidder
  `;
  const fakeEgress = {
    async fetch(req) {
      assert.match(req.url, /www\.ebay\.com\/itm\/abc/);
      return { status: 200, headers: { date: 'Mon, 04 May 2026 12:00:00 GMT' }, bodyText: html, url: req.url };
    }
  };
  const snapshot = await adapter.fetchSnapshot('abc', { egress: fakeEgress });
  assert.equal(snapshot.itemId, 'abc');
  assert.equal(snapshot.currentPriceCents, 4200);
  assert.equal(snapshot.minIncrementCents, 100);
  assert.equal(snapshot.bidCount, 7);
  assert.equal(snapshot.highBidderIsMe, true);
  assert.ok(snapshot.endsAt instanceof Date);

  // bid blocked without liveTransactionAllowed
  await assert.rejects(
    () => adapter.placeBid('abc', 4300, { egress: fakeEgress }),
    /live bid blocked/
  );

  // payDeadlineFromOutcome respects config (eBay = 4 days)
  const now = new Date('2026-05-04T00:00:00Z');
  const deadline = adapter.payDeadlineFromOutcome({}, { now });
  assert.equal(deadline.getTime() - now.getTime(), 4 * 24 * 3600 * 1000);
  assert.equal(adapter.payUrlFor('abc'), 'https://pay.ebay.com/?itemId=abc');
});

test('shopgoodwill adapter has 7-day deadline and conservative profile', () => {
  const adapter = createShopgoodwillAuctionAdapter();
  assert.equal(adapter.siteId, 'shopgoodwill');
  assert.equal(adapter.capabilities.recommendedPollProfile, 'conservative');
  const now = new Date('2026-05-04T00:00:00Z');
  const deadline = adapter.payDeadlineFromOutcome({}, { now });
  assert.equal(deadline.getTime() - now.getTime(), 7 * 24 * 3600 * 1000);
});

test('registry registers ebay and shopgoodwill auctions resolvable by host or siteId', () => {
  const registry = createDefaultAdapterRegistry();
  assert.equal(registry.resolveAuction('ebay').siteId, 'ebay');
  assert.equal(registry.resolveAuction('https://shopgoodwill.com/item/1').siteId, 'shopgoodwill');
  assert.equal(registry.resolveAuction('shopgoodwill').siteId, 'shopgoodwill');
  const auctionList = registry.list('auction').map((row) => row.siteId);
  assert.deepEqual(auctionList.sort(), ['ebay', 'shopgoodwill']);
});

test('restockToScheduledOrderIntent maps maxQuantity, priceGuard, product, payment', () => {
  const intent = restockToScheduledOrderIntent({
    product: { siteId: 'tgtg', productUrl: 'https://app.tgtg/store/123', requiredVariants: { bag: 'surprise' } },
    constraints: { maxUnitPrice: 1500, maxQuantity: 3 },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'cred:home' },
    flow: 'tgtg.buy-bag@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false }
  }, { stock: 5 }, { now: new Date('2026-05-04T00:00:00Z'), watchId: 'watch:abc' });
  assert.equal(intent.product.siteId, 'tgtg');
  assert.deepEqual(intent.product.requiredVariants, { bag: 'surprise' });
  assert.deepEqual(intent.quantity, { type: 'range', min: 1, max: 3, preferred: 3 });
  assert.equal(intent.priceGuard.maxUnitPrice, 1500);
  assert.equal(intent.priceGuard.abortOnExceed, true);
  assert.equal(intent.payment.methodRef, 'cred:visa');
  assert.equal(intent.flow, 'tgtg.buy-bag@1');
  assert.equal(intent.sourceWatchId, 'watch:abc');
  assert.ok(intent.scheduling.triggerAt instanceof Date);
});

test('restockToScheduledOrderIntent uses exact quantity when maxQuantity is 1', () => {
  const intent = restockToScheduledOrderIntent({
    product: { siteId: 's', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1'
  }, null);
  assert.deepEqual(intent.quantity, { type: 'exact', value: 1 });
});

test('restockToScheduledOrderIntent rejects missing required fields', () => {
  assert.throws(() => restockToScheduledOrderIntent({}, null), /product/);
  assert.throws(() => restockToScheduledOrderIntent({ product: { siteId: 's' } }, null), /payment/);
  assert.throws(() => restockToScheduledOrderIntent({
    product: { siteId: 's' },
    payment: { methodRef: 'p' }
  }, null), /maxUnitPrice/);
});

test('sniper3 fireSignal without confirmation bridges directly to sniper2 and creates a task', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({
    eventBus: bus,
    notificationService: notif,
    sniper2,
    tenantId: 'local-user'
  });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'https://app.tgtg/store/123' },
    constraints: { maxUnitPrice: 2000, maxQuantity: 2 },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'cred:home' },
    flow: 'tgtg.buy-bag@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, maxOrders: 1, continueAfterSuccess: false }
  });
  const result = await sniper3.fireSignal(watchId, { itemId: 'p1', stock: 5, currentPriceCents: 1500 });
  assert.equal(result.ok, true);
  assert.ok(result.taskId, 'expected linked sniper2 taskId');
  assert.equal(sniper3.getWatch(watchId).state, 'executing');
  assert.equal(sniper3.getWatch(watchId).linkedTaskId, result.taskId);
  // sniper2 should now have a task with quantity range up to 2
  const tasks = [...sniper2.tasks.values()];
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].intent.quantity, { type: 'range', min: 1, max: 2, preferred: 2 });
  // restock_signal notification was emitted
  const notifs = notif.list({ tenantId: 'local-user' });
  assert.ok(notifs.some((n) => n.category === 'restock_signal'));
});

test('sniper3 fireSignal with requireConfirmation enters confirming and awaits user', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({
    eventBus: bus,
    notificationService: notif,
    sniper2,
    tenantId: 'local-user'
  });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'https://app.tgtg/store/123' },
    constraints: { maxUnitPrice: 2000, maxQuantity: 2 },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'cred:home' },
    flow: 'tgtg.buy-bag@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: true }
  });
  const triggered = await sniper3.fireSignal(watchId, { stock: 5 });
  assert.equal(triggered.awaitingConfirmation, true);
  assert.equal(sniper3.getWatch(watchId).state, 'confirming');
  // sniper2 must NOT have been called yet
  assert.equal(sniper2.tasks.size, 0);
  // confirmation_required notification emitted
  const notifs = notif.list({ tenantId: 'local-user' });
  assert.ok(notifs.some((n) => n.category === 'confirmation_required'));
  // user confirms → state goes to executing and sniper2 task is created
  const confirmed = await sniper3.confirmFromUser(watchId);
  assert.equal(confirmed.ok, true);
  assert.ok(confirmed.taskId);
  assert.equal(sniper2.tasks.size, 1);
});

test('sniper3 dismissConfirmation returns watch to monitoring without creating an order', async () => {
  const bus = new InMemoryBus();
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({ eventBus: bus, sniper2, tenantId: 'local-user' });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: true }
  });
  await sniper3.fireSignal(watchId, {});
  assert.equal(sniper3.getWatch(watchId).state, 'confirming');
  await sniper3.dismissConfirmation(watchId);
  assert.equal(sniper3.getWatch(watchId).state, 'monitoring');
  assert.equal(sniper2.tasks.size, 0);
});

test('sniper3 markExecutionResult succeeded + continueAfterSuccess loops back to monitoring', async () => {
  const bus = new InMemoryBus();
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({ eventBus: bus, sniper2, tenantId: 'local-user' });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, continueAfterSuccess: true, maxOrders: 3 }
  });
  await sniper3.fireSignal(watchId, {});
  assert.equal(sniper3.getWatch(watchId).state, 'executing');
  const view = await sniper3.markExecutionResult(watchId, { ok: true });
  assert.equal(view.state, 'monitoring');
  assert.equal(view.completedOrders, 1);
  // second signal works because completedOrders < maxOrders
  await sniper3.fireSignal(watchId, {});
  assert.equal(sniper3.getWatch(watchId).state, 'executing');
});

test('sniper3 markExecutionResult enforces maxOrders cap', async () => {
  const bus = new InMemoryBus();
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({ eventBus: bus, sniper2, tenantId: 'local-user' });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, continueAfterSuccess: true, maxOrders: 1 }
  });
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: true });
  assert.equal(sniper3.getWatch(watchId).state, 'exhausted');
  const refusal = await sniper3.fireSignal(watchId, {});
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'task_already_terminal');
});

test('mobile-flow site schema enforces android package, reservation TTL, and no iOS', () => {
  assert.equal(validateMobileFlowSiteConfig(TGTG_CONFIG).ok, true);
  const noPkg = validateMobileFlowSiteConfig({
    siteId: 'x',
    family: 'mobile-flow',
    identifyHosts: ['x.test'],
    capabilities: { siteId: 'x', supportsMobileStrategy: true, reservationTypicalTtlMs: 300000 }
  });
  assert.equal(noPkg.ok, false);
  assert.ok(noPkg.errors.some((e) => e.includes('androidPackage')));

  const noTtl = validateMobileFlowSiteConfig({
    ...TGTG_CONFIG,
    capabilities: { ...TGTG_CONFIG.capabilities, reservationTypicalTtlMs: 0 }
  });
  assert.equal(noTtl.ok, false);
  assert.ok(noTtl.errors.some((e) => e.includes('reservationTypicalTtlMs')));

  const iosLike = validateMobileFlowSiteConfig({
    ...TGTG_CONFIG,
    capabilities: { ...TGTG_CONFIG.capabilities, mobile: { supportedPaths: ['mobile-android', 'mobile-i' + 'os'] } }
  });
  assert.equal(iosLike.ok, false);
});

test('TGTG adapter identifies by siteId, android package, and host substrings', () => {
  const adapter = createTooGoodToGoAdapter();
  assert.equal(adapter.siteId, 'tgtg');
  assert.equal(adapter.selectEngine(), 'mobile-android');
  assert.equal(adapter.identify('tgtg'), true);
  assert.equal(adapter.identify('com.app.tgtg'), true);
  assert.equal(adapter.identify('https://share.toogoodtogo.com/store/abc'), true);
  assert.equal(adapter.identify('https://shopgoodwill.com'), false);
  // capabilities convey reservation TTL (5 min) and payment channel types
  assert.equal(adapter.capabilities.reservationTypicalTtlMs, 300000);
  assert.deepEqual([...adapter.capabilities.paymentChannelTypes], ['creditcard', 'wallet']);
});

test('TGTG adapter fixture snapshot honors requested pickupDate and resolves variant', async () => {
  const adapter = createTooGoodToGoAdapter();
  const snapshot = await adapter.fetchProductSnapshot('store-42', { input: { pickupDate: '2026-05-05' } });
  assert.equal(snapshot.storeId, 'store-42');
  assert.equal(snapshot.inStock, true);
  assert.equal(snapshot.variants[0].attributes.pickupDate, '2026-05-05');
  const matched = adapter.resolveVariant(snapshot, { pickupDate: '2026-05-05', timeWindow: '17:00-19:00' });
  assert.ok(matched);
  assert.equal(matched.unitPriceCents, 599);
  const noMatch = adapter.resolveVariant(snapshot, { pickupDate: '2099-12-31' });
  assert.equal(noMatch, null);
});

test('TGTG end-to-end via API: tgtg-watches → fireSignal → sniper2 task with mobile-android engine', async () => {
  const app = createApp();
  const server = createServer(app);
  await listen(server);
  try {
    const watchResp = await requestJson(server, 'POST', '/api/v1/sniper3/tgtg-watches', {
      storeId: 'store-42',
      pickupDate: '2026-05-05',
      timeWindow: '17:00-19:00',
      maxQuantity: 3,
      maxUnitPriceCents: 800,
      payment: { methodRef: 'cred:visa' },
      requireConfirmation: false
    });
    assert.equal(watchResp.status, 201);
    const watchId = watchResp.body.watchId;
    assert.ok(watchId);
    assert.equal(watchResp.body.intent.product.siteId, 'tgtg');
    assert.deepEqual(watchResp.body.intent.constraints.requiredVariants, {
      pickupDate: '2026-05-05',
      timeWindow: '17:00-19:00'
    });
    assert.equal(watchResp.body.intent.constraints.maxQuantity, 3);

    // fire signal — bridges to sniper2
    const signalResp = await requestJson(server, 'POST', `/api/v1/sniper3/watches/${encodeURIComponent(watchId)}/signal`, {
      snapshot: { stock: 5, currentPriceCents: 599 }
    });
    assert.equal(signalResp.status, 200);
    assert.equal(signalResp.body.ok, true);
    assert.ok(signalResp.body.taskId);

    // verify sniper2 task created with mobile-android engine
    const tasks = [...app.sniper2.tasks.values()];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].intent.product.siteId, 'tgtg');
    assert.deepEqual(tasks[0].intent.quantity, { type: 'range', min: 1, max: 3, preferred: 3 });
    const adapter = app.adapterRegistry.resolveOrdering('tgtg');
    assert.equal(app.sniper2.selectEngine(tasks[0].intent), 'mobile-android');
    assert.equal(adapter.siteId, 'tgtg');

    // watch should now be in executing
    const view = app.sniper3.getWatch(watchId);
    assert.equal(view.state, 'executing');
    assert.equal(view.linkedTaskId, signalResp.body.taskId);
  } finally {
    await closeServer(server);
  }
});

test('TGTG watch validates required fields (storeId, pickupDate, maxQuantity 1..5, payment)', async () => {
  const app = createApp();
  const server = createServer(app);
  await listen(server);
  try {
    const r1 = await requestJson(server, 'POST', '/api/v1/sniper3/tgtg-watches', { pickupDate: '2026-05-05' });
    assert.equal(r1.status, 500);
    assert.ok(r1.body.error === 'flow_validation_failed' || /storeId/.test(r1.body.message));
    const r2 = await requestJson(server, 'POST', '/api/v1/sniper3/tgtg-watches', {
      storeId: 's', pickupDate: '2026-05-05', maxQuantity: 99,
      maxUnitPriceCents: 100, payment: { methodRef: 'cred:visa' }
    });
    assert.equal(r2.status, 500);
    assert.match(r2.body.message, /maxQuantity/);
    const r3 = await requestJson(server, 'POST', '/api/v1/sniper3/tgtg-watches', {
      storeId: 's', pickupDate: '2026-05-05', maxQuantity: 2,
      maxUnitPriceCents: 100  // missing payment
    });
    assert.equal(r3.status, 500);
    assert.match(r3.body.message, /payment/);
  } finally {
    await closeServer(server);
  }
});

test('Sniper2 emits sniper2:task:terminal and Sniper3 auto-marks linked watch on success', async () => {
  const bus = new InMemoryBus();
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({ eventBus: bus, sniper2, tenantId: 'local-user' });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'tgtg-store:s' },
    constraints: { maxUnitPrice: 1000, maxQuantity: 1, requiredVariants: { pickupDate: '2026-05-05' } },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 'pickup-in-store' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, continueAfterSuccess: false, maxOrders: 1 }
  });
  const signalResult = await sniper3.fireSignal(watchId, {});
  assert.equal(sniper3.getWatch(watchId).state, 'executing');
  assert.equal(signalResult.ok, true);
  // simulate sniper2 finishing the pipeline by emitting the terminal event directly
  bus.emit({
    topic: 'sniper2:task:terminal',
    tenantId: 'local-user',
    payload: { taskId: signalResult.taskId, sourceWatchId: watchId, ok: true, phase: 'settle', reason: null }
  });
  // the subscriber is async but resolves on the same tick
  await new Promise((r) => setImmediate(r));
  assert.equal(sniper3.getWatch(watchId).state, 'exhausted');
});

test('Sniper2 auto-drive on triggerAt fires runFullPipeline via PrecisionScheduler', async () => {
  const bus = new InMemoryBus();
  let triggered = false;
  // mock scheduler that fires synchronously
  const mockScheduler = {
    schedule({ onTrigger }) {
      triggered = true;
      const handle = { id: 'mock', task: { onTrigger }, fired: false };
      // call asynchronously to mimic real scheduler
      setImmediate(async () => { await onTrigger(); });
      return handle;
    },
    cancel() {}
  };
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: { 'x-order-id': 'o1' }, bodyText: 'ok' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    scheduler: mockScheduler,
    tenantId: 'local-user'
  });
  const taskId = await sniper2.createTask({
    product: { siteId: 'fixture-shop', productUrl: 'https://shop.test/p/1', requiredVariants: { size: '42' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 10000, abortOnExceed: true },
    scheduling: { triggerAt: new Date(Date.now() + 60000) },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'home' },
    flow: 'fixture.buy-product@2'
  });
  assert.ok(triggered, 'expected scheduler.schedule() to be called when triggerAt is set');
  // wait for the auto-drive to complete
  await new Promise((r) => setTimeout(r, 30));
  const terminalEvents = bus.replay({ topic: 'sniper2:task:terminal' });
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].payload.taskId, taskId);
});

test('TGTG end-to-end: signal → reserve (acquire) → pay (settle) → watch.exhausted via fixture mobile session', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const guard = new LiveTransactionGuard({
    env: { SMART_SNIPER_DEVELOPER_MODE: '1', SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS: '1' }
  });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: guard,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({
    eventBus: bus,
    notificationService: notif,
    sniper2,
    tenantId: 'local-user'
  });

  const tgtgFlow = {
    flow_id: 'tgtg.reserve-pay',
    version: 2,
    target: 'tgtg',
    platform: 'mobile-android',
    variables: [
      { name: 'storeId', type: 'string', required: true },
      { name: 'pickupDate', type: 'string', required: true },
      { name: 'quantity', type: 'number', required: true }
    ],
    phases: {
      acquire: [
        { id: 'open_store',     action: 'navigate', url: 'tgtg-store:${input.storeId}' },
        { id: 'pick_date',      action: 'tap',      selector: 'css=Button[text~="${input.pickupDate}"]' },
        { id: 'set_quantity',   action: 'input',    selector: 'css=quantity_text', value: '${input.quantity}' },
        { id: 'tap_reserve',    action: 'tap',      selector: 'css=Button[text~="reserve"]' },
        { id: 'capture_token',  action: 'capture',  capture_as: 'reservation_token', capture_field: { type: 'app_event', name: 'orderId' } }
      ],
      settle: [
        { id: 'validate_reservation', action: 'navigate_with_state', use: 'reservation_token' },
        { id: 'tap_pay',              action: 'tap', selector: 'css=Button[text~="pay"]' },
        { id: 'capture_order',        action: 'capture', capture_as: 'order_confirmation', capture_field: { type: 'app_event', name: 'orderId' } }
      ]
    }
  };
  const flowRef = sniper2.registerFlow(tgtgFlow);

  // RestockIntent for TGTG (same shape buildTgtgRestockIntent in server.js produces)
  const watchId = await sniper3.createWatch({
    product: {
      siteId: 'tgtg',
      productUrl: 'tgtg-store:store-42',
      storeId: 'store-42',
      requiredVariants: { pickupDate: '2026-05-05' }
    },
    constraints: {
      maxUnitPrice: 800,
      maxQuantity: 2,
      requiredVariants: { pickupDate: '2026-05-05' }
    },
    policy: {
      triggerOn: 'any_stock',
      requireConfirmation: false,
      continueAfterSuccess: false,
      maxOrders: 1,
      pollProfile: 'idle'
    },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'pickup-in-store' },
    flow: flowRef
  });

  // signal arrives; sniper3 bridges to sniper2 → linked task created
  const signal = await sniper3.fireSignal(watchId, { stock: 5, currentPriceCents: 599 });
  assert.equal(signal.ok, true, JSON.stringify(signal));
  const taskId = signal.taskId;
  assert.equal(sniper3.getWatch(watchId).state, 'executing');

  // fixture Appium-style session — returns plausible values per step
  const seenSteps = [];
  const session = {
    async runFlowStep(stepOrFlowId, context) {
      // base-mobile-flow.fetchProductSnapshot uses string flow id; we bypass via ctx.snapshot
      if (typeof stepOrFlowId === 'string') return { snapshot: null };
      seenSteps.push(stepOrFlowId.id);
      const step = stepOrFlowId;
      if (step.capture_as === 'reservation_token') {
        return { ok: true, value: { raw: 'tgtg-order:R-XYZ', source: 'app_event' } };
      }
      if (step.capture_as === 'order_confirmation') {
        return { ok: true, value: { raw: 'TGTG-ORDER-456', source: 'app_event' } };
      }
      if (step.action === 'navigate_with_state') {
        return { ok: true, value: context.captured?.[step.use] };
      }
      return { ok: true };
    }
  };

  const ctx = {
    mobileSession: session,
    transactionControl: { developerMode: true, executeLive: true, confirmationPhrase: LIVE_CONFIRMATION_PHRASE },
    flow: tgtgFlow,
    input: { storeId: 'store-42', pickupDate: '2026-05-05', quantity: 2 },
    snapshot: {
      siteId: 'tgtg',
      storeId: 'store-42',
      productUrl: 'tgtg-store:store-42',
      fetchedAt: new Date(),
      inStock: true,
      variants: [
        { sku: 'tgtg-bag-evening',
          attributes: { pickupDate: '2026-05-05', timeWindow: '17:00-19:00' },
          unitPriceCents: 599,
          inStock: true }
      ]
    },
    forceNow: true                   // bypass PaymentChannel 30s wait for the test
  };

  const result = await sniper2.runFullPipeline(taskId, ctx);
  assert.equal(result.ok, true, `expected pipeline ok, got ${JSON.stringify(result)}`);
  assert.equal(result.phase, 'settle');
  assert.equal(result.acquire.reservationToken.raw, 'tgtg-order:R-XYZ');
  assert.equal(result.settle.orderConfirmation.orderId, 'TGTG-ORDER-456');

  // every flow step the fixture session saw, in order
  assert.deepEqual(seenSteps, [
    'open_store', 'pick_date', 'set_quantity', 'tap_reserve', 'capture_token',
    'validate_reservation', 'tap_pay', 'capture_order'
  ]);

  // sniper3 picks up sniper2:task:terminal asynchronously and marks the watch
  await new Promise((r) => setImmediate(r));
  const watchView = sniper3.getWatch(watchId);
  assert.equal(watchView.state, 'exhausted');     // maxOrders=1, completed → exhaust
  assert.equal(watchView.completedOrders, 1);

  // notifications: restock_signal (info, on signal) + task_completed (info, after success)
  const notifs = notif.list({ tenantId: 'local-user' });
  const cats = notifs.map((n) => n.category);
  assert.ok(cats.includes('restock_signal'),     `missing restock_signal in ${cats.join(',')}`);
  assert.ok(cats.includes('task_completed'),     `missing task_completed in ${cats.join(',')}`);
});

test('PaymentChannel serializes two TGTG orders on the same payment method (>=30s apart)', () => {
  const baseTime = Date.UTC(2026, 4, 4, 17, 0, 0);
  let now = baseTime;
  const channel = new PaymentChannel({
    id: 'channel:visa',
    methodRef: 'cred:visa',
    minIntervalMs: 30000,
    typicalDurationMs: 5000,
    clock: () => now
  });
  channel.enqueue(task('order-A', baseTime + 240000));   // reservation expires 4 min from now
  channel.enqueue(task('order-B', baseTime + 270000));
  const state = channel.inspect();
  assert.equal(state.pending.length, 2);
  // enqueue order: earliest deadline first → A then B
  assert.equal(state.pending[0].taskId, 'order-A');
  // start A immediately
  const a = channel.startNext({ forceNow: true });
  assert.equal(a.taskId, 'order-A');
  // before completing A, advance clock; A finishes
  now = baseTime + 5000;
  channel.complete('order-A', { ok: true, durationMs: 5000 });
  // B's earliestStart must be at least lastFinish + 30s (PaymentChannel.minIntervalMs)
  const after = channel.inspect();
  const earliestStart = after.pending[0].estimatedStartAt.getTime();
  // lastFinish was baseTime + 5s; +30s = baseTime + 35s
  assert.ok(earliestStart >= baseTime + 35_000, `earliestStart ${earliestStart - baseTime}ms after base, expected >= 35000`);
});

test('error meta exposes userMessage and recovery for every code; new error codes registered', () => {
  const required = [
    'auth_required',
    'account_blocked',
    'payment_3ds_required',
    'insufficient_funds',
    'payment_declined_hard',
    'payment_refunded_by_vendor',
    'stock_phantom_read'
  ];
  for (const code of required) {
    assert.ok(ErrorCodes.includes(code), `missing code ${code}`);
    assert.ok(ERROR_META[code], `missing meta for ${code}`);
    assert.ok(typeof ERROR_META[code].userMessage === 'string' && ERROR_META[code].userMessage.length > 0);
    assert.ok(typeof userMessageFor(code) === 'string');
  }
  // every code in the enum must have meta + userMessage
  for (const code of ErrorCodes) {
    assert.ok(ERROR_META[code], `${code} missing ERROR_META entry`);
    assert.ok(ERROR_META[code].userMessage, `${code} missing userMessage`);
  }
  assert.equal(userMessageFor('not_a_code'), 'not_a_code');   // graceful fallback
});

test('computeBackoff: exponential strategy uses 0..base*2^(attempt-1) with cap', () => {
  // deterministic randomness via stub
  const realRandom = Math.random;
  try {
    Math.random = () => 0.999;
    assert.equal(computeBackoff('exponential', 100, 1, 30000), 100);   // ≈ base
    assert.equal(computeBackoff('exponential', 100, 2, 30000), 200);   // ≈ base*2
    assert.equal(computeBackoff('exponential', 100, 3, 30000), 400);   // ≈ base*4
    assert.equal(computeBackoff('exponential', 100, 5, 300), 300);     // capped
    Math.random = () => 0;
    assert.equal(computeBackoff('exponential', 100, 1, 30000), 0);     // full-jitter floor
  } finally {
    Math.random = realRandom;
  }
  assert.equal(computeBackoff('fixed', 500, 5, 30000), 500);
  assert.equal(computeBackoff('linear', 500, 4, 30000), 2000);
  assert.equal(computeBackoff('linear', 500, 4, 1000), 1000);          // capped
  assert.equal(computeBackoff('exponential', 0, 3), 0);                // base 0 → 0
});

test('detect3dsChallenge fires on ACS host, location header, body fields, and explicit redirect', () => {
  assert.equal(detect3dsChallenge({ url: 'https://acs1.bank.com/auth' }), true);
  assert.equal(detect3dsChallenge({ url: 'https://3dsecure.bank.com/x' }), true);
  assert.equal(detect3dsChallenge({ url: 'https://shop.test/checkout' }), false);
  assert.equal(detect3dsChallenge({ headers: { location: 'https://acs.example.com/3ds' } }), true);
  assert.equal(detect3dsChallenge({ bodyText: '<form><input name="PaReq" value="..." /><input name="acsUrl" /></form>' }), true);
  assert.equal(detect3dsChallenge({ bodyText: 'normal page' }), false);
  assert.equal(detect3dsChallenge({ threeDsRedirectUrl: 'https://anywhere' }), true);
  assert.equal(detect3dsChallenge(null), false);
});

test('HttpExecutionEngine: 3DS challenge in settle phase throws payment_3ds_required (not generic payment_failed)', async () => {
  const egress = {
    async fetch() {
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        bodyText: '<html><form action="https://acs.bank.com/auth"><input name="PaReq" /></form></html>',
        url: 'https://shop.test/pay'
      };
    }
  };
  const engine = new HttpExecutionEngine({ egress });
  await assert.rejects(
    () => engine.runStep({ id: 'pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' } },
      { captured: {}, executionState: { captured: {}, inputs: {}, checkpoints: [] }, phase: 'settle' }),
    (err) => err.code === 'payment_3ds_required'
  );
});

test('HttpExecutionEngine: maps 4xx body to insufficient_funds / payment_declined / payment_declined_hard', async () => {
  const cases = [
    { body: 'card declined: insufficient funds available', expect: 'insufficient_funds' },
    { body: 'card lost or stolen, please contact issuer',  expect: 'payment_declined_hard' },
    { body: 'transaction was declined by issuer',          expect: 'payment_declined' },
    { body: 'unknown failure',                              expect: 'payment_failed' }
  ];
  for (const c of cases) {
    const egress = {
      async fetch() { return { status: 402, headers: {}, bodyText: c.body, url: 'https://shop.test/pay' }; }
    };
    const engine = new HttpExecutionEngine({ egress });
    await assert.rejects(
      () => engine.runStep({ id: 'pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' } },
        { captured: {}, executionState: { captured: {}, inputs: {}, checkpoints: [] }, phase: 'settle' }),
      (err) => {
        if (err.code !== c.expect) {
          throw new Error(`for body "${c.body}" expected ${c.expect}, got ${err.code}`);
        }
        return true;
      }
    );
  }
});

test('HttpExecutionEngine: terminal/manual errors are NOT retried even if retry.max > 0', async () => {
  let calls = 0;
  const egress = {
    async fetch() {
      calls += 1;
      return { status: 402, headers: {}, bodyText: 'card declined', url: 'https://shop.test/pay' };
    }
  };
  const engine = new HttpExecutionEngine({ egress });
  await assert.rejects(
    () => engine.runStep(
      { id: 'pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' }, retry: { max: 5, backoff_ms: 1 } },
      { captured: {}, executionState: { captured: {}, inputs: {}, checkpoints: [] }, phase: 'settle' }
    ),
    (err) => err.code === 'payment_declined'
  );
  assert.equal(calls, 1);                       // payment_declined recovery=manual → no retry
});

test('HttpExecutionEngine: retriable errors retry up to retry.max with backoff', async () => {
  let calls = 0;
  const egress = {
    async fetch() {
      calls += 1;
      if (calls < 3) return { status: 429, headers: {}, bodyText: '', url: 'https://x/y' };
      return { status: 200, headers: {}, bodyText: 'ok', url: 'https://x/y' };
    }
  };
  const engine = new HttpExecutionEngine({ egress });
  const result = await engine.runStep(
    { id: 'try', action: 'navigate', url: 'https://x/y', retry: { max: 5, backoff_ms: 1, strategy: 'fixed' } },
    { captured: {}, executionState: { captured: {}, inputs: {}, checkpoints: [] } }
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test('BaseHtmlAuctionAdapter: detects account_blocked from snapshot body even on 200 OK', async () => {
  const adapter = createShopgoodwillAuctionAdapter();
  const fakeEgress = {
    async fetch() {
      return {
        status: 200,
        headers: { date: 'Mon, 04 May 2026 12:00:00 GMT' },
        bodyText: 'Your account has been suspended pending review',
        url: 'https://shopgoodwill.com/item/123'
      };
    }
  };
  await assert.rejects(
    () => adapter.fetchSnapshot('123', { egress: fakeEgress }),
    (err) => err.code === 'account_blocked'
  );
});

test('BaseHtmlAuctionAdapter.placeBid maps decline reason via site config', async () => {
  const adapter = createShopgoodwillAuctionAdapter();
  const fakeEgress = {
    async fetch() {
      return {
        status: 402,
        headers: { date: 'Mon, 04 May 2026 12:00:00 GMT' },
        bodyText: 'card declined - insufficient funds',
        url: 'https://shopgoodwill.com/api/Item/PlaceBid'
      };
    }
  };
  const result = await adapter.placeBid('123', 1500, { egress: fakeEgress, liveTransactionAllowed: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'insufficient_funds');
  assert.equal(result.retriable, false);
});

test('Sniper2: pre-pay recheck blocks settle when variant is no longer in stock between acquire and pay', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard({
      env: { SMART_SNIPER_DEVELOPER_MODE: '1', SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS: '1' }
    }),
    notificationService: notif,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const flow = {
    flow_id: 'tgtg.reserve-pay', version: 2, target: 'tgtg', platform: 'mobile-android',
    variables: [
      { name: 'storeId', type: 'string', required: true },
      { name: 'pickupDate', type: 'string', required: true },
      { name: 'quantity', type: 'number', required: true }
    ],
    phases: {
      acquire: [
        { id: 'open', action: 'navigate', url: 'tgtg-store:${input.storeId}' },
        { id: 'tap_reserve', action: 'tap', selector: 'css=Button[text~="reserve"]' },
        { id: 'capture_token', action: 'capture', capture_as: 'reservation_token', capture_field: { type: 'app_event', name: 'orderId' } }
      ],
      settle: [
        { id: 'validate_reservation', action: 'navigate_with_state', use: 'reservation_token' },
        { id: 'tap_pay', action: 'tap', selector: 'css=Button[text~="pay"]' },
        { id: 'capture_order', action: 'capture', capture_as: 'order_confirmation', capture_field: { type: 'app_event', name: 'orderId' } }
      ]
    }
  };
  sniper2.registerFlow(flow);
  const taskId = await sniper2.createTask({
    product: { siteId: 'tgtg', productUrl: 'tgtg-store:store-X', requiredVariants: { pickupDate: '2026-05-05' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 800, abortOnExceed: true },
    scheduling: { triggerAt: new Date(Date.now() + 60000) },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'pickup' },
    flow: 'tgtg.reserve-pay@2'
  }, { autoDrive: false });

  const session = {
    async runFlowStep(stepOrFlowId, context) {
      if (typeof stepOrFlowId === 'string') return { snapshot: null };
      if (stepOrFlowId.capture_as === 'reservation_token') {
        return { ok: true, value: { raw: 'tgtg-order:R-1', source: 'app_event' } };
      }
      return { ok: true };
    }
  };
  const ctx = {
    mobileSession: session,
    transactionControl: { developerMode: true, executeLive: true, confirmationPhrase: LIVE_CONFIRMATION_PHRASE },
    flow,
    input: { storeId: 'store-X', pickupDate: '2026-05-05', quantity: 1 },
    snapshot: {
      siteId: 'tgtg', storeId: 'store-X', productUrl: 'tgtg-store:store-X', fetchedAt: new Date(), inStock: true,
      variants: [{ sku: 'b', attributes: { pickupDate: '2026-05-05' }, unitPriceCents: 599, inStock: true }]
    },
    // Recheck snapshot says the bag we wanted is no longer in stock
    recheckSnapshot: {
      siteId: 'tgtg', storeId: 'store-X', productUrl: 'tgtg-store:store-X', fetchedAt: new Date(), inStock: false,
      variants: [{ sku: 'b', attributes: { pickupDate: '2026-05-05' }, unitPriceCents: 599, inStock: false }]
    },
    forceNow: true
  };
  const result = await sniper2.runFullPipeline(taskId, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'prepay_recheck');
  assert.equal(result.reason, 'stock_phantom_read');
  // checkPriceGuard runs first; with all variants inStock:false → cheapest = Infinity → stock_sold_out
  assert.equal(result.recheck.cause, 'stock_sold_out');

  // notification: stock_phantom emitted
  const notifs = notif.list({ tenantId: 'local-user' });
  assert.ok(notifs.some((n) => n.category === 'stock_phantom'));
});

test('Sniper2: 3DS challenge surfaces as payment_3ds_required + freezes the PaymentChannel + emits urgent notification', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const guard = new LiveTransactionGuard({
    env: { SMART_SNIPER_DEVELOPER_MODE: '1', SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS: '1' }
  });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: guard,
    notificationService: notif,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const flow = {
    flow_id: 'fixture.buy-product', version: 2, target: 'fixture-shop', platform: 'web',
    phases: {
      acquire: [
        { id: 'reserve', action: 'navigate', url: 'https://shop.test/reserve' },
        { id: 'capture_token', action: 'capture', capture_as: 'reservation_token', capture_field: { type: 'url_param', name: 'order_token' } }
      ],
      settle: [
        { id: 'validate_reservation', action: 'navigate_with_state', use: 'reservation_token' },
        { id: 'pay', action: 'tap', request: { method: 'POST', url: 'https://shop.test/pay' } }
      ]
    }
  };
  sniper2.registerFlow(flow);
  const taskId = await sniper2.createTask({
    product: { siteId: 'fixture-shop', productUrl: 'https://shop.test/p/1', requiredVariants: { size: '42', color: 'black' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 13000, abortOnExceed: true },
    scheduling: { triggerAt: new Date(Date.now() + 60000) },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'home' },
    flow: 'fixture.buy-product@2'
  }, { autoDrive: false });

  // egress: acquire returns reservation token; settle pay returns ACS challenge
  const egress = {
    async fetch(req) {
      if (req.url.includes('reserve')) {
        return { status: 200, headers: { date: new Date().toUTCString() }, bodyText: 'reserved', url: 'https://shop.test/checkout?order_token=tok-1' };
      }
      // 3DS challenge
      return { status: 200, headers: {}, bodyText: '<form><input name="PaReq" /></form>', url: 'https://shop.test/pay' };
    }
  };
  const result = await sniper2.runFullPipeline(taskId, {
    egress,
    flow,
    transactionControl: { developerMode: true, executeLive: true, confirmationPhrase: LIVE_CONFIRMATION_PHRASE },
    forceNow: true
  }, { prepayRecheck: false });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'settle');
  assert.equal(result.reason, 'payment_3ds_required');

  // PaymentChannel for cred:visa should be frozen
  const channel = sniper2.paymentChannels.get('channel:cred:visa');
  assert.ok(channel);
  assert.equal(channel.isFrozen, true);
  assert.match(channel.frozenReason, /3ds/i);

  // urgent payment_3ds_required notification
  const notifs = notif.list({ tenantId: 'local-user' });
  const ds = notifs.find((n) => n.category === 'payment_3ds_required');
  assert.ok(ds, 'expected payment_3ds_required notification');
  assert.equal(ds.severity, 'urgent');
});

test('Sniper1: bid result with account_blocked emits urgent account_blocked notification', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const registry = createDefaultAdapterRegistry();
  const service = new Sniper1Service({
    adapterRegistry: registry,
    eventBus: bus,
    notificationService: notif,
    transactionGuard: new LiveTransactionGuard({
      env: { SMART_SNIPER_DEVELOPER_MODE: '1', SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS: '1' }
    })
  });
  const itemId = await service.addWatchedItem('ebay', 'https://www.ebay.test/itm/1', { budget: 5000 });
  service.items.get(itemId).machine.send('arm');
  service.items.get(itemId).machine.send('executeBid');
  await service.handleBidOutcome(itemId, { ok: false, reason: 'account_blocked', retriable: false }, 1500);
  const notifs = notif.list({ tenantId: 'local-user' });
  const blocked = notifs.find((n) => n.category === 'account_blocked');
  assert.ok(blocked, 'expected account_blocked notification');
  assert.equal(blocked.severity, 'urgent');
  assert.equal(blocked.payload.itemId, itemId);
});

test('MiddlewareEgress propagates X-Request-Id from tenant-context as outbound headers', async () => {
  let captured;
  const underlying = {
    async fetch(req) {
      captured = req.headers;
      return { status: 200, headers: {}, bodyText: '', url: req.url };
    }
  };
  const wrapped = new MiddlewareEgress({ underlying, siteId: 'shopgoodwill', minIntervalMs: 0 });
  await withRequestContext({ tenantId: 'local-user', requestId: 'req:abc-123' }, async () => {
    await wrapped.fetch({ url: 'https://shopgoodwill.com/item/1' });
  });
  assert.equal(captured['x-request-id'], 'req:abc-123');
  assert.match(captured['x-trace-id'], /^trace:/);
});

test('API error response carries userMessage + requestId', async () => {
  const app = createApp();
  const server = createServer(app);
  await listen(server);
  try {
    const resp = await requestJson(server, 'POST', '/api/v1/sniper3/tgtg-watches', { /* missing required fields */ });
    assert.equal(resp.status, 500);
    assert.ok(typeof resp.body.userMessage === 'string' && resp.body.userMessage.length > 0);
    assert.ok(typeof resp.body.requestId === 'string');
  } finally {
    await closeServer(server);
  }
});

test('LockProvider stub: NoOpLockProvider supports acquire / release / withLock; base throws on unimplemented', async () => {
  const provider = new NoOpLockProvider();
  const key = lockKeyFor('local-user', 'tgtg', 'cred:visa');
  assert.equal(key, 'local-user:tgtg:cred:visa');
  assert.equal(await provider.isHeld(key), false);
  const handle = await provider.acquire(key, { ttlMs: 1000 });
  assert.equal(handle.key, key);
  assert.equal(await provider.isHeld(key), true);
  await provider.release(handle);
  assert.equal(await provider.isHeld(key), false);
  let ran = false;
  const out = await provider.withLock(key, async () => { ran = true; return 42; });
  assert.equal(ran, true);
  assert.equal(out, 42);
  // base class methods throw — they are abstract
  const base = new LockProvider();
  await assert.rejects(() => base.acquire('k'), /must be implemented/);
  await assert.rejects(() => base.release({ key: 'k' }), /must be implemented/);
});

test('Sniper2: vendor cancellation post-settle emits vendor_refunded urgent notification', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  // mock scheduler that runs onTrigger immediately
  const scheduledTriggers = [];
  const scheduler = {
    schedule({ onTrigger }) {
      scheduledTriggers.push(onTrigger);
      return { id: 'mock' };
    },
    cancel() {}
  };
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    notificationService: notif,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    scheduler,
    tenantId: 'local-user'
  });
  // create a fake task directly; we only need scheduleOrderVerification to fire
  const taskId = await sniper2.createTask({
    product: { siteId: 'tgtg', productUrl: 'tgtg-store:s', requiredVariants: { pickupDate: '2026-05-05' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 800, abortOnExceed: true },
    scheduling: { triggerAt: null },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'pickup' },
    flow: 'tgtg.reserve-pay@2'
  }, { autoDrive: false });
  // override TGTG adapter's fetchOrderStatus to return 'cancelled'
  const tgtgAdapter = sniper2.adapterRegistry.resolveOrdering('tgtg');
  tgtgAdapter.fetchOrderStatus = async () => 'cancelled';
  // schedule verification
  sniper2.scheduleOrderVerification(taskId, { orderId: 'TGTG-XYZ', totalChargedCents: 599 }, {});
  // fire the scheduled trigger
  assert.equal(scheduledTriggers.length, 1);
  await scheduledTriggers[0]();
  // assert vendor_refunded notification emitted
  const notifs = notif.list({ tenantId: 'local-user' });
  const refund = notifs.find((n) => n.category === 'vendor_refunded');
  assert.ok(refund, 'expected vendor_refunded notification');
  assert.equal(refund.severity, 'urgent');
  assert.equal(refund.payload.orderId, 'TGTG-XYZ');
  assert.equal(refund.payload.status, 'cancelled');
  // verifier marked done — no further ticks
  assert.equal(sniper2.tasks.get(taskId).orderVerification.done, true);
  assert.equal(sniper2.tasks.get(taskId).orderVerification.finalStatus, 'cancelled');
});

test('Sniper2: order verification handles unknown→pending→unknown→unknown sequence as payment_timeout', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const scheduledTriggers = [];
  const scheduler = {
    schedule({ onTrigger }) { scheduledTriggers.push(onTrigger); return { id: 'mock' }; },
    cancel() {}
  };
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    notificationService: notif,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    scheduler,
    tenantId: 'local-user'
  });
  const taskId = await sniper2.createTask({
    product: { siteId: 'tgtg', productUrl: 'tgtg-store:s', requiredVariants: { pickupDate: '2026-05-05' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 800, abortOnExceed: true },
    scheduling: { triggerAt: null },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'pickup' },
    flow: 'tgtg.reserve-pay@2'
  }, { autoDrive: false });
  const adapter = sniper2.adapterRegistry.resolveOrdering('tgtg');
  const sequence = ['unknown', 'pending', 'unknown', 'unknown'];
  let i = 0;
  adapter.fetchOrderStatus = async () => sequence[i++];
  sniper2.scheduleOrderVerification(taskId, { orderId: 'O-1' }, {});
  // Fire ticks one by one. Each tick may schedule the next.
  while (scheduledTriggers.length) {
    const fn = scheduledTriggers.shift();
    await fn();
  }
  // pending resets unknown streak; need 2 unknowns AFTER → the last two trigger payment_timeout
  const notifs = notif.list({ tenantId: 'local-user' });
  const failed = notifs.find((n) => n.category === 'task_failed' && n.payload.reason === 'payment_timeout');
  assert.ok(failed, 'expected payment_timeout task_failed notification');
  assert.equal(failed.severity, 'urgent');
  assert.equal(sniper2.tasks.get(taskId).orderVerification.finalStatus, 'timed_out');
});

test('Sniper2: confirmed status closes verifier without notification', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const scheduledTriggers = [];
  const scheduler = {
    schedule({ onTrigger }) { scheduledTriggers.push(onTrigger); return { id: 'mock' }; },
    cancel() {}
  };
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    notificationService: notif,
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    scheduler,
    tenantId: 'local-user'
  });
  const taskId = await sniper2.createTask({
    product: { siteId: 'tgtg', productUrl: 'tgtg-store:s', requiredVariants: { pickupDate: '2026-05-05' } },
    quantity: { type: 'exact', value: 1 },
    priceGuard: { maxUnitPrice: 800, abortOnExceed: true },
    scheduling: { triggerAt: null },
    payment: { methodRef: 'cred:visa' },
    shipping: { addressRef: 'pickup' },
    flow: 'tgtg.reserve-pay@2'
  }, { autoDrive: false });
  const adapter = sniper2.adapterRegistry.resolveOrdering('tgtg');
  adapter.fetchOrderStatus = async () => 'confirmed';
  sniper2.scheduleOrderVerification(taskId, { orderId: 'O-2' }, {});
  await scheduledTriggers[0]();
  const orderVerifiedEvents = bus.replay({ topic: 'sniper2:task:order_verified' });
  assert.equal(orderVerifiedEvents.length, 1);
  // No vendor_refunded / payment_timeout notification was emitted
  const notifs = notif.list({ tenantId: 'local-user' });
  assert.equal(notifs.filter((n) => n.category === 'vendor_refunded' || (n.category === 'task_failed' && n.payload?.reason === 'payment_timeout')).length, 0);
  assert.equal(sniper2.tasks.get(taskId).orderVerification.finalStatus, 'confirmed');
});

test('Sniper3 DLQ: consecutive failures past threshold force-exhaust the watch and emit urgent task_failed', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({
    eventBus: bus,
    notificationService: notif,
    sniper2,
    tenantId: 'local-user',
    quarantineAfterFailures: 3
  });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, continueAfterSuccess: true, maxOrders: 99 }
  });

  // 1st failure → continue (loops back to monitoring)
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  assert.equal(sniper3.getWatch(watchId).state, 'monitoring');
  assert.equal(sniper3.getWatch(watchId).consecutiveFailures, 1);
  assert.equal(sniper3.getWatch(watchId).quarantined, false);

  // 2nd failure → continue
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  assert.equal(sniper3.getWatch(watchId).state, 'monitoring');
  assert.equal(sniper3.getWatch(watchId).consecutiveFailures, 2);

  // 3rd failure → quarantine + force exhaust
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  assert.equal(sniper3.getWatch(watchId).state, 'exhausted');
  assert.equal(sniper3.getWatch(watchId).consecutiveFailures, 3);
  assert.equal(sniper3.getWatch(watchId).quarantined, true);
  assert.equal(sniper3.getWatch(watchId).quarantineReason, 'network_error');

  // urgent task_failed notification with quarantined: true
  const notifs = notif.list({ tenantId: 'local-user' });
  const lastFail = notifs.filter((n) => n.category === 'task_failed').at(-1);
  assert.equal(lastFail.severity, 'urgent');
  assert.equal(lastFail.payload.quarantined, true);
  assert.equal(lastFail.payload.consecutiveFailures, 3);

  // bus event emitted for observability
  const events = bus.replay({ topic: 'sniper3:watch:quarantined' });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.consecutiveFailures, 3);
});

test('Sniper3 DLQ: a successful order resets consecutiveFailures', async () => {
  const bus = new InMemoryBus();
  const notif = new NotificationService({ eventBus: bus, tenantId: 'local-user' });
  const sniper2 = new Sniper2Service({
    adapterRegistry: createDefaultAdapterRegistry(),
    eventBus: bus,
    transactionGuard: new LiveTransactionGuard(),
    egress: { fetch: async () => ({ status: 200, headers: {}, bodyText: '' }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tenantId: 'local-user'
  });
  const sniper3 = new Sniper3Service({
    eventBus: bus,
    notificationService: notif,
    sniper2,
    tenantId: 'local-user',
    quarantineAfterFailures: 3
  });
  const watchId = await sniper3.createWatch({
    product: { siteId: 'tgtg', productUrl: 'u' },
    constraints: { maxUnitPrice: 100, maxQuantity: 1 },
    payment: { methodRef: 'p' },
    shipping: { addressRef: 's' },
    flow: 'f@1',
    policy: { triggerOn: 'any_stock', requireConfirmation: false, continueAfterSuccess: true, maxOrders: 99 }
  });
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  // success resets the counter
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: true });
  assert.equal(sniper3.getWatch(watchId).consecutiveFailures, 0);
  // we can fail twice more without quarantining
  await sniper3.fireSignal(watchId, {});
  await sniper3.markExecutionResult(watchId, { ok: false, reason: 'network_error' });
  assert.equal(sniper3.getWatch(watchId).quarantined, false);
});

test('websocket events endpoint upgrades, subscribes, and streams bus events', async () => {
  const app = createApp();
  const server = createServer(app);
  await listen(server);
  const socket = new net.Socket();
  const key = randomBytes(16).toString('base64');
  const messages = [];
  let handshaken = false;
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!handshaken) {
      const marker = buffered.indexOf('\r\n\r\n');
      if (marker === -1) return;
      const header = buffered.subarray(0, marker).toString('utf8');
      assert.match(header, /101 Switching Protocols/);
      handshaken = true;
      buffered = buffered.subarray(marker + 4);
    }
    for (const frame of decodeServerFrames(buffered)) messages.push(JSON.parse(frame.toString('utf8')));
    buffered = Buffer.alloc(0);
  });
  const connected = once(socket, 'connect');
  socket.connect(server.address().port, '127.0.0.1');
  await withTimeout(connected, 1000, 'websocket connect timed out');
  socket.write([
    'GET /ws/v1/events HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '\r\n'
  ].join('\r\n'));
  await waitFor(() => handshaken);
  socket.write(encodeClientFrame(JSON.stringify({ type: 'subscribe', topics: ['sniper1:item:*'] })));
  await waitFor(() => messages.some((message) => message.type === 'subscribed'));
  app.eventBus.emit({ topic: 'sniper1:item:state_changed', tenantId: app.tenantId, payload: { itemId: 'item:1' } });
  await waitFor(() => messages.some((message) => message.type === 'event' && message.topic === 'sniper1:item:state_changed'));
  const closed = once(socket, 'close');
  socket.end();
  socket.destroy();
  await withTimeout(closed, 1000, 'websocket socket close timed out');
  server.close();
  server.unref();
});

function task(taskId, expiresAt) {
  return {
    taskId,
    acquiredAt: new Date(),
    reservationExpiresAt: new Date(expiresAt),
    estimatedDurationMs: 10000,
    flowSettlePhase: [],
    reservationToken: { raw: taskId, source: 'url_param' },
    maxRetries: 3,
    retryBackoffMs: 100
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function requestJson(server, method, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    let length = second & 0x7f;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    frames.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}
