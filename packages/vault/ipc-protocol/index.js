import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export function buildIpcPath(name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\smartsniper-${name}`
    : path.join(os.tmpdir(), `smartsniper-${name}.sock`);
}

export function rpcRequest(method, params = {}, id = `msg:${randomUUID()}`) {
  return { id, method, params };
}

export function rpcResult(id, result) {
  return { id, result };
}

export function rpcError(id, code, message) {
  return { id, error: { code, message } };
}

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.length - offset - 4 < length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    messages.push(JSON.parse(payload.toString('utf8')));
    offset += 4 + length;
  }
  return {
    messages,
    rest: buffer.subarray(offset)
  };
}

export class VaultClient {
  constructor({ ipcPath = buildIpcPath('vault'), timeoutMs = 5000 } = {}) {
    this.ipcPath = ipcPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params = {}) {
    const message = rpcRequest(method, params);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.ipcPath);
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(codeError('vault_unavailable', `Vault request timed out: ${method}`));
      }, this.timeoutMs);

      socket.on('connect', () => socket.write(encodeFrame(message)));
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer);
        buffer = decoded.rest;
        const response = decoded.messages.find((item) => item.id === message.id);
        if (!response) return;
        clearTimeout(timer);
        socket.end();
        if (response.error) reject(codeError('vault_unavailable', response.error.message));
        else resolve(response.result);
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(codeError('vault_unavailable', error.message));
      });
    });
  }

  proxyAuthedRequest(credentialRef, request) {
    return this.request('proxyAuthedRequest', { credentialRef, request });
  }

  injectCookiesIntoContext(credentialRef, contextId) {
    return this.request('injectCookiesIntoContext', { credentialRef, contextId });
  }

  promptForNewCredential(siteId) {
    return this.request('promptForNewCredential', { siteId });
  }

  listCredentialRefs(siteId) {
    return this.request('listCredentialRefs', { siteId });
  }

  deleteCredential(credentialRef) {
    return this.request('deleteCredential', { credentialRef });
  }

  healthCheck() {
    return this.request('healthCheck');
  }
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
