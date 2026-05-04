import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryBus, topicMatches } from '../../core/event-bus/index.js';
import { InMemoryCredentialStore } from '../../core/credential-store/index.js';
import { DirectEgress, VaultProxyEgress } from '../../core/network-egress/index.js';
import { LiveTransactionGuard, parseTransactionControl, LIVE_CONFIRMATION_PHRASE } from '../../core/developer-mode/index.js';
import { userMessageFor } from '../../core/domain-types/index.js';
import { currentRequestId } from '../../core/tenant-context/index.js';
import { logger } from '../../core/logger/index.js';
import { withRequestContext } from '../../core/tenant-context/index.js';
import { NotificationService } from '../../core/notification-service/index.js';
import { PrecisionScheduler } from '../../core/scheduler/index.js';
import { createDefaultAdapterRegistry } from '../../adapters/registry.js';
import { Sniper1Service } from '../sniper1-service/index.js';
import { Sniper2Service } from '../sniper2-service/index.js';
import { Sniper3Service } from '../sniper3-service/index.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const tenantId = 'local-user';
  const eventBus = new InMemoryBus();
  const credentialStore = new InMemoryCredentialStore();
  const egress = new DirectEgress();
  const transactionGuard = new LiveTransactionGuard();
  const adapterRegistry = createDefaultAdapterRegistry();
  const scheduler = new PrecisionScheduler();
  const notificationService = new NotificationService({ eventBus, scheduler, tenantId });
  const sniper1 = new Sniper1Service({ adapterRegistry, eventBus, transactionGuard, notificationService, scheduler, tenantId });
  const sniper2 = new Sniper2Service({ adapterRegistry, eventBus, transactionGuard, notificationService, egress, logger, scheduler, tenantId });
  const sniper3 = new Sniper3Service({ eventBus, notificationService, sniper2, scheduler, tenantId });

  return { tenantId, eventBus, credentialStore, egress, transactionGuard, adapterRegistry, scheduler, notificationService, sniper1, sniper2, sniper3 };
}

export function createServer(app = createApp()) {
  const server = http.createServer((req, res) => {
    withRequestContext({ tenantId: app.tenantId, requestId: req.headers['x-request-id'] ?? `req:${Date.now()}` }, async () => {
      try {
        await route(req, res, app);
      } catch (error) {
        const code = error.code ?? 'internal_error';
        sendJson(res, error.statusCode ?? 500, {
          error: code,
          message: error.message,
          userMessage: userMessageFor(code),
          requestId: currentRequestId()
        });
      }
    });
  });
  server.on('upgrade', (req, socket, head) => handleWsUpgrade(req, socket, head, app));
  return server;
}

