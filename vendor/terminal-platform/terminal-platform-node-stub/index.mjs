const unavailable = () => {
  throw new Error(
    'terminal-platform-node native runtime is not installed. Set CLAUDE_TERMINAL_PLATFORM_ROOT to a built terminal-platform checkout.'
  );
};

export class TerminalNodeSubscription {
  constructor(subscriptionId = 'install-time-stub') {
    this.subscriptionId = subscriptionId;
  }

  async nextEvent() {
    return null;
  }

  async close() {}

  async pump() {}

  async *[Symbol.asyncIterator]() {}
}

export class TerminalNodeClient {
  constructor(address) {
    this.address = address;
  }

  static fromRuntimeSlug(slug) {
    return new TerminalNodeClient(`stub://runtime/${slug}`);
  }

  static fromNamespacedAddress(value) {
    return new TerminalNodeClient(value);
  }

  static fromFilesystemPath(value) {
    return new TerminalNodeClient(value);
  }

  async close() {}
  bindingVersion() {
    return unavailable();
  }
  handshakeInfo() {
    return unavailable();
  }
  listSessions() {
    return unavailable();
  }
  listSavedSessions() {
    return unavailable();
  }
  discoverSessions() {
    return unavailable();
  }
  backendCapabilities() {
    return unavailable();
  }
  createNativeSession() {
    return unavailable();
  }
  importSession() {
    return unavailable();
  }
  savedSession() {
    return unavailable();
  }
  deleteSavedSession() {
    return unavailable();
  }
  pruneSavedSessions() {
    return unavailable();
  }
  restoreSavedSession() {
    return unavailable();
  }
  attachSession() {
    return unavailable();
  }
  sessionHealthSnapshot() {
    return unavailable();
  }
  topologySnapshot() {
    return unavailable();
  }
  screenSnapshot() {
    return unavailable();
  }
  screenDelta() {
    return unavailable();
  }
  paneHistory() {
    return unavailable();
  }
  commandHistory() {
    return unavailable();
  }
  dispatchMuxCommand() {
    return unavailable();
  }
  openSubscription() {
    return unavailable();
  }
}

export default {
  TerminalNodeClient,
  TerminalNodeSubscription,
};
