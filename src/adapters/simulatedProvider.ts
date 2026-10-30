import crypto from "crypto";

export type ProviderChannel = "email" | "sms";

export type ProviderFailureMode =
  | "SUCCESS"
  | "TRANSIENT_503"
  | "RATE_LIMIT_429"
  | "TIMEOUT"
  | "PERMANENT_400";

export interface ProviderDeliveryRequest {
  notificationId: string;
  customerId: string;
  channel: ProviderChannel;
  recipient: string;
  payload: any;
  attempt?: number;
}

export interface ProviderDeliveryResponse {
  success: boolean;
  statusCode: number;
  provider: string;
  providerMessageId: string;
  deliveredAt: Date;
  durationMs: number;
}

export class ProviderError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly isTimeout: boolean;
  public readonly provider: string;
  public readonly providerMessageId?: string;
  public readonly durationMs: number;

  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    retryable: boolean;
    isTimeout?: boolean;
    provider: string;
    providerMessageId?: string;
    durationMs?: number;
  }) {
    super(options.message);
    this.name = "ProviderError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.retryable = options.retryable;
    this.isTimeout = options.isTimeout ?? false;
    this.provider = options.provider;
    this.providerMessageId = options.providerMessageId;
    this.durationMs = options.durationMs ?? 0;
  }
}

export interface ProviderCallRecord {
  notificationId: string;
  customerId: string;
  channel: ProviderChannel;
  recipient: string;
  mode: ProviderFailureMode;
  attempt: number;
  success: boolean;
  statusCode: number;
  providerMessageId?: string;
  timestamp: Date;
}

interface FailureOverride {
  mode: ProviderFailureMode;
  remainingFailures: number;
}

/**
 * Pattern: Adapter Pattern
 * Simulated Provider Adapter
 * Simulates external email (e.g. SendGrid/SES) and SMS (e.g. Twilio/Sinch) delivery gateways.
 * Supports configurable deterministic failures (503, 429, timeout, 400) for testing and drills.
 */
export class SimulatedProvider {
  private recipientOverrides = new Map<string, FailureOverride>();
  private notificationOverrides = new Map<string, FailureOverride>();
  private channelDefaults = new Map<
    ProviderChannel,
    { mode: ProviderFailureMode; failureRate: number }
  >();
  private callHistory: ProviderCallRecord[] = [];
  private artificialDelayMs: number = 0;

  constructor() {
    this.channelDefaults.set("email", { mode: "SUCCESS", failureRate: 0 });
    this.channelDefaults.set("sms", { mode: "SUCCESS", failureRate: 0 });
  }

  setArtificialDelayMs(delayMs: number): void {
    this.artificialDelayMs = Math.max(0, delayMs);
  }

  setRecipientFailure(
    recipient: string,
    mode: ProviderFailureMode,
    maxFailures: number = 1
  ): void {
    this.recipientOverrides.set(recipient.toLowerCase(), {
      mode,
      remainingFailures: maxFailures,
    });
  }

  setNotificationFailure(
    notificationId: string,
    mode: ProviderFailureMode,
    maxFailures: number = 1
  ): void {
    this.notificationOverrides.set(notificationId, {
      mode,
      remainingFailures: maxFailures,
    });
  }

  setChannelFailureRate(
    channel: ProviderChannel,
    failureRate: number,
    mode: ProviderFailureMode = "TRANSIENT_503"
  ): void {
    this.channelDefaults.set(channel, {
      mode,
      failureRate: Math.min(1, Math.max(0, failureRate)),
    });
  }

  setChannelDefaultMode(
    channel: ProviderChannel,
    mode: ProviderFailureMode
  ): void {
    const current = this.channelDefaults.get(channel) || {
      mode: "SUCCESS",
      failureRate: 0,
    };
    this.channelDefaults.set(channel, { ...current, mode });
  }

  clearOverrides(): void {
    this.recipientOverrides.clear();
    this.notificationOverrides.clear();
    this.channelDefaults.set("email", { mode: "SUCCESS", failureRate: 0 });
    this.channelDefaults.set("sms", { mode: "SUCCESS", failureRate: 0 });
  }

  clearHistory(): void {
    this.callHistory = [];
  }

  reset(): void {
    this.clearOverrides();
    this.clearHistory();
    this.artificialDelayMs = 0;
  }

  getCallHistory(): readonly ProviderCallRecord[] {
    return [...this.callHistory];
  }

  getCallsForNotification(notificationId: string): ProviderCallRecord[] {
    return this.callHistory.filter((c) => c.notificationId === notificationId);
  }

  getCallsForRecipient(recipient: string): ProviderCallRecord[] {
    const norm = recipient.toLowerCase();
    return this.callHistory.filter((c) => c.recipient.toLowerCase() === norm);
  }

