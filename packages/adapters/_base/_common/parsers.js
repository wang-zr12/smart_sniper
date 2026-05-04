export function parseByRule(source, rule) {
  if (!rule) return undefined;
  if (rule.type === 'regex') return parseRegex(source, rule);
  if (rule.type === 'regex-presence') return rule.pattern.test(asString(source));
  if (rule.type === 'jsonpath') return parseJsonPath(source, rule);
  if (rule.type === 'response-header') return parseResponseHeader(source, rule);
  if (rule.type === 'response-date') return parseResponseDate(source);
  if (rule.type === 'css') {
    throw new Error('css selector parsing requires a DOM library; use a hooks override until M+');
  }
  throw new Error(`Unknown parser rule type: ${rule.type}`);
}

function asString(source) {
  if (typeof source === 'string') return source;
  if (source?.bodyText != null) return source.bodyText;
  return '';
}

function parseRegex(source, rule) {
  const text = asString(source);
  const m = text.match(rule.pattern);
  if (!m) return undefined;
  const raw = m[1] ?? m[0];
  if (rule.units === 'cents') {
    const num = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(num) ? Math.round(num) : undefined;
  }
  if (rule.units === 'dollars') {
    const num = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(num) ? Math.round(num * 100) : undefined;
  }
  if (rule.units === 'integer') {
    const num = Number.parseInt(String(raw).replace(/[^0-9\-]/g, ''), 10);
    return Number.isFinite(num) ? num : undefined;
  }
  if (rule.units === 'date' || (rule.format && String(rule.format).startsWith('tz='))) {
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return raw;
}

function parseJsonPath(source, rule) {
  const data = typeof source === 'string' ? safeJson(source) : (source?.bodyText ? safeJson(source.bodyText) : source);
  return jsonPath(data, rule.path);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function jsonPath(obj, path) {
  if (!obj || !path) return undefined;
  const segments = String(path).replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean);
  return segments.reduce((acc, key) => acc?.[key], obj);
}

function parseResponseHeader(source, rule) {
  const headers = source?.headers ?? {};
  return headers[rule.name?.toLowerCase()] ?? headers[rule.name];
}

function parseResponseDate(source) {
  const headers = source?.headers ?? {};
  const raw = headers.date ?? headers.Date;
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
