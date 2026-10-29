import crypto from "crypto";

export function generateClaimToken(): string {
  return crypto.randomUUID();
}
