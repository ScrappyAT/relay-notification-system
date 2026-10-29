-- Relay: Outbox Improvements for Dispatcher
-- Add columns to support safe claiming and recovery

ALTER TABLE outbox_events 
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Update existing rows
UPDATE outbox_events SET attempts = 0 WHERE attempts IS NULL;

-- Make attempts NOT NULL
ALTER TABLE outbox_events ALTER COLUMN attempts SET NOT NULL;
ALTER TABLE outbox_events ALTER COLUMN attempts SET DEFAULT 0;

-- Index for efficient claiming of unpublished events
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished_claim 
ON outbox_events(created_at) 
WHERE published_at IS NULL;

-- Index for recovery of stuck claims
CREATE INDEX IF NOT EXISTS idx_outbox_claimed 
ON outbox_events(claimed_at) 
WHERE claimed_at IS NOT NULL AND published_at IS NULL;
