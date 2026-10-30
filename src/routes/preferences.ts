import { Router, Request, Response } from "express";
import {
  RecipientPreferenceSchema,
  RecipientPreferenceQuerySchema,
} from "../validation/preference.js";
import { preferenceService } from "../services/preferenceService.js";
import { ZodError } from "zod";

const router = Router();

/**
 * PUT /v1/recipients/preferences
 * Sets or updates a recipient's channel preference for a tenant.
 *
 * Prototype Security Note:
 * In this prototype, tenant identity is supplied via customerId in the request body
 * without cryptographic authentication. Production deployments must derive customerId
 * from authenticated API keys or verified session tokens.
 */
router.put("/", async (req: Request, res: Response) => {
  try {
    const parseResult = RecipientPreferenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Invalid preference data provided.",
        errors,
      });
    }

    const { customerId, recipient, channel, enabled } = parseResult.data;

    const updated = await preferenceService.setPreference(
      customerId,
      recipient,
      channel,
      enabled
    );

    if (!updated) {
      return res.status(404).json({
        code: "CUSTOMER_NOT_FOUND",
        message: "The specified customer was not found.",
      });
    }

    return res.status(200).json({
      id: updated.id,
      customerId: updated.customer_id,
      recipient: updated.recipient,
      channel: updated.channel,
      enabled: updated.enabled,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Validation failed.",
      });
    }
    console.error("Error setting preference:", error);
    return res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "An internal server error occurred while updating preferences.",
    });
  }
});

/**
 * GET /v1/recipients/preferences
 * Retrieves saved preferences for a given recipient.
 *
 * Query Params:
 * - customerId: UUID (required)
 * - recipient: string (required)
 * - channel: "email" | "sms" (optional)
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const parseResult = RecipientPreferenceQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Invalid query parameters.",
        errors,
      });
    }

    const { customerId, recipient, channel } = parseResult.data;

    const preferences = await preferenceService.getPreferences(
      customerId,
      recipient,
      channel
    );

    if (preferences === null) {
      return res.status(404).json({
        code: "CUSTOMER_NOT_FOUND",
        message: "The specified customer was not found.",
      });
    }

    if (channel) {
      if (preferences.length === 0) {
        // Return explicit default-allow indicator
        return res.status(200).json({
          customerId,
          recipient,
          channel,
          enabled: true,
          isDefault: true,
        });
      }
      const pref = preferences[0];
      return res.status(200).json({
        id: pref.id,
        customerId: pref.customer_id,
        recipient: pref.recipient,
        channel: pref.channel,
        enabled: pref.enabled,
        isDefault: false,
        createdAt: pref.created_at,
        updatedAt: pref.updated_at,
      });
    }

    return res.status(200).json({
      customerId,
      recipient,
      preferences: preferences.map((p) => ({
        id: p.id,
        channel: p.channel,
        enabled: p.enabled,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  } catch (error) {
    console.error("Error retrieving preferences:", error);
    return res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "An internal server error occurred while retrieving preferences.",
    });
  }
});

export default router;
