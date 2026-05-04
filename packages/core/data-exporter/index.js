import { Readable } from 'node:stream';

export class JsonDataExporter {
  constructor(providers = {}) {
    this.providers = providers;
  }

  async exportAll(tenantId, format = 'json') {
    const payload = {};
    for (const [name, provider] of Object.entries(this.providers)) {
      payload[name] = await provider({ tenantId });
    }
    return this.#stream(payload, format);
  }

  async exportRange(tenantId, scope, range, format = 'json') {
    const provider = this.providers[scope];
    const payload = provider ? await provider({ tenantId, range }) : [];
    return this.#stream({ scope, tenantId, range, rows: payload }, format);
  }

  async importFrom(_tenantId, _archive) {
    return {
      importedRows: 0,
      skippedRows: 0,
      warnings: ['Import is intentionally disabled in the zero-dependency scaffold.']
    };
  }

  #stream(payload, format) {
    if (format === 'csv') {
      return Readable.from([toCsv(payload.rows ?? payload)]);
    }
    return Readable.from([JSON.stringify(payload, null, 2)]);
  }
}

function toCsv(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const headers = [...new Set(list.flatMap((row) => Object.keys(row ?? {})))];
  return [
    headers.join(','),
    ...list.map((row) => headers.map((header) => JSON.stringify(row?.[header] ?? '')).join(','))
  ].join('\n');
}
