import { currentContext } from '../tenant-context/index.js';

export class ScopedLogger {
  constructor({ sink = console, level = 'info' } = {}) {
    this.sink = sink;
    this.level = level;
  }

  info(message, context = {}) {
    this.#write('info', message, undefined, context);
  }

  warn(message, context = {}) {
    this.#write('warn', message, undefined, context);
  }

  error(message, error, context = {}) {
    this.#write('error', message, error, context);
  }

  child(context = {}) {
    return new ChildLogger(this, context);
  }

  #write(level, message, error, context) {
    const active = currentContext();
    const payload = {
      level,
      message,
      at: new Date().toISOString(),
      tenantId: active.tenantId,
      requestId: active.requestId,
      traceId: active.traceId,
      ...context
    };
    if (error) {
      payload.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    this.sink[method](JSON.stringify(payload));
  }
}

class ChildLogger {
  constructor(parent, context) {
    this.parent = parent;
    this.context = context;
  }

  info(message, context = {}) {
    this.parent.info(message, { ...this.context, ...context });
  }

  warn(message, context = {}) {
    this.parent.warn(message, { ...this.context, ...context });
  }

  error(message, error, context = {}) {
    this.parent.error(message, error, { ...this.context, ...context });
  }
}

export const logger = new ScopedLogger();
