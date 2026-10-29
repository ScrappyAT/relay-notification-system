-- Relay: Outbox Failure Handling
-- Add explicit terminal failure state for exhausted outbox events

ALTER TABLE outbox_events 
ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS failure_reason TEXT,
ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Index for finding exhausted failed events
CREATE INDEX IF NOT EXISTS idx_outbox_failed 
ON outbox_events(failed_at) 
WHERE failed_at IS NOT NULL AND published_at IS NULL;

-- Index for finding events needing manual intervention
CREATE INDEX IF NOT EXISTS idx_outbox_exhausted 
ON outbox_events(attempts, created_at) 
WHERE published_at IS NULL AND failed_at IS NULL;
