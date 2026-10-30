import pg from "pg";
import { pool } from "../database/pool.js";
import { PreferenceRepository, RecipientPreferenceRecord } from "../repositories/preferenceRepository.js";
import { CustomerRepository } from "../repositories/customerRepository.js";

export interface ChannelEvaluationResult {
  enabled: boolean;
  isDefault: boolean;
}

export class PreferenceService {
  private preferenceRepo: PreferenceRepository;
  private customerRepo: CustomerRepository;

  constructor() {
    this.preferenceRepo = new PreferenceRepository();
    this.customerRepo = new CustomerRepository();
  }

  /**
   * Evaluates whether a recipient has enabled notifications for a specific channel.
   *
   * Transaction Consistency & Authority:
   * When client is provided (during notification submission), the preference lookup executes
   * inside the SAME active database transaction as idempotency checking and notification creation.
   * This guarantees that the preference state evaluated at read time is authoritative for the created notification.
   *
   * Default Policy:
   * Prototype implements an explicit default-allow policy (returns enabled=true if no record exists).
   * Note: This default-allow assumption is for prototype convenience and does not replace legally mandated
   * explicit opt-in consent for production marketing communications.
   */
  async isChannelEnabled(
    clientOrPool: pg.PoolClient | pg.Pool = pool,
    customerId: string,
    recipient: string,
    channel: "email" | "sms"
  ): Promise<ChannelEvaluationResult> {
    const pref = await this.preferenceRepo.getPreference(
      clientOrPool,
      customerId,
      recipient,
      channel
    );

    if (!pref) {
      return { enabled: true, isDefault: true };
    }

    return { enabled: pref.enabled, isDefault: false };
  }

  /**
   * Sets or updates a recipient's channel preference.
   */
  async setPreference(
    customerId: string,
    recipient: string,
    channel: "email" | "sms",
    enabled: boolean
  ): Promise<RecipientPreferenceRecord | null> {
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      return null;
    }

    return await this.preferenceRepo.upsertPreference(
      pool,
      customerId,
      recipient,
      channel,
      enabled
    );
  }

  /**
   * Retrieves saved preferences for a recipient.
   */
  async getPreferences(
    customerId: string,
    recipient: string,
    channel?: "email" | "sms"
  ): Promise<RecipientPreferenceRecord[] | null> {
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      return null;
    }

    if (channel) {
      const pref = await this.preferenceRepo.getPreference(
        pool,
        customerId,
        recipient,
        channel
      );
      return pref ? [pref] : [];
    }

    return await this.preferenceRepo.listPreferences(pool, customerId, recipient);
  }
}

export const preferenceService = new PreferenceService();
