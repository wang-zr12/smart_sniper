import { currentTenantId } from '../tenant-context/index.js';

export class InMemoryBus {
  constructor({ replayLimit = 1000 } = {}) {
    this.replayLimit = replayLimit;
    this.nextId = 1;
    this.events = [];
    this.subscribers = new Map();
  }

  emit(event) {
    const envelope = {
      id: this.nextId++,
      topic: event.topic,
      at: event.at ? new Date(event.at) : new Date(),
      tenantId: event.tenantId ?? currentTenantId(),
      payload: event.payload ?? {}
    };
    this.events.push(envelope);
    if (this.events.length > this.replayLimit) this.events.shift();

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.tenantId && subscriber.tenantId !== envelope.tenantId) continue;
      if (!topicMatches(subscriber.topic, envelope.topic)) continue;
      subscriber.handler(envelope);
    }
    return envelope;
  }

  subscribe(filter, handler) {
    const id = `sub:${this.subscribers.size + 1}:${Date.now()}`;
    const subscriber = {
      topic: typeof filter === 'string' ? filter : filter.topic ?? '*',
      tenantId: typeof filter === 'string' ? undefined : filter.tenantId,
      handler
    };
    this.subscribers.set(id, subscriber);
    return () => this.subscribers.delete(id);
  }

  replay({ since = 0, topic = '*', tenantId } = {}) {
    return this.events.filter((event) => {
      if (event.id <= since) return false;
      if (tenantId && event.tenantId !== tenantId) return false;
      return topicMatches(topic, event.topic);
    });
  }
}

export function topicMatches(pattern, topic) {
  if (!pattern || pattern === '*') return true;
  if (pattern === topic) return true;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(topic);
}

export const eventBus = new InMemoryBus();
