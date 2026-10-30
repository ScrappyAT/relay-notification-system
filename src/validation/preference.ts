import { z } from "zod";

export const RecipientPreferenceSchema = z.object({
  customerId: z.string().uuid("customerId must be a valid UUID"),
  recipient: z.string().min(1).max(255),
  channel: z.enum(["email", "sms"]),
  enabled: z.boolean(),
});

export const RecipientPreferenceQuerySchema = z.object({
  customerId: z.string().uuid("customerId must be a valid UUID"),
  recipient: z.string().min(1).max(255),
  channel: z.enum(["email", "sms"]).optional(),
});

export type RecipientPreferenceInput = z.infer<typeof RecipientPreferenceSchema>;
export type RecipientPreferenceQuery = z.infer<typeof RecipientPreferenceQuerySchema>;
