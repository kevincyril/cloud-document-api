-- Additive only. Existing document uploads and search remain unchanged.
ALTER TABLE documents ADD CONSTRAINT documents_id_user_unique UNIQUE (id, user_id);
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    merchant VARCHAR(160) NOT NULL CHECK (length(trim(merchant)) > 0),
    purchase_date DATE CHECK (purchase_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
    amount_minor BIGINT CHECK (amount_minor BETWEEN 0 AND 999999999999),
    currency VARCHAR(3) CHECK (currency IN ('USD','CAD','EUR','GBP','AUD','JPY','KWD')),
    description VARCHAR(500) NOT NULL DEFAULT '',
    policy_notes VARCHAR(2000) NOT NULL DEFAULT '',
    receipt_document_id UUID,
    policy_document_id UUID,
    raw_ocr_text TEXT NOT NULL DEFAULT '' CHECK (length(raw_ocr_text) <= 30000),
    suggestions JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(suggestions) = 'object'),
    deadline_source VARCHAR(10) NOT NULL CHECK (deadline_source IN ('none','manual','window')),
    deadline_date DATE CHECK (deadline_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
    return_window_days INTEGER CHECK (return_window_days BETWEEN 1 AND 3650),
    purchase_day_counts BOOLEAN,
    deadline_confirmed_at TIMESTAMPTZ,
    returned BOOLEAN NOT NULL DEFAULT false,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (receipt_document_id, user_id) REFERENCES documents(id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (policy_document_id, user_id) REFERENCES documents(id, user_id) ON DELETE RESTRICT,
    CHECK ((amount_minor IS NULL) = (currency IS NULL)),
    CHECK (deadline_date IS NULL OR purchase_date IS NULL OR deadline_date >= purchase_date),
    CHECK (
      (deadline_source = 'none' AND deadline_date IS NULL AND return_window_days IS NULL AND purchase_day_counts IS NULL AND deadline_confirmed_at IS NULL)
      OR (deadline_source = 'manual' AND deadline_date IS NOT NULL AND return_window_days IS NULL AND purchase_day_counts IS NULL AND deadline_confirmed_at IS NOT NULL)
      OR (deadline_source = 'window' AND deadline_date IS NOT NULL AND purchase_date IS NOT NULL AND return_window_days IS NOT NULL AND purchase_day_counts IS NOT NULL AND deadline_confirmed_at IS NOT NULL
        AND deadline_date = purchase_date + return_window_days - CASE WHEN purchase_day_counts THEN 1 ELSE 0 END)
    )
);
CREATE INDEX purchases_user_deadline_idx ON purchases (user_id, deadline_date, id);
CREATE INDEX purchases_receipt_owner_idx ON purchases (receipt_document_id, user_id) WHERE receipt_document_id IS NOT NULL;
CREATE INDEX purchases_policy_owner_idx ON purchases (policy_document_id, user_id) WHERE policy_document_id IS NOT NULL;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purchases FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE purchases FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE purchases FROM authenticated;
    END IF;
END $$;