  private resolveFailureMode(
    notificationId: string,
    recipient: string,
    channel: ProviderChannel
  ): ProviderFailureMode {
    // 1. Exact notification ID override
    const notifOverride = this.notificationOverrides.get(notificationId);
    if (notifOverride && notifOverride.remainingFailures > 0) {
      notifOverride.remainingFailures--;
      return notifOverride.mode;
    }

    // 2. Exact recipient override
    const normRecipient = recipient.toLowerCase();
    const recipOverride = this.recipientOverrides.get(normRecipient);
    if (recipOverride && recipOverride.remainingFailures > 0) {
      recipOverride.remainingFailures--;
      return recipOverride.mode;
    }

    // 3. Pattern-based convention in recipient string
    if (
      normRecipient.includes("simulate-503") ||
      normRecipient.includes("sim-503")
    ) {
      return "TRANSIENT_503";
    }
    if (
      normRecipient.includes("simulate-429") ||
      normRecipient.includes("sim-429")
    ) {
      return "RATE_LIMIT_429";
    }
    if (
      normRecipient.includes("simulate-timeout") ||
      normRecipient.includes("sim-timeout")
    ) {
      return "TIMEOUT";
    }
    if (
      normRecipient.includes("simulate-400") ||
      normRecipient.includes("sim-400")
    ) {
      return "PERMANENT_400";
    }

    // 4. Channel-level failure rate or mode default
    const channelConfig = this.channelDefaults.get(channel);
    if (channelConfig) {
      if (
        channelConfig.failureRate > 0 &&
        Math.random() < channelConfig.failureRate
      ) {
        return channelConfig.mode;
      }
      if (channelConfig.mode !== "SUCCESS") {
        return channelConfig.mode;
      }
    }

    return "SUCCESS";
  }

  async send(request: ProviderDeliveryRequest): Promise<ProviderDeliveryResponse> {
    const startTime = Date.now();
    const { notificationId, customerId, channel, recipient, attempt = 1 } = request;
    const providerName =
      channel === "email" ? "SendGrid-Simulator" : "Twilio-Simulator";

    if (this.artificialDelayMs > 0) {
      await new Promise((res) => setTimeout(res, this.artificialDelayMs));
    }

    const mode = this.resolveFailureMode(notificationId, recipient, channel);
    const durationMs = Date.now() - startTime;

    switch (mode) {
      case "SUCCESS": {
        const providerMessageId = `sim_${channel}_${crypto.randomUUID()}`;
        this.callHistory.push({
          notificationId,
          customerId,
          channel,
          recipient,
          mode,
          attempt,
          success: true,
          statusCode: 202,
          providerMessageId,
          timestamp: new Date(),
        });

        return {
          success: true,
          statusCode: 202,
          provider: providerName,
          providerMessageId,
          deliveredAt: new Date(),
          durationMs,
        };
      }

      case "TRANSIENT_503": {
        this.callHistory.push({
          notificationId,
          customerId,
          channel,
          recipient,
          mode,
          attempt,
          success: false,
          statusCode: 503,
          timestamp: new Date(),
        });

        throw new ProviderError({
          message: `Downstream ${providerName} temporary service outage (HTTP 503)`,
          statusCode: 503,
          code: "PROVIDER_SERVICE_UNAVAILABLE",
          retryable: true,
          isTimeout: false,
          provider: providerName,
          durationMs,
        });
      }

      case "RATE_LIMIT_429": {
        this.callHistory.push({
          notificationId,
          customerId,
          channel,
          recipient,
          mode,
          attempt,
          success: false,
          statusCode: 429,
          timestamp: new Date(),
        });

        throw new ProviderError({
          message: `Downstream ${providerName} tenant dispatch quota exceeded (HTTP 429)`,
          statusCode: 429,
          code: "PROVIDER_RATE_LIMIT_EXCEEDED",
          retryable: true,
          isTimeout: false,
          provider: providerName,
          durationMs,
        });
      }

      case "TIMEOUT": {
        this.callHistory.push({
          notificationId,
          customerId,
          channel,
          recipient,
          mode,
          attempt,
          success: false,
          statusCode: 504,
          timestamp: new Date(),
        });

        throw new ProviderError({
          message: `Downstream ${providerName} socket read timeout: delivery outcome indeterminate`,
          statusCode: 504,
          code: "PROVIDER_TIMEOUT",
          retryable: false,
          isTimeout: true,
          provider: providerName,
          durationMs,
        });
      }

      case "PERMANENT_400": {
        this.callHistory.push({
          notificationId,
          customerId,
          channel,
          recipient,
          mode,
          attempt,
          success: false,
          statusCode: 400,
          timestamp: new Date(),
        });

        throw new ProviderError({
          message: `Downstream ${providerName} rejected invalid destination address (HTTP 400)`,
          statusCode: 400,
          code: "PROVIDER_BAD_REQUEST",
          retryable: false,
          isTimeout: false,
          provider: providerName,
          durationMs,
        });
      }

      default: {
        const providerMessageId = `sim_${channel}_${crypto.randomUUID()}`;
        return {
          success: true,
          statusCode: 202,
          provider: providerName,
          providerMessageId,
          deliveredAt: new Date(),
          durationMs,
        };
      }
    }
  }
}

// Global singleton instance for worker consumption and test configuration
export const simulatedProvider = new SimulatedProvider();
