export class InAppChannel {
  constructor({ eventBus }) {
    if (!eventBus) throw new TypeError('eventBus is required');
    this.eventBus = eventBus;
    this.name = 'in-app';
  }

  async deliver(record) {
    this.eventBus.emit({
      topic: `shared:notification:${record.scope}:${record.category}`,
      tenantId: record.tenantId,
      payload: {
        id: record.id,
        severity: record.severity,
        createdAt: record.createdAt,
        payload: record.payload
      }
    });
  }
}
