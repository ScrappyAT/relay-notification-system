-- Relay: Notification Preferences (Milestone 7A)
-- Add recipient preferences table for tenant-scoped channel opt-in/opt-out
-- Expand notification status check constraint to include 'suppressed'

-- 1. Create recipient_preferences table
CREATE TABLE IF NOT EXISTS recipient_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    recipient VARCHAR(255) NOT NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_recipient_channel_per_customer UNIQUE (customer_id, recipient, channel)
);

-- 2. Index for efficient tenant + recipient preference queries
CREATE INDEX IF NOT EXISTS idx_recipient_preferences_lookup
ON recipient_preferences(customer_id, recipient, channel);

-- 3. Update notifications status check constraint to support 'suppressed'
ALTER TABLE notifications
DROP CONSTRAINT IF EXISTS notifications_status_check;

ALTER TABLE notifications
ADD CONSTRAINT notifications_status_check
CHECK (status IN (
    'pending',
    'queued',
    'processing',
    'processed',
    'suppressed',
    'provider_accepted',
    'delivered',
    'failed',
    'outcome_unknown'
));