async function route(req, res, app) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname === '/app.js') {
    return serveStatic(req, res, url);
  }
  if (url.pathname === '/api/v1/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, tenantId: app.tenantId, developerMode: app.transactionGuard.status(), at: new Date().toISOString() });
  }
  if (url.pathname === '/api/v1/developer-mode' && req.method === 'GET') {
    return sendJson(res, 200, { ...app.transactionGuard.status(), confirmationPhrase: LIVE_CONFIRMATION_PHRASE });
  }
  if (url.pathname === '/api/v1/stats/overview' && req.method === 'GET') {
    return sendJson(res, 200, {
      adapters: app.adapterRegistry.list(),
      sniper1Items: app.sniper1.listWatchedItems().length,
      sniper2Tasks: app.sniper2.tasks.size,
      sniper3Watches: app.sniper3.watches.size
    });
  }
  if (url.pathname === '/api/v1/credentials' && req.method === 'GET') {
    return sendJson(res, 200, await app.credentialStore.list(app.tenantId, url.searchParams.get('siteId') ?? undefined));
  }
  if (url.pathname === '/api/v1/credentials' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.secret) throw codeError('vault_unavailable', 'Main process refuses plaintext credentials. Use the Vault daemon credential flow.');
    if (!app.vaultClient) throw codeError('vault_unavailable', 'Vault client is not configured for credential creation.');
    const ref = await app.vaultClient.promptForNewCredential(body.siteId);
    return sendJson(res, 201, { ref });
  }
  if (url.pathname === '/api/v1/sniper1/items' && req.method === 'GET') {
    return sendJson(res, 200, app.sniper1.listWatchedItems());
  }
  if (url.pathname === '/api/v1/sniper1/items' && req.method === 'POST') {
    const body = await readJson(req);
    const itemId = await app.sniper1.addWatchedItem(body.siteId, body.urlOrId, body.options);
    return sendJson(res, 201, { itemId });
  }
  const sniper1BidMatch = url.pathname.match(/^\/api\/v1\/sniper1\/items\/([^/]+)\/bid$/);
  if (sniper1BidMatch && req.method === 'POST') {
    const body = await readJson(req);
    const itemId = decodeURIComponent(sniper1BidMatch[1]);
    const decision = parseTransactionControl(body, app.transactionGuard);
    const result = await app.sniper1.executeBid(itemId, body.amountCents, {
      transactionControl: body.transactionControl ?? body.control ?? body,
      credentialRef: body.credentialRef,
      egress: makeEgress(app, body.credentialRef, body),
      logger,
      scope: 'sniper1',
      tenantId: app.tenantId,
      dryRunMode: decision.dryRunMode,
      liveAuction: body.liveAuction
    });
    return sendJson(res, 200, result);
  }
  const sniper1MarkPaidMatch = url.pathname.match(/^\/api\/v1\/sniper1\/items\/([^/]+)\/markPaid$/);
  if (sniper1MarkPaidMatch && req.method === 'POST') {
    const body = await readJson(req);
    const itemId = decodeURIComponent(sniper1MarkPaidMatch[1]);
    await app.sniper1.markPaymentCompleted(itemId, body.confirmedAt ? new Date(body.confirmedAt) : undefined);
    return sendJson(res, 200, { ok: true });
  }
  const sniper1MarkWonMatch = url.pathname.match(/^\/api\/v1\/sniper1\/items\/([^/]+)\/markWon$/);
  if (sniper1MarkWonMatch && req.method === 'POST') {
    const body = await readJson(req);
    const itemId = decodeURIComponent(sniper1MarkWonMatch[1]);
    const winOutcome = await app.sniper1.markItemWon(itemId, body.outcome ?? body);
    return sendJson(res, 200, { ok: true, winOutcome });
  }
  if (url.pathname === '/api/v1/notifications' && req.method === 'GET') {
    const since = url.searchParams.get('since');
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
    return sendJson(res, 200, app.notificationService.list({ tenantId: app.tenantId, since: since ?? undefined, unreadOnly }));
  }
  const notifyDismissMatch = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/dismiss$/);
  if (notifyDismissMatch && req.method === 'POST') {
    const id = decodeURIComponent(notifyDismissMatch[1]);
    const record = app.notificationService.dismiss(id);
    if (!record) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/api/v1/sniper2/tasks' && req.method === 'GET') {
    return sendJson(res, 200, [...app.sniper2.tasks.keys()].map((taskId) => app.sniper2.getTask(taskId)));
  }
  if (url.pathname === '/api/v1/sniper2/tasks' && req.method === 'POST') {
    const body = await readJson(req);
    const taskId = await app.sniper2.createTask(body.intent);
    return sendJson(res, 201, { taskId });
  }
  if (url.pathname === '/api/v1/sniper2/flows' && req.method === 'POST') {
    const body = await readJson(req);
    const flowRef = app.sniper2.registerFlow(body.flow);
    return sendJson(res, 201, { flowRef });
  }
  const sniper2ActionMatch = url.pathname.match(/^\/api\/v1\/sniper2\/tasks\/([^/]+)\/(acquire|settle|enqueue)$/);
  if (sniper2ActionMatch && req.method === 'POST') {
    const body = await readJson(req);
    const taskId = decodeURIComponent(sniper2ActionMatch[1]);
    const action = sniper2ActionMatch[2];
    const ctx = {
      transactionControl: body.transactionControl ?? body.control ?? body,
      credentialRef: body.credentialRef,
      egress: makeEgress(app, body.credentialRef, body),
      logger,
      dryRunMode: parseTransactionControl(body, app.transactionGuard).dryRunMode,
      flow: body.flow,
      input: body.input,
      env: body.env,
      snapshot: body.snapshot,
      engine: body.engine,
      forceNow: body.forceNow
    };
    if (action === 'acquire') return sendJson(res, 200, await app.sniper2.runAcquirePhase(taskId, ctx));
    if (action === 'enqueue') return sendJson(res, 200, app.sniper2.enqueueForSettle(taskId, body.reservationToken));
    return sendJson(res, 200, await app.sniper2.runSettlePhase(taskId, ctx));
  }
  if (url.pathname === '/api/v1/sniper3/watches' && req.method === 'GET') {
    return sendJson(res, 200, app.sniper3.listWatches());
  }
  if (url.pathname === '/api/v1/sniper3/watches' && req.method === 'POST') {
    const body = await readJson(req);
    const watchId = await app.sniper3.createWatch(body.intent);
    return sendJson(res, 201, { watchId });
  }
  if (url.pathname === '/api/v1/sniper3/tgtg-watches' && req.method === 'POST') {
    const body = await readJson(req);
    const intent = buildTgtgRestockIntent(body);
    const watchId = await app.sniper3.createWatch(intent);
    return sendJson(res, 201, { watchId, intent });
  }
  const sniper2RunMatch = url.pathname.match(/^\/api\/v1\/sniper2\/tasks\/([^/]+)\/run$/);
  if (sniper2RunMatch && req.method === 'POST') {
    const body = await readJson(req);
    const taskId = decodeURIComponent(sniper2RunMatch[1]);
    const ctx = {
      transactionControl: body.transactionControl ?? body.control ?? body,
      credentialRef: body.credentialRef,
      egress: makeEgress(app, body.credentialRef, body),
      logger,
      flow: body.flow,
      input: body.input,
      env: body.env,
      snapshot: body.snapshot,
      engine: body.engine,
      mobileSession: body.mobileSession,
      forceNow: body.forceNow
    };
    const summary = await app.sniper2.runFullPipeline(taskId, ctx);
    return sendJson(res, 200, summary);
  }
  const sniper3GetMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)$/);
  if (sniper3GetMatch && req.method === 'GET') {
    const watchId = decodeURIComponent(sniper3GetMatch[1]);
    return sendJson(res, 200, app.sniper3.getWatch(watchId));
  }
  const sniper3SignalMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)\/signal$/);
  if (sniper3SignalMatch && req.method === 'POST') {
    const body = await readJson(req);
    const watchId = decodeURIComponent(sniper3SignalMatch[1]);
    const result = await app.sniper3.fireSignal(watchId, body.snapshot ?? body);
    return sendJson(res, 200, result);
  }
  const sniper3ConfirmMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)\/confirm$/);
  if (sniper3ConfirmMatch && req.method === 'POST') {
    const watchId = decodeURIComponent(sniper3ConfirmMatch[1]);
    const result = await app.sniper3.confirmFromUser(watchId);
    return sendJson(res, 200, result);
  }
  const sniper3DismissMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)\/dismiss$/);
  if (sniper3DismissMatch && req.method === 'POST') {
    const watchId = decodeURIComponent(sniper3DismissMatch[1]);
    await app.sniper3.dismissConfirmation(watchId);
    return sendJson(res, 200, { ok: true });
  }
  const sniper3ResultMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)\/result$/);
  if (sniper3ResultMatch && req.method === 'POST') {
    const body = await readJson(req);
    const watchId = decodeURIComponent(sniper3ResultMatch[1]);
    const view = await app.sniper3.markExecutionResult(watchId, body.result ?? body);
    return sendJson(res, 200, view);
  }
  const sniper3PauseMatch = url.pathname.match(/^\/api\/v1\/sniper3\/watches\/([^/]+)\/(pause|resume|cancel)$/);
  if (sniper3PauseMatch && req.method === 'POST') {
    const watchId = decodeURIComponent(sniper3PauseMatch[1]);
    const action = sniper3PauseMatch[2];
    const body = await readJson(req).catch(() => ({}));
    if (action === 'pause') app.sniper3.pauseWatch(watchId, body.reason);
    else if (action === 'resume') app.sniper3.resumeWatch(watchId);
    else app.sniper3.cancelWatch(watchId);
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/ws/v1/events') {
    res.writeHead(426, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'upgrade_required', message: 'Install ws/Fastify stack to enable native WebSocket transport.' }));
  }
  sendJson(res, 404, { error: 'not_found' });
}

