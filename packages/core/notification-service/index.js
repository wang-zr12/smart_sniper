import { randomUUID } from 'node:crypto';
import { LOCAL_TENANT_ID, isErrorCode } from '../domain-types/index.js';
import { InAppChannel } from './channels/in-app.js';

const VALID_CATEGORIES = Object.freeze([
  'auction_won',
  'payment_required',
  'payment_overdue',
  'restock_signal',
  'confirmation_required',
  'task_completed',
  'task_failed',
  'budget_low',
  'system_alert',
  // v0.5+ error-handling notifications (mirrors error codes that need user push)
  'auth_required',                // 1.1 — re-login
  'captcha_required',             // 2.2 — human intervention
  'account_blocked',              // 2.3 — terminal alarm
  'payment_3ds_required',         // 3.1 — bank challenge, very high priority
  'payment_declined',             // 3.4 — change card / top up
  'vendor_refunded',              // 3.3 — money out, goods missing
  'stock_phantom'                 // 4.1 — pre-pay recheck failure
]);

const VALID_SEVERITIES = Object.freeze(['info', 'warn', 'urgent']);

const DEFAULT_CHANNELS_BY_CATEGORY = Object.freeze({
  auction_won: ['in-app'],
  payment_required: ['in-app'],
  payment_overdue: ['in-app'],
  restock_signal: ['in-app'],
  confirmation_required: ['in-app'],
  task_completed: ['in-app'],
  task_failed: ['in-app'],
  budget_low: ['in-app'],
  system_alert: ['in-app'],
  auth_required: ['in-app'],
  captcha_required: ['in-app'],
  account_blocked: ['in-app'],
  payment_3ds_required: ['in-app'],     // upgrade to ['in-app','system'] in M5
  payment_declined: ['in-app'],
  vendor_refunded: ['in-app'],
  stock_phantom: ['in-app']
});

export class NotificationService {
  constructor({ eventBus, scheduler, channels, defaults, tenantId = LOCAL_TENANT_ID, clock = () => new Date() } = {}) {
    if (!eventBus) throw new TypeError('eventBus is required');
    this.eventBus = eventBus;
    this.scheduler = scheduler ?? null;
    this.tenantId = tenantId;
    this.clock = clock;
    this.records = new Map();
    this.reminderHandles = new Map();
    this.defaults = { ...DEFAULT_CHANNELS_BY_CATEGORY, ...(defaults ?? {}) };
    const inAppChannel = new InAppChannel({ eventBus });
    this.channels = new Map([['in-app', inAppChannel], ...(channels ? Object.entries(channels) : [])]);
  }

  registerChannel(name, channel) {
    if (typeof channel?.deliver !== 'function') {
      throw new TypeError('channel must implement deliver(record)');
    }
    this.channels.set(name, channel);
  }

  async notify(request) {
    const validated = validateRequest(request, this.defaults, this.tenantId);
    const id = `notif:${randomUUID()}`;
    const now = this.clock();
    const record = Object.freeze({
      id,
      tenantId: validated.tenantId,
      scope: validated.scope,
      category: validated.category,
      severity: validated.severity,
      payload: deepFreeze({ ...validated.payload }),
      channels: Object.freeze([...validated.channels]),
      createdAt: now,
      reminderAt: validated.reminderAt ?? null,
      firedReminders: [],
      dismissedAt: null
    });
    this.records.set(id, { ...record, firedReminders: [] });
    await this.#dispatch(record);
    if (validated.reminderAt) this.#scheduleReminder(record);
    return id;
  }

  async cancelReminder(id) {
    const handle = this.reminderHandles.get(id);
    if (handle && this.scheduler?.cancel) this.scheduler.cancel(handle);
    this.reminderHandles.delete(id);
  }

  list(filter = {}) {
    const tenantId = filter.tenantId ?? this.tenantId;
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .filter((record) => !filter.scope || record.scope === filter.scope)
      .filter((record) => !filter.category || record.category === filter.category)
      .filter((record) => !filter.unreadOnly || !record.dismissedAt)
      .filter((record) => !filter.since || record.createdAt.getTime() >= new Date(filter.since).getTime())
      .map((record) => ({ ...record }));
  }

  dismiss(id) {
    const record = this.records.get(id);
    if (!record) return null;
    record.dismissedAt = this.clock();
    this.eventBus.emit({
      topic: 'shared:notification:dismissed',
      tenantId: record.tenantId,
      payload: { id, dismissedAt: record.dismissedAt }
    });
    return record;
  }

  async #dispatch(record) {
    const errors = [];
    for (const channelName of record.channels) {
      const channel = this.channels.get(channelName);
      if (!channel) {
        errors.push(`channel ${channelName} not registered`);
        continue;
      }
      try {
        await channel.deliver(record);
      } catch (error) {
        errors.push(`channel ${channelName}: ${error.message}`);
      }
    }
    this.eventBus.emit({
      topic: 'shared:notification:created',
      tenantId: record.tenantId,
      payload: {
        id: record.id,
        scope: record.scope,
        category: record.category,
        severity: record.severity,
        channels: [...record.channels],
        createdAt: record.createdAt,
        payload: record.payload
      }
    });
    if (record.severity === 'urgent') {
      this.eventBus.emit({
        topic: 'shared:audit:event',
        tenantId: record.tenantId,
        payload: { kind: 'notification_urgent', id: record.id, category: record.category, at: record.createdAt }
      });
    }
    if (errors.length) {
      const error = new Error(errors.join('; '));
      error.code = 'notification_dispatch_failed';
      throw error;
    }
  }

  #scheduleReminder(record) {
    if (!this.scheduler?.schedule) return;
    const handle = this.scheduler.schedule({
      triggerAt: new Date(record.reminderAt),
      leadTimeMs: 0,
      warmupMs: 0,
      onTrigger: async () => {
        const stored = this.records.get(record.id);
        if (!stored || stored.dismissedAt) return;
        stored.firedReminders.push({ at: this.clock() });
        this.eventBus.emit({
          topic: 'shared:notification:reminder',
          tenantId: record.tenantId,
          payload: { id: record.id, parentId: record.id, firedAt: this.clock(), payload: record.payload }
        });
      }
    });
    this.reminderHandles.set(record.id, handle);
  }
}

export const NOTIFY_DEFAULT_CHANNELS = DEFAULT_CHANNELS_BY_CATEGORY;
export const NOTIFY_CATEGORIES = VALID_CATEGORIES;

function validateRequest(request, defaults, defaultTenantId) {
  if (!request) throw new TypeError('notify request is required');
  if (!request.scope) throw new TypeError('scope is required');
  if (!VALID_CATEGORIES.includes(request.category)) {
    throw new TypeError(`Invalid category: ${request.category}`);
  }
  if (!VALID_SEVERITIES.includes(request.severity)) {
    throw new TypeError(`Invalid severity: ${request.severity}`);
  }
  const channels = request.channels && request.channels.length ? request.channels : (defaults[request.category] ?? ['in-app']);
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError('channels must be a non-empty array');
  }
  if (request.code && !isErrorCode(request.code)) {
    throw new TypeError(`Invalid error code attached to notification: ${request.code}`);
  }
  return {
    scope: request.scope,
    category: request.category,
    severity: request.severity,
    payload: request.payload ?? {},
    channels,
    reminderAt: request.reminderAt ?? null,
    tenantId: request.tenantId ?? defaultTenantId
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
