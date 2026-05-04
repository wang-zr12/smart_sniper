import { randomUUID } from 'node:crypto';

export class InMemoryJobQueue {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.jobs = new Map();
  }

  async enqueue(job) {
    return this.schedule(job, new Date(this.clock()));
  }

  async schedule(job, runAt) {
    const id = `job:${randomUUID()}`;
    const record = {
      id,
      job,
      runAt: new Date(runAt),
      status: 'scheduled',
      error: null,
      timer: null
    };
    this.jobs.set(id, record);
    const delay = Math.max(0, record.runAt.getTime() - this.clock());
    record.timer = setTimeout(() => this.#run(id), delay);
    return id;
  }

  async cancel(jobId) {
    const record = this.jobs.get(jobId);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    record.status = 'cancelled';
  }

  async getStatus(jobId) {
    const record = this.jobs.get(jobId);
    if (!record) return { id: jobId, status: 'missing' };
    return {
      id: jobId,
      status: record.status,
      runAt: record.runAt,
      error: record.error
    };
  }

  async #run(jobId) {
    const record = this.jobs.get(jobId);
    if (!record || record.status !== 'scheduled') return;
    record.status = 'running';
    try {
      if (typeof record.job.run === 'function') await record.job.run(record.job);
      record.status = 'succeeded';
    } catch (error) {
      record.error = error;
      record.status = 'failed';
    }
  }
}
