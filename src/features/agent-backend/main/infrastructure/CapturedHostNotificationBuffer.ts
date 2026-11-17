import { HOST_GAP_METHOD, type HostLimits, type RpcNotification } from '@agent-teams/legacy-agent-host/contracts';

/** Bounded auxiliary observations; request/native processing stays with the Client. */
export class CapturedHostNotificationBuffer {
  private notifications: RpcNotification[] = [];
  private notificationBytes = 0;
  private notificationGap = false;

  constructor(private readonly onNativePromptSuggestion?: (value: unknown) => void) {}

  receive(message: RpcNotification, frameBytes: number, limits: HostLimits): void {
    if (message.method === HOST_GAP_METHOD) this.notificationGap = true;
    else if (message.method === 'runtime.prompt-suggestion.updated' && this.onNativePromptSuggestion) {
      // The selected Main owner consumes this ephemeral offer synchronously.
      try { this.onNativePromptSuggestion(message.params); }
      catch { /* Auxiliary observations never change a Host result. */ }
    } else if (
      this.notifications.length >= limits.maxDataNotifications ||
      this.notificationBytes + frameBytes > limits.maxDataBytes
    ) {
      this.notifications = [];
      this.notificationBytes = 0;
      this.notificationGap = true;
    } else {
      this.notifications.push(message);
      this.notificationBytes += frameBytes;
    }
  }

  take(): { notifications: RpcNotification[]; gap: boolean } {
    const result = { notifications: this.notifications, gap: this.notificationGap };
    this.notifications = [];
    this.notificationBytes = 0;
    this.notificationGap = false;
    return result;
  }
}
