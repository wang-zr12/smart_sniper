import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore } from '../../core/credential-store/index.js';
import { DirectEgress } from '../../core/network-egress/index.js';
import { buildIpcPath, decodeFrames, encodeFrame, rpcError, rpcResult } from '../ipc-protocol/index.js';
import { LOCAL_TENANT_ID } from '../../core/domain-types/index.js';

export function createVaultHandlers({ store = new InMemoryCredentialStore(), egress = new DirectEgress(), startedAt = Date.now() } = {}) {
  return {
    async healthCheck() {
      const credentials = await store.list(LOCAL_TENANT_ID);
      return { ok: true, uptime: Date.now() - startedAt, storedCredentialsCount: credentials.length };
    },
    async listCredentialRefs(params = {}) {
      return store.list(LOCAL_TENANT_ID, params.siteId);
    },
    async promptForNewCredential(params = {}) {
      return store.store(LOCAL_TENANT_ID, null, { kind: 'password', siteId: params.siteId ?? 'unknown', username: '', password: '' }, {
        siteId: params.siteId ?? 'unknown',
        label: params.label ?? 'New credential'
      });
    },
    async deleteCredential(params = {}) {
      await store.delete(LOCAL_TENANT_ID, params.credentialRef);
      return { ok: true };
    },
    async proxyAuthedRequest(params = {}) {
      const secret = await store.retrieve(LOCAL_TENANT_ID, params.credentialRef);
      const request = withAuthMaterial(params.request, secret);
      return egress.fetch(request);
    },
    async injectCookiesIntoContext() {
      return { ok: true };
    }
  };
}

function withAuthMaterial(request = {}, secret) {
  const headers = { ...(request.headers ?? {}) };
  if (secret.kind === 'cookie') {
    headers.cookie = secret.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
  if (secret.kind === 'oauth') {
    headers.authorization = `Bearer ${secret.accessToken}`;
  }
  if (secret.kind === 'wallet') {
    headers.authorization = `Bearer ${secret.sessionToken}`;
  }
  if (secret.kind === 'password' || secret.kind === 'creditcard') {
    throw Object.assign(new Error('Stored credential type cannot be injected into HTTP requests automatically'), { code: -32603 });
  }
  return { ...request, headers };
}

export function startVaultDaemon({ ipcPath = buildIpcPath('vault'), handlers = createVaultHandlers() } = {}) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        try {
          const handler = handlers[message.method];
          if (!handler) throw Object.assign(new Error(`Unknown method: ${message.method}`), { code: -32601 });
          socket.write(encodeFrame(rpcResult(message.id, await handler(message.params))));
        } catch (error) {
          socket.write(encodeFrame(rpcError(message.id, error.code ?? -32603, error.message)));
        }
      }
    });
  });
  server.listen(ipcPath);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startVaultDaemon();
}
