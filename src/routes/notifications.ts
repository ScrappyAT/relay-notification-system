import { Router, Request, Response } from "express";
import { NotificationRequestSchema } from "../validation/notification.js";
import { NotificationService } from "../services/notificationService.js";
import { ZodError } from "zod";
import { recordValidationFailure, recordIdempotencyConflict } from "../metrics/index.js";
import { rateLimiter } from "../services/rateLimiter.js";
import { backpressureService } from "../services/backpressureService.js";
import { computeRequestHash } from "../utils/hash.js";
import { IdempotencyRepository } from "../repositories/idempotencyRepository.js";
import { NotificationRepository } from "../repositories/notificationRepository.js";

const router = Router();
const notificationService = new NotificationService();
const idempotencyRepo = new IdempotencyRepository();
const notificationRepo = new NotificationRepository();

router.post("/", async (req: Request, res: Response) => {
  try {
    // 1. Check for required Idempotency-Key header
    const idempotencyKey = req.headers["idempotency-key"];
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      recordValidationFailure();
      return res.status(400).json({
        code: "MISSING_IDEMPOTENCY_KEY",
        message: "The Idempotency-Key header is required.",
      });
    }

    // 2. Validate request body (including customerId)
    const validationResult = NotificationRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      recordValidationFailure();
      const errors = validationResult.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        errors,
      });
    }

    const { customerId } = validationResult.data;

    // 3. Enforce tenant-level atomic rate limit
    const rateLimit = await rateLimiter.consume(customerId);

    // Set standard RateLimit headers
    res.setHeader("RateLimit-Limit", rateLimit.limit.toString());
    res.setHeader("RateLimit-Remaining", rateLimit.remaining.toString());
    res.setHeader("RateLimit-Reset", rateLimit.resetSeconds.toString());

    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", rateLimit.resetSeconds.toString());
      return res.status(429).json({
        code: "RATE_LIMIT_EXCEEDED",
        message: `Too many requests for tenant ${customerId}. Please retry after ${rateLimit.resetSeconds} seconds.`,
      });
    }

    // 4. Backpressure & Overload Admission Control (Milestone 6D)
    const admission = await backpressureService.checkAdmission();
    if (!admission.allowed) {
      // Overload state!
      // Check if this request is a safe identical replay of an ALREADY accepted notification
      // (allows clients polling/replaying existing notifications to retrieve them without creating new work)
      const requestHash = computeRequestHash(validationResult.data);
      let existingIdempotency = null;
      try {
        existingIdempotency = await idempotencyRepo.findReadOnly(customerId, idempotencyKey);
      } catch {
        // If DB query fails under overload, proceed directly to 503 rejection
      }

      if (existingIdempotency) {
        if (existingIdempotency.request_hash === requestHash) {
          // Identical replay! Safe to return existing notification without creating outbox events
          const existingNotification = await notificationRepo.findById(existingIdempotency.notification_id);
          if (existingNotification) {
            // Refund rate limit token for safe replay
            if (rateLimit.member) {
              await rateLimiter.refund(customerId, rateLimit.member);
            }
            return res.status(202).json({
              id: existingNotification.id,
              customerId: existingNotification.customer_id,
              recipient: existingNotification.recipient,
              channel: existingNotification.channel,
              status: existingNotification.status,
              createdAt: existingNotification.created_at,
            });
          }
        } else {
          // Conflicting replay with different payload
          recordIdempotencyConflict();
          return res.status(409).json({
            code: "IDEMPOTENCY_CONFLICT",
            message: "The idempotency key was used with a different request payload.",
          });
        }
      }

      // New submission under OVERLOADED state:
      // Refund consumed tenant rate limit quota (do not penalize tenant for system overload)
      if (rateLimit.member) {
        await rateLimiter.refund(customerId, rateLimit.member);
      }

      res.setHeader("Retry-After", (admission.retryAfter ?? 5).toString());
      return res.status(503).json({
        code: "SYSTEM_OVERLOADED",
        message: "The system is currently experiencing high load and cannot accept new notifications. Please retry later.",
        retryAfter: admission.retryAfter ?? 5,
      });
    }

    // 5. Submit notification to durable ingestion pipeline (NORMAL or DEGRADED state)
    const result = await notificationService.submitNotification(
      validationResult.data,
      idempotencyKey
    );

    if (result.status === 409) {
      recordIdempotencyConflict();
    }

    // 6. If this was a safe idempotent replay, refund the consumed token
    if (result.status === 202 && result.isReplay && rateLimit.member) {
      await rateLimiter.refund(customerId, rateLimit.member);
    }

    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ZodError) {
      recordValidationFailure();
      const errors = error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        errors,
      });
    }

    console.error("Error submitting notification:", error);
    return res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "An internal server error occurred.",
    });
  }
});

export default router;
