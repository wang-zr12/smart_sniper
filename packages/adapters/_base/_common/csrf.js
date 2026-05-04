/**
 * Resolve a CSRF token per site config and return headers to inject.
 * Supported sources: cookie, meta, hidden-form. injectAs values like
 * "header:X-Csrf-Token" or "field:csrf" tell the caller where to put it.
 */
export async function extractCsrf(rule, ctx = {}) {
  if (!rule) return {};
  const value = await readToken(rule, ctx);
  if (!value) return {};
  return materializeInjection(rule.injectAs, value);
}

async function readToken(rule, ctx) {
  if (rule.source === 'cookie') {
    const cookies = ctx.cookies ?? ctx.executionState?.cookies ?? {};
    return cookies[rule.name];
  }
  if (rule.source === 'meta' || rule.source === 'hidden-form') {
    const html = ctx.lastResponse?.bodyText ?? ctx.executionState?.lastResponse?.bodyText ?? '';
    const escapedName = String(rule.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = rule.source === 'meta'
      ? new RegExp(`<meta[^>]+name=["']${escapedName}["'][^>]+content=["']([^"']+)["']`, 'i')
      : new RegExp(`<input[^>]+name=["']${escapedName}["'][^>]+value=["']([^"']+)["']`, 'i');
    const m = html.match(pattern);
    return m ? m[1] : undefined;
  }
  if (rule.source === 'static') {
    return rule.value;
  }
  return undefined;
}

function materializeInjection(spec, value) {
  if (!spec) return {};
  const m = String(spec).match(/^(header|field):(.+)$/);
  if (!m) return {};
  const [, kind, name] = m;
  if (kind === 'header') return { headers: { [name]: value } };
  if (kind === 'field') return { fields: { [name]: value } };
  return {};
}

/**
 * Convenience helper: returns a flat headers object suitable for spreading into
 * a request.headers. Drops field-style csrf (caller must merge fields manually).
 */
export async function csrfHeaders(rule, ctx) {
  const out = await extractCsrf(rule, ctx);
  return out.headers ?? {};
}
