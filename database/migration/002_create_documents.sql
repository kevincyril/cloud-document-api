CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    storage_key TEXT UNIQUE NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded', 'processing', 'completed', 'failed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);