export class LocalMobileBridge {
  constructor({ path = 'local-usb' } = {}) {
    this.path = path;
    this.sessions = new Map();
  }

  async acquireSession(options = {}) {
    const session = new MobileSession({ path: this.path, options });
    this.sessions.set(session.id, session);
    return session;
  }

  async releaseSession(session) {
    session.released = true;
    this.sessions.delete(session.id);
  }
}

export class CloudEmulatorPool extends LocalMobileBridge {
  constructor({ capacity = 5 } = {}) {
    super({ path: 'cloud-emulator' });
    this.capacity = capacity;
  }

  hasCapacity() {
    return this.sessions.size < this.capacity;
  }
}

export class MobileSession {
  constructor({ path, options }) {
    this.id = `mobile-session:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.path = path;
    this.options = options;
    this.installedApps = [];
  }

  async installApp(apkRef) {
    this.installedApps.push(apkRef);
  }

  async loginWithCredential(credRef) {
    this.credentialRef = credRef;
  }

  async runFlowStep(step) {
    return { ok: true, stepId: step.id, value: step.capture_as ? `captured:${step.capture_as}` : undefined };
  }

  async captureScreenshot() {
    return new Blob([]);
  }

  async captureXmlHierarchy() {
    return '<hierarchy />';
  }
}

export function selectMobileExecution(context) {
  if (context.deploymentForm === 'local') {
    if (context.hasUsbConnectedAndroid) return 'local-usb';
    if (context.hasLocalEmulatorRunning) return 'cloud-emulator';
    return null;
  }
  if (context.deploymentForm === 'saas') {
    return context.cloudEmulatorPool?.hasCapacity() ? 'cloud-emulator' : null;
  }
  return null;
}
