-- Relay: Notification Lifecycle Enhancement
-- Add 'processed' status to distinguish internal processing from external delivery

ALTER TABLE notifications 
DROP CONSTRAINT IF EXISTS notifications_status_check;

ALTER TABLE notifications 
ADD CONSTRAINT notifications_status_check 
CHECK (status IN (
    'pending',
    'queued',
    'processing',
    'processed',
    'provider_accepted',
    'delivered',
    'failed',
    'outcome_unknown'
));