function handleWsUpgrade(req, socket, head, app) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/ws/v1/events') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  const subscriptions = new Set();
  const since = Number(url.searchParams.get('since') ?? 0);
  const unsubscribe = app.eventBus.subscribe({ topic: '*', tenantId: app.tenantId }, (event) => {
    if (!matchesAny(subscriptions, event.topic)) return;
    sendWsJson(socket, { type: 'event', id: event.id, topic: event.topic, at: event.at, tenantId: event.tenantId, payload: event.payload });
  });

  socket.on('data', (chunk) => {
    const frames = decodeWsFrames(Buffer.concat([head?.length ? head : Buffer.alloc(0), chunk]));
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        unsubscribe();
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeWsFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      handleWsMessage(frame.payload.toString('utf8'), { app, socket, subscriptions, since });
    }
  });
  socket.on('close', unsubscribe);
  socket.on('error', unsubscribe);
}

function handleWsMessage(text, { app, socket, subscriptions, since }) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return sendWsJson(socket, { type: 'error', error: 'flow_validation_failed', message: 'Invalid JSON frame' });
  }
  if (message.type === 'subscribe') {
    for (const topic of message.topics ?? []) subscriptions.add(topic);
    const topics = [...subscriptions];
    for (const event of app.eventBus.replay({ since, tenantId: app.tenantId })) {
      if (matchesAny(topics, event.topic)) {
        sendWsJson(socket, { type: 'event', id: event.id, topic: event.topic, at: event.at, tenantId: event.tenantId, payload: event.payload });
      }
    }
    return sendWsJson(socket, { type: 'subscribed', topics });
  }
  if (message.type === 'unsubscribe') {
    for (const topic of message.topics ?? []) subscriptions.delete(topic);
    return sendWsJson(socket, { type: 'unsubscribed', topics: [...subscriptions] });
  }
  sendWsJson(socket, { type: 'error', error: 'flow_validation_failed', message: `Unsupported frame type: ${message.type}` });
}

