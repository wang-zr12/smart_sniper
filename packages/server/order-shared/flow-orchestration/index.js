const SELECTOR_PREFIXES = ['css=', 'xpath=', 'text=', 'text~=', 'id=', 'role=', 'nth='];

/**
 * @typedef {'tap' | 'input' | 'select' | 'assert' | 'wait' | 'navigate' | 'navigate_with_state' | 'capture' | 'condition' | 'abort' | 'humanize' | 'checkpoint'} FlowAction
 * @typedef {Object} FlowStep
 * @property {string} id
 * @property {FlowAction} action
 * @property {string} [selector]
 * @property {string} [value]
 * @property {string} [capture_as]
 * @property {Object} [capture_field]
 * @typedef {Object} FlowScript
 * @property {string} flow_id
 * @property {number} version
 * @property {string} target
 * @property {'web' | 'mobile-android'} platform
 * @property {{acquire: FlowStep[], settle: FlowStep[]}} phases
 */

export function parseFlowText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  return parseRestrictedYaml(trimmed);
}

export function validateFlow(flow, adapterCapabilities) {
  const errors = [];
  if (!flow.flow_id) errors.push('flow_id is required');
  if (!Number.isInteger(flow.version)) errors.push('version must be an integer');
  if (!flow.target) errors.push('target is required');
  if (!['web', 'mobile-android'].includes(flow.platform)) errors.push('platform must be web or mobile-android');
  if (!flow.phases?.acquire?.length) errors.push('phases.acquire is required');
  if (!flow.phases?.settle?.length) errors.push('phases.settle is required');
  if (adapterCapabilities && !adapterCapabilities.supportedFlowVersions.includes(flow.version)) {
    errors.push('flow_version_unsupported');
  }

  const steps = [...(flow.phases?.acquire ?? []), ...(flow.phases?.settle ?? [])];
  const ids = new Set();
  for (const step of steps) {
    if (!step.id) errors.push('step id is required');
    if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.action) errors.push(`step ${step.id} action is required`);
    validateSelector(step.selector, errors);
    validateSelector(step.wait_for?.selector, errors);
  }

  const lastAcquire = flow.phases?.acquire?.at(-1);
  if (lastAcquire?.capture_as !== 'reservation_token') {
    errors.push('acquire phase must end by capturing reservation_token');
  }
  const firstSettle = flow.phases?.settle?.[0];
  if (firstSettle?.id !== 'validate_reservation' || firstSettle?.action !== 'navigate_with_state' || firstSettle?.use !== 'reservation_token') {
    errors.push('settle phase must start with validate_reservation navigate_with_state using reservation_token');
  }

  const declared = new Set((flow.variables ?? []).map((variable) => variable.name));
  const references = JSON.stringify(flow).match(/\$\{input\.([a-zA-Z0-9_]+)\}/g) ?? [];
  for (const ref of references) {
    const name = ref.match(/\$\{input\.([a-zA-Z0-9_]+)\}/)[1];
    if (!declared.has(name)) errors.push(`variable referenced but not declared: ${name}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function interpolate(value, context) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(input|captured|env)\.([a-zA-Z0-9_]+)\}/g, (_match, source, key) => {
    const bag = context[source] ?? {};
    if (!(key in bag)) throw new Error(`Interpolation value missing: ${source}.${key}`);
    return String(bag[key]);
  });
}

export async function executeFlow(flow, engine, context = {}) {
  const captured = {};
  await executePhase(flow, 'acquire', engine, { ...context, captured });
  await executePhase(flow, 'settle', engine, { ...context, captured });
  return captured;
}

export async function executePhase(flow, phase, engine, context = {}) {
  const captured = { ...(context.captured ?? {}) };
  const executionState = context.executionState ?? { captured, inputs: {}, checkpoints: [] };
  for (const step of flow.phases[phase] ?? []) {
    const result = await engine.runStep(step, { ...context, captured, executionState, phase });
    if (step.capture_as) captured[step.capture_as] = result.value;
  }
  return captured;
}

function validateSelector(selector, errors) {
  if (!selector) return;
  if (selector.includes('=')) {
    if (!SELECTOR_PREFIXES.some((prefix) => selector.startsWith(prefix))) {
      errors.push(`unknown selector prefix: ${selector}`);
    }
  }
}

function parseRestrictedYaml(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const raw of lines) {
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error('Restricted YAML parser expected an array parent');
      const item = parseInlineObject(line.slice(2));
      parent.push(item);
      if (typeof item === 'object') stack.push({ indent, value: item });
      continue;
    }
    const [key, ...rest] = line.split(':');
    const valueText = rest.join(':').trim();
    if (valueText === '') {
      const nextIsArray = lines.some((candidate) => candidate.match(/^\s*/)[0].length > indent && candidate.trim().startsWith('- '));
      parent[key] = nextIsArray ? [] : {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(valueText);
    }
  }
  return root;
}

function parseInlineObject(text) {
  if (!text.includes(':')) return parseScalar(text);
  const [key, ...rest] = text.split(':');
  return { [key.trim()]: parseScalar(rest.join(':').trim()) };
}

function parseScalar(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^\d+$/.test(text)) return Number(text);
  return text.replace(/^['"]|['"]$/g, '');
}
