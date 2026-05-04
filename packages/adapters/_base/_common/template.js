export function renderTemplate(template, values = {}) {
  if (template == null) return template;
  return String(template).replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    if (key in values) return String(values[key]);
    throw new Error(`Template variable not provided: ${key}`);
  });
}

export function renderBody(body, values = {}) {
  if (body == null) return undefined;
  if (typeof body === 'string') return renderTemplate(body, values);
  const rendered = {};
  for (const [k, v] of Object.entries(body)) {
    rendered[k] = typeof v === 'string' ? renderTemplate(v, values) : v;
  }
  return rendered;
}
