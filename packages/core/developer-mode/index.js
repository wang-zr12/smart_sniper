export const LIVE_CONFIRMATION_PHRASE = 'EXECUTE_LIVE_TRANSACTION';

export function readDeveloperMode(env = process.env) {
  const developerMode = parseFlag(env.SMART_SNIPER_DEVELOPER_MODE);
  const liveTransactionsEnabled = developerMode && parseFlag(env.SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS);
  return {
    developerMode,
    liveTransactionsEnabled,
    dryRunDefault: !liveTransactionsEnabled
  };
}

export class LiveTransactionGuard {
  constructor({ env = process.env, clock = () => new Date() } = {}) {
    this.env = env;
    this.clock = clock;
  }

  status() {
    return readDeveloperMode(this.env);
  }

  evaluate(request = {}) {
    const status = this.status();
    const requestDeveloperMode = request.developerMode === true;
    const requestExecuteLive = request.executeLive === true;
    const confirmed = request.confirmationPhrase === LIVE_CONFIRMATION_PHRASE;
    const allowed = status.developerMode && status.liveTransactionsEnabled && requestDeveloperMode && requestExecuteLive && confirmed;
    return {
      ...status,
      requestDeveloperMode,
      requestExecuteLive,
      confirmed,
      liveAllowed: allowed,
      dryRunMode: !allowed,
      evaluatedAt: this.clock()
    };
  }

  assertAllowed(request, details = {}) {
    const decision = this.evaluate(request);
    if (!decision.liveAllowed) {
      throw codeError(
        'user_cancelled',
        [
          `Live transaction blocked for ${details.action ?? 'transaction'}.`,
          'Required: SMART_SNIPER_DEVELOPER_MODE=1, SMART_SNIPER_ENABLE_LIVE_TRANSACTIONS=1,',
          'developerMode=true, executeLive=true, and the confirmation phrase.'
        ].join(' ')
      );
    }
    return decision;
  }
}

export function parseTransactionControl(body = {}, guard = new LiveTransactionGuard()) {
  const control = body.transactionControl ?? body.control ?? body;
  return guard.evaluate(control);
}

function parseFlag(value) {
  return value === true || value === '1' || String(value).toLowerCase() === 'true';
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
