/**
 * Per-machine terminal sets. A state is "terminal" only within its machine —
 * `succeeded` is terminal for sniper2 but transitional for sniper3 (where it
 * branches to `continued` or `exhausted`). The exported `terminalStates` is
 * the union of every machine's terminals, kept for backward compat in code
 * that does coarse-grained terminal checks.
 */
const TERMINAL_BY_MACHINE = Object.freeze({
  sniper1Item: new Set(['lost', 'cancelled', 'expired', 'paid', 'payment_overdue']),
  sniper2ScheduledTask: new Set(['cancelled', 'missed', 'succeeded', 'payment_timeout', 'acquire_expired']),
  sniper3Watch: new Set(['cancelled', 'expired', 'exhausted']),
  acquireSettleExecution: new Set(['succeeded', 'payment_timeout', 'acquire_expired'])
});

export const terminalStates = new Set(
  Object.values(TERMINAL_BY_MACHINE).flatMap((set) => [...set])
);

const transitions = {
  sniper1Item: {
    draft: { arm: 'watching', cancel: 'cancelled' },
    watching: { arm: 'armed', cancel: 'cancelled', markExpired: 'expired' },
    armed: { executeBid: 'bidding', disarm: 'watching', cancel: 'cancelled' },
    bidding: { bidWinning: 'winning', bidOutbid: 'outbid', bidFailed: 'bid_failed' },
    winning: { tickOutbid: 'outbid', markWon: 'won', markLost: 'lost' },
    outbid: { executeBid: 'bidding', markLost: 'lost' },
    bid_failed: { executeBid: 'bidding', markLost: 'lost' },
    // v0.5 win-flow: won is transitional, must be promoted to pending_user_payment
    won: { promoteToPendingPayment: 'pending_user_payment', cancel: 'cancelled' },
    pending_user_payment: {
      userMarkPaid: 'paid',
      adapterDetectPaid: 'paid',
      paymentDeadlineHit: 'payment_overdue',
      cancel: 'cancelled'
    }
  },
  sniper2ScheduledTask: {
    draft: { configure: 'configured', cancel: 'cancelled' },
    configured: { prewarm: 'prewarming', strike: 'striking', cancel: 'cancelled' },
    prewarming: { prewarmDone: 'armed', prewarmFailed: 'missed', cancel: 'cancelled' },
    armed: { strike: 'striking', cancel: 'cancelled' },
    striking: { acquire: 'acquiring', markMissed: 'missed', cancel: 'cancelled' },
    acquiring: { acquireFailed: 'acquire_failed', acquired: 'acquired', cancel: 'cancelled' },
    acquired: { queued: 'queued_for_payment', acquireExpired: 'acquire_expired' },
    queued_for_payment: { paymentStart: 'paying', acquireExpired: 'acquire_expired' },
    paying: { paymentSucceeded: 'succeeded', paymentFailed: 'payment_failed', paymentTimeout: 'payment_timeout' },
    payment_failed: { paymentStart: 'paying', cancel: 'cancelled' }
  },
  sniper3Watch: {
    draft: { configure: 'configured', cancel: 'cancelled' },
    configured: { resume: 'monitoring', signal: 'triggered', cancel: 'cancelled' },
    monitoring: { pause: 'suspended', signal: 'triggered', markExpired: 'expired', cancel: 'cancelled' },
    suspended: { resume: 'monitoring', cancel: 'cancelled' },
    triggered: { confirm: 'confirming', execute: 'executing', cancel: 'cancelled' },
    confirming: { confirmFromUser: 'executing', timeout: 'monitoring', cancel: 'cancelled' },
    executing: { succeeded: 'succeeded', failed: 'failed', cancel: 'cancelled' },
    succeeded: { continue: 'continued', exhaust: 'exhausted' },
    failed: { continue: 'continued', exhaust: 'exhausted' },
    continued: { resume: 'monitoring', cancel: 'cancelled' }
  },
  acquireSettleExecution: {
    acquiring: { acquireFailed: 'acquire_failed', acquired: 'acquired' },
    acquired: { queued: 'queued_for_payment', acquireExpired: 'acquire_expired' },
    queued_for_payment: { paymentStart: 'paying', acquireExpired: 'acquire_expired' },
    paying: { paymentSucceeded: 'succeeded', paymentFailed: 'payment_failed', paymentTimeout: 'payment_timeout' },
    payment_failed: { retry: 'paying' }
  }
};

export function transition(machineName, state, eventName) {
  const machineTerminal = TERMINAL_BY_MACHINE[machineName];
  if (machineTerminal) {
    if (machineTerminal.has(state)) return state;
  } else if (terminalStates.has(state)) {
    return state;
  }
  return transitions[machineName]?.[state]?.[eventName] ?? state;
}

export class SimpleMachine {
  constructor(machineName, initialState, context = {}, onTransition) {
    this.machineName = machineName;
    this.state = initialState;
    this.context = structuredCloneSafe(context);
    this.onTransition = onTransition;
  }

  send(eventName, patch = {}) {
    const from = this.state;
    const to = transition(this.machineName, from, eventName);
    this.context = { ...this.context, ...patch };
    this.state = to;
    if (from !== to) this.onTransition?.({ machineName: this.machineName, from, to, eventName, context: this.context });
    return this.snapshot();
  }

  snapshot() {
    return {
      machineName: this.machineName,
      state: this.state,
      context: structuredCloneSafe(this.context)
    };
  }
}

function structuredCloneSafe(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
