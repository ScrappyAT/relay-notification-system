import crypto from "crypto";
import { NotificationRequest } from "../validation/notification.js";

export function computeRequestHash(request: NotificationRequest): string {
  // Create a deterministic representation of the request
  // We need to hash the key parts that determine the payload
  const hashInput = JSON.stringify({
    channel: request.channel,
    recipient: request.recipient,
    customerId: request.customerId,
    payload: request.payload,
  });
  return crypto.createHash("sha256").update(hashInput).digest("hex");
}
