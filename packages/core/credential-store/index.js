import { cloneJson, makeCredentialRef } from '../domain-types/index.js';

export class InMemoryCredentialStore {
  constructor() {
    this.records = new Map();
  }

  async store(tenantId, ref, secret, metadata = {}) {
    const credentialRef = ref ?? makeCredentialRef();
    const key = this.#key(tenantId, credentialRef);
    const now = new Date();
    this.records.set(key, {
      tenantId,
      ref: credentialRef,
      siteId: metadata.siteId ?? secret.siteId ?? 'unknown',
      kind: secret.kind,
      label: metadata.label ?? `${metadata.siteId ?? secret.siteId ?? 'credential'} ${secret.kind}`,
      createdAt: metadata.createdAt ?? now,
      lastUsedAt: metadata.lastUsedAt,
      secret: cloneJson(secret)
    });
    return credentialRef;
  }

  async retrieve(tenantId, ref) {
    const record = this.records.get(this.#key(tenantId, ref));
    if (!record) throw codeError('credential_not_found', `Credential not found: ${ref}`);
    record.lastUsedAt = new Date();
    return cloneJson(record.secret);
  }

  async list(tenantId, siteId) {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .filter((record) => !siteId || record.siteId === siteId)
      .map(({ ref, siteId, kind, label, createdAt, lastUsedAt }) => ({
        ref,
        siteId,
        kind,
        label,
        createdAt,
        lastUsedAt
      }));
  }

  async delete(tenantId, ref) {
    this.records.delete(this.#key(tenantId, ref));
  }

  #key(tenantId, ref) {
    return `${tenantId}:${ref}`;
  }
}

export class KeychainBackedStore extends InMemoryCredentialStore {
  constructor(opts = {}) {
    super();
    this.backend = opts.backend ?? 'memory-placeholder';
  }
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
