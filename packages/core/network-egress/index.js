export class DirectEgress {
  async fetch(request) {
    const controller = new AbortController();
    const timeout = request.timeoutMs
      ? setTimeout(() => controller.abort(new Error('request timeout')), request.timeoutMs)
      : null;
    try {
      const response = await globalThis.fetch(request.url, {
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body: request.body,
        signal: controller.signal
      });
      const headers = Object.fromEntries(response.headers.entries());
      const bodyText = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        headers,
        bodyText,
        json: () => JSON.parse(bodyText)
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async newBrowserContext(options = {}) {
    return {
      id: `browser-context:${Date.now()}`,
      options,
      createdAt: new Date()
    };
  }

  async releaseBrowserContext(context) {
    if (context) context.releasedAt = new Date();
  }
}

export class VaultProxyEgress {
  constructor({ vaultClient, credentialRef, fallbackEgress = new DirectEgress() }) {
    if (!vaultClient) throw new TypeError('vaultClient is required');
    if (!credentialRef) throw new TypeError('credentialRef is required');
    this.vaultClient = vaultClient;
    this.credentialRef = credentialRef;
    this.fallbackEgress = fallbackEgress;
  }

  async fetch(request) {
    return this.vaultClient.proxyAuthedRequest(this.credentialRef, request);
  }

  async newBrowserContext(options = {}) {
    return this.fallbackEgress.newBrowserContext(options);
  }

  async releaseBrowserContext(context) {
    return this.fallbackEgress.releaseBrowserContext(context);
  }
}

export class ProxyPoolEgress extends DirectEgress {
  constructor({ proxyForTenant } = {}) {
    super();
    this.proxyForTenant = proxyForTenant ?? (() => null);
  }
}
