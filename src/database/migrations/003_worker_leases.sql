-- Relay: Worker Leases for Atomic Processing
-- Add lease support for notification processing to prevent concurrent workers

ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS processing_locked_until TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS claim_token VARCHAR(255);

-- Index for finding notifications eligible for processing
CREATE INDEX IF NOT EXISTS idx_notifications_processing_eligible 
ON notifications(status, created_at) 
WHERE status IN ('pending', 'queued');

-- Index for recovery of stuck processing
CREATE INDEX IF NOT EXISTS idx_notifications_processing_stuck 
ON notifications(processing_started_at) 
WHERE processing_locked_until IS NOT NULL;
