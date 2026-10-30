import { pool } from "../database/pool.js";
import { NotificationRepository } from "../repositories/notificationRepository.js";
import { OutboxRepository } from "../repositories/outboxRepository.js";
import { IdempotencyRepository } from "../repositories/idempotencyRepository.js";
import { CustomerRepository } from "../repositories/customerRepository.js";
import { preferenceService } from "./preferenceService.js";
import { computeRequestHash } from "../utils/hash.js";
import { NotificationRequest } from "../validation/notification.js";
import { recordNotificationAccepted } from "../metrics/index.js";

/**
 * Pattern: Transactional Outbox Pattern
 * Purpose: Ensures atomic consistency between notification state persistence and event publishing.
 * Notifications, idempotency keys, and outbox events are committed in a single PostgreSQL transaction,
 * completely eliminating dual-write failure windows where notifications are persisted but never queued.
 *
 * Pattern: Repository Pattern
 * Purpose: Delegating database access to NotificationRepository, OutboxRepository, and IdempotencyRepository
 * encapsulates SQL query logic and transaction handling behind testable domain abstractions.
 */
export class NotificationService {
  private notificationRepo: NotificationRepository;
  private outboxRepo: OutboxRepository;
  private idempotencyRepo: IdempotencyRepository;
  private customerRepo: CustomerRepository;

  constructor() {
    this.notificationRepo = new NotificationRepository();
    this.outboxRepo = new OutboxRepository();
    this.idempotencyRepo = new IdempotencyRepository();
    this.customerRepo = new CustomerRepository();
  }

  async submitNotification(
    request: NotificationRequest,
    idempotencyKey: string
  ): Promise<{ status: number; body: any; isReplay?: boolean; isSuppressed?: boolean }> {
    const requestHash = computeRequestHash(request);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check if customer exists (for local prototype, customerId may be supplied)
      const customer = await this.customerRepo.findById(request.customerId);
      if (!customer) {
        await client.query("ROLLBACK").catch(() => {});
        return {
          status: 404,
          body: {
            code: "CUSTOMER_NOT_FOUND",
            message: "The specified customer was not found.",
          },
        };
      }

      // Check for existing idempotency key (within transaction for consistency)
      const existingIdempotency = await this.idempotencyRepo.findByKey(
        client,
        request.customerId,
        idempotencyKey
      );

      if (existingIdempotency) {
        // Check if payload hash matches
        if (existingIdempotency.request_hash === requestHash) {
          // Same request - return existing notification
          const existingNotification = await this.notificationRepo.findById(
            existingIdempotency.notification_id
          );
          await client.query("COMMIT");

          const isSuppressed = existingNotification.status === "suppressed";
          return {
            status: isSuppressed ? 200 : 202,
            isReplay: true,
            isSuppressed,
            body: {
              id: existingNotification.id,
              customerId: existingNotification.customer_id,
              recipient: existingNotification.recipient,
              channel: existingNotification.channel,
              status: existingNotification.status,
              ...(isSuppressed ? { suppressionReason: "recipient_preference_disabled" } : {}),
              createdAt: existingNotification.created_at,
              isReplay: true,
            },
          };
        } else {
          // Different payload - conflict
          await client.query("ROLLBACK");
          return {
            status: 409,
            body: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "The idempotency key was used with a different request payload.",
            },
          };
        }
      }

      // Milestone 7A: Evaluate recipient preference within the transaction
      // Point of Authority: The preference decision is evaluated inside the active database transaction.
      // Recipients without saved preferences default to enabled (default-allow prototype policy).
      const preference = await preferenceService.isChannelEnabled(
        client,
        request.customerId,
        request.recipient,
        request.channel
      );

      if (!preference.enabled) {
        // Channel is disabled by recipient preference -> Suppress notification!
        // Notification record is created with status = 'suppressed'
        // CRITICAL INVARIANT: Zero outbox events or queue jobs are created for suppressed requests.
        const notification = await this.notificationRepo.create(client, {
          customerId: request.customerId,
          recipient: request.recipient,
          channel: request.channel,
          payload: request.payload,
          status: "suppressed",
        });

        // Still write idempotency key to ensure future replays return identical suppression result
        await this.idempotencyRepo.create(client, {
          customerId: request.customerId,
          idempotencyKey: idempotencyKey,
          requestHash: requestHash,
          notificationId: notification.id,
        });

        await client.query("COMMIT");

        return {
          status: 200,
          isReplay: false,
          isSuppressed: true,
          body: {
            id: notification.id,
            customerId: notification.customer_id,
            recipient: notification.recipient,
            channel: notification.channel,
            status: "suppressed",
            suppressionReason: "recipient_preference_disabled",
            createdAt: notification.created_at,
          },
        };
      }

      // Channel is enabled: Proceed with normal durable transactional outbox flow
      const notification = await this.notificationRepo.create(client, {
        customerId: request.customerId,
        recipient: request.recipient,
        channel: request.channel,
        payload: request.payload,
        status: "pending",
      });

      await this.outboxRepo.create(client, {
        notificationId: notification.id,
        eventType: "notification.created",
      });

      try {
        await this.idempotencyRepo.create(client, {
          customerId: request.customerId,
          idempotencyKey: idempotencyKey,
          requestHash: requestHash,
          notificationId: notification.id,
        });
      } catch (err: any) {
        // Handle concurrent requests - if unique constraint violated
        if (err.code === "23505") { // unique_violation
          await client.query("ROLLBACK");
          // Try to fetch the existing one
          const client2 = await pool.connect();
          try {
            await client2.query("BEGIN");
            const existing = await this.idempotencyRepo.findByKey(
              client2,
              request.customerId,
              idempotencyKey
            );
            if (existing) {
              if (existing.request_hash === requestHash) {
                const existingNotification = await this.notificationRepo.findById(
                  existing.notification_id
                );
                await client2.query("COMMIT");
                const isSuppressed = existingNotification.status === "suppressed";
                return {
                  status: isSuppressed ? 200 : 202,
                  isReplay: true,
                  isSuppressed,
                  body: {
                    id: existingNotification.id,
                    customerId: existingNotification.customer_id,
                    recipient: existingNotification.recipient,
                    channel: existingNotification.channel,
                    status: existingNotification.status,
                    ...(isSuppressed ? { suppressionReason: "recipient_preference_disabled" } : {}),
                    createdAt: existingNotification.created_at,
                    isReplay: true,
                  },
                };
              } else {
                await client2.query("ROLLBACK");
                return {
                  status: 409,
                  body: {
                    code: "IDEMPOTENCY_CONFLICT",
                    message: "The idempotency key was used with a different request payload.",
                  },
                };
              }
            }
            await client2.query("ROLLBACK");
          } finally {
            client2.release();
          }
        }
        throw err;
      }

      await client.query("COMMIT");
      recordNotificationAccepted(request.channel);

      return {
        status: 202,
        isReplay: false,
        body: {
          id: notification.id,
          customerId: notification.customer_id,
          recipient: notification.recipient,
          channel: notification.channel,
          status: notification.status,
          createdAt: notification.created_at,
        },
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        // Ignore
      }
      throw error;
    } finally {
      try {
        client.release();
      } catch (e) {
        // Ignore
      }
    }
  }
}
