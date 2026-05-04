import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_TENANT_ID } from '../domain-types/index.js';

export function smartSniperPaths(env = process.env) {
  const appData = env.APPDATA ?? path.join(os.homedir(), '.config');
  const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache');
  return {
    data: path.join(appData, 'smart-sniper'),
    config: path.join(appData, 'smart-sniper'),
    cache: path.join(localAppData, 'smart-sniper'),
    log: path.join(localAppData, 'smart-sniper', 'Log')
  };
}

export class ConfigService {
  constructor({ basePath = smartSniperPaths().config } = {}) {
    this.basePath = basePath;
  }

  getInstanceConfig() {
    return this.#readJson(path.join(this.basePath, 'instance.json'), {
      deploymentForm: 'local',
      auth: { tokenFile: 'auth.token' }
    });
  }

  getTenantConfig(tenantId = LOCAL_TENANT_ID) {
    return this.#readJson(path.join(this.basePath, 'tenants', `${tenantId}.json`), {
      tenantId,
      polling: { profile: 'balanced', tierOverrides: {} },
      sniper1: { budgetCents: 0, defaultBumpStrategies: {} },
      sniper2: { budgetCents: 0 },
      sniper3: { budgetCents: 0, defaultStaleDays: 30 },
      paymentChannels: []
    });
  }

  #readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }
}

export function checkLongPathSupport() {
  if (process.platform !== 'win32') return true;
  const probe = path.join(os.tmpdir(), 'smart-sniper-long-path-probe', 'x'.repeat(260));
  try {
    fs.mkdirSync(probe, { recursive: true });
    fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENAMETOOLONG') return false;
    throw error;
  }
}
