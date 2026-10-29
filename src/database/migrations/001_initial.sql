-- Relay: Initial Database Schema

-- 1. Customers (tenants)
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Notifications
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id UUID NOT NULL
        REFERENCES customers(id),

    recipient VARCHAR(255) NOT NULL,

    channel VARCHAR(20) NOT NULL
        CHECK (channel IN ('email', 'sms')),

    payload JSONB NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'queued',
                'processing',
                'provider_accepted',
                'delivered',
                'failed',
                'outcome_unknown'
            )
        ),

    retry_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Transactional Outbox
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    notification_id UUID NOT NULL
        REFERENCES notifications(id),

    event_type VARCHAR(100) NOT NULL,

    published_at TIMESTAMPTZ,

    attempts INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Idempotency Keys
CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id UUID NOT NULL
        REFERENCES customers(id),

    idempotency_key VARCHAR(255) NOT NULL,

    request_hash VARCHAR(64) NOT NULL,

    notification_id UUID NOT NULL
        REFERENCES notifications(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (customer_id, idempotency_key)
);

-- Indexes
CREATE INDEX idx_notifications_customer
ON notifications(customer_id, created_at DESC);

CREATE INDEX idx_outbox_unpublished
ON outbox_events(created_at)
WHERE published_at IS NULL;

CREATE INDEX idx_notifications_status
ON notifications(status);