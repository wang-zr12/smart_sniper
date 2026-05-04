import { AsyncLocalStorage } from 'node:async_hooks';
import { LOCAL_TENANT_ID } from '../domain-types/index.js';

const storage = new AsyncLocalStorage();

export function withRequestContext(context, fn) {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, fn);
}

export function withTenant(tenantId, fn) {
  if (!tenantId) throw new TypeError('tenantId is required');
  return withRequestContext({ tenantId }, fn);
}

export function currentContext() {
  return storage.getStore() ?? { tenantId: LOCAL_TENANT_ID };
}

export function currentTenantId() {
  return currentContext().tenantId ?? LOCAL_TENANT_ID;
}

export function currentRequestId() {
  return currentContext().requestId;
}

export function requireTenant() {
  const tenantId = currentTenantId();
  if (!tenantId) throw new Error('No tenant context active');
  return tenantId;
}
