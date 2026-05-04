export class TenantScopedDao {
  constructor({ tenantId, rows = [] }) {
    if (!tenantId) throw new TypeError('tenantId is required');
    this.tenantId = tenantId;
    this.rows = rows;
  }

  insert(row) {
    const record = { ...row, tenantId: this.tenantId };
    this.rows.push(record);
    return record;
  }

  list(predicate = () => true) {
    return this.rows.filter((row) => row.tenantId === this.tenantId).filter(predicate);
  }

  get(id) {
    return this.rows.find((row) => row.tenantId === this.tenantId && row.id === id) ?? null;
  }

  update(id, patch) {
    const row = this.get(id);
    if (!row) return null;
    Object.assign(row, patch, { tenantId: this.tenantId });
    return row;
  }
}

export class InMemoryPersistence {
  constructor() {
    this.tables = new Map();
  }

  dao(tableName, tenantId) {
    if (!this.tables.has(tableName)) this.tables.set(tableName, []);
    return new TenantScopedDao({ tenantId, rows: this.tables.get(tableName) });
  }
}
