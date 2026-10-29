import { z } from "zod";

export const EmailPayloadSchema = z.object({
  subject: z.string().min(1).max(998),
  body: z.string().min(1),
  from: z.string().email().optional(),
  replyTo: z.string().email().optional(),
});

export const SmsPayloadSchema = z.object({
  body: z.string().min(1).max(1600),
  from: z.string().optional(),
});

export const EmailNotificationSchema = z.object({
  customerId: z.string().uuid(),
  recipient: z.string().email(),
  channel: z.literal("email"),
  payload: EmailPayloadSchema,
});

export const SmsNotificationSchema = z.object({
  customerId: z.string().uuid(),
  recipient: z.string().min(1).max(255),
  channel: z.literal("sms"),
  payload: SmsPayloadSchema,
});

export const NotificationRequestSchema = z.discriminatedUnion("channel", [
  EmailNotificationSchema,
  SmsNotificationSchema,
]);

export type EmailNotificationRequest = z.infer<typeof EmailNotificationSchema>;
export type SmsNotificationRequest = z.infer<typeof SmsNotificationSchema>;
export type NotificationRequest = z.infer<typeof NotificationRequestSchema>;