function matchesAny(topics, topic) {
  const list = topics instanceof Set ? [...topics] : topics;
  return list.includes('*') || list.some((pattern) => topicMatches(pattern, topic));
}

function sendWsJson(socket, payload) {
  socket.write(encodeWsFrame(Buffer.from(JSON.stringify(payload), 'utf8')));
}

function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
  if (data.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
  }
  return frames;
}

function serveStatic(_req, res, url) {
  const webRoot = path.resolve(dirname, '../../web-ui');
  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const content = fs.readFileSync(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function makeEgress(app, credentialRef, body = {}) {
  if (body.useVaultProxy === true) {
    if (!app.vaultClient) throw codeError('vault_unavailable', 'Vault client is required for authenticated egress');
    return new VaultProxyEgress({ vaultClient: app.vaultClient, credentialRef, fallbackEgress: app.egress });
  }
  return app.egress;
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Build a TGTG-shaped RestockIntent from the friendly request body that the
 * UI / curl user submits. Maps:
 *   storeId       (商家)        → product.siteId='tgtg', product.productUrl, requiredVariants
 *   pickupDate    (日期)        → constraints.requiredVariants.pickupDate
 *   maxQuantity   (数量上限)    → constraints.maxQuantity
 *   maxUnitPriceCents          → constraints.maxUnitPrice
 *   payment.methodRef          → payment.methodRef (PaymentChannel keyed off this — same card across watches serializes via minIntervalMs)
 */
function buildTgtgRestockIntent(body = {}) {
  if (!body.storeId) throw codeError('flow_validation_failed', 'storeId is required (TGTG 商家)');
  if (!body.pickupDate) throw codeError('flow_validation_failed', 'pickupDate is required (TGTG 日期, ISO yyyy-mm-dd)');
  const maxQuantity = Number.isFinite(body.maxQuantity) ? body.maxQuantity : 1;
  if (maxQuantity < 1 || maxQuantity > 5) {
    throw codeError('flow_validation_failed', 'maxQuantity must be between 1 and 5 (TGTG 数量)');
  }
  if (!Number.isFinite(body.maxUnitPriceCents) || body.maxUnitPriceCents <= 0) {
    throw codeError('flow_validation_failed', 'maxUnitPriceCents required (TGTG 单价上限, in cents)');
  }
  if (!body.payment?.methodRef) {
    throw codeError('flow_validation_failed', 'payment.methodRef required');
  }
  const requiredVariants = {
    pickupDate: body.pickupDate,
    ...(body.timeWindow ? { timeWindow: body.timeWindow } : {}),
    ...(body.bagType ? { bagType: body.bagType } : {})
  };
  return {
    product: {
      siteId: 'tgtg',
      productUrl: `tgtg-store:${body.storeId}`,
      storeId: body.storeId,
      requiredVariants
    },
    constraints: {
      maxUnitPrice: body.maxUnitPriceCents,
      maxQuantity,
      requiredVariants
    },
    policy: {
      triggerOn: body.policy?.triggerOn ?? 'any_stock',
      requireConfirmation: body.requireConfirmation === true,
      continueAfterSuccess: body.continueAfterSuccess === true,
      maxOrders: Number.isFinite(body.maxOrders) ? body.maxOrders : 1,
      pollProfile: body.policy?.pollProfile ?? 'idle'
    },
    payment: { methodRef: body.payment.methodRef },
    shipping: body.shipping ?? { addressRef: 'pickup-in-store' },
    flow: body.flow ?? 'tgtg.reserve@1',
    fallbackBehavior: body.fallbackBehavior ?? 'continue_within_tolerance',
    priceTolerance: body.priceTolerance ?? { type: 'percent', value: 10 }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4317);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Smart Sniper listening on http://127.0.0.1:${port}`);
  });
}
