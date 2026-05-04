import { createHash } from 'node:crypto';
import { assertMoney, SniperScopes } from '../domain-types/index.js';

const SIGNS = Object.freeze({
  transfer_in: 1,
  transfer_out: -1,
  commit: -1,
  release: 1,
  spend: -1
});

export class BudgetEngine {
  constructor(scope, { tenantId = 'local-user', auditLog } = {}) {
    if (!SniperScopes.includes(scope)) throw new TypeError(`Invalid budget scope: ${scope}`);
    this.scope = scope;
    this.tenantId = tenantId;
    this.auditLog = auditLog;
    this.entries = [];
    this.nextId = 1;
  }

  setTotalBudget(amountCents, reason = 'set_total_budget') {
    assertMoney(amountCents, 'amountCents');
    const current = this.totalCents();
    if (amountCents > current) {
      return this.append('pool', 'transfer_in', amountCents - current, reason);
    }
    if (amountCents < current) {
      return this.append('pool', 'transfer_out', current - amountCents, reason);
    }
    return null;
  }

  commit(taskId, amountCents, reason = 'commit') {
    assertMoney(amountCents, 'amountCents');
    if (this.availableCents() < amountCents) throw codeError('budget_exceeded', 'Not enough available budget');
    return this.append(taskId, 'commit', amountCents, reason);
  }

  release(taskId, amountCents, reason = 'release') {
    assertMoney(amountCents, 'amountCents');
    if (this.committedCents(taskId) < amountCents) throw codeError('budget_exceeded', 'Release exceeds committed budget');
    return this.append(taskId, 'release', amountCents, reason);
  }

  spend(taskId, amountCents, reason = 'spend') {
    assertMoney(amountCents, 'amountCents');
    if (this.committedCents(taskId) < amountCents) throw codeError('budget_exceeded', 'Spend exceeds committed budget');
    return this.append(taskId, 'spend', amountCents, reason);
  }

  append(taskId, eventType, amountCents, reason, relatedEntryId) {
    assertMoney(amountCents, 'amountCents');
    if (!(eventType in SIGNS)) throw new TypeError(`Unknown budget event: ${eventType}`);
    const prevHash = this.entries.at(-1)?.hash ?? null;
    const createdAt = new Date();
    const hashInput = {
      id: this.nextId,
      tenantId: this.tenantId,
      scope: this.scope,
      taskId,
      eventType,
      amountCents,
      reason,
      relatedEntryId,
      createdAt: createdAt.toISOString(),
      prevHash
    };
    const entry = Object.freeze({
      id: this.nextId++,
      tenantId: this.tenantId,
      scope: this.scope,
      taskId,
      eventType,
      amountCents,
      reason,
      relatedEntryId,
      createdAt,
      prevHash,
      hash: hashBudgetEntry(hashInput)
    });
    this.entries.push(entry);
    this.auditLog?.({
      scope: this.scope,
      category: 'budget',
      payload: entry,
      at: entry.createdAt
    });
    return entry;
  }

  ledger() {
    return [...this.entries];
  }

  totalCents() {
    return sum(this.entries.filter((entry) => entry.eventType.startsWith('transfer')));
  }

  spentCents(taskId) {
    return this.entries
      .filter((entry) => entry.eventType === 'spend')
      .filter((entry) => !taskId || entry.taskId === taskId)
      .reduce((total, entry) => total + entry.amountCents, 0);
  }

  committedCents(taskId) {
    return this.entries
      .filter((entry) => !taskId || entry.taskId === taskId)
      .reduce((total, entry) => {
        if (entry.eventType === 'commit') return total + entry.amountCents;
        if (entry.eventType === 'release') return total - entry.amountCents;
        if (entry.eventType === 'spend') return total - entry.amountCents;
        return total;
      }, 0);
  }

  availableCents() {
    return this.totalCents() - this.committedCents() - this.spentCents();
  }

  snapshot() {
    return {
      scope: this.scope,
      totalCents: this.totalCents(),
      committedCents: this.committedCents(),
      spentCents: this.spentCents(),
      availableCents: this.availableCents()
    };
  }

  verifyHashChain() {
    let prevHash = null;
    for (const entry of this.entries) {
      const expected = hashBudgetEntry({
        id: entry.id,
        tenantId: entry.tenantId,
        scope: entry.scope,
        taskId: entry.taskId,
        eventType: entry.eventType,
        amountCents: entry.amountCents,
        reason: entry.reason,
        relatedEntryId: entry.relatedEntryId,
        createdAt: entry.createdAt.toISOString(),
        prevHash
      });
      if (entry.prevHash !== prevHash || entry.hash !== expected) return false;
      prevHash = entry.hash;
    }
    return true;
  }
}

function sum(entries) {
  return entries.reduce((total, entry) => total + entry.amountCents * SIGNS[entry.eventType], 0);
}

function codeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hashBudgetEntry(entry) {
  return createHash('sha256')
    .update(JSON.stringify(entry))
    .digest('hex');
}
