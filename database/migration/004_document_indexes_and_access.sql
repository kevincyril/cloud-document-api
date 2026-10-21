CREATE INDEX documents_user_created_id_idx ON documents (user_id, created_at DESC, id DESC);

-- The API connects directly to PostgreSQL as the table owner. JWT ownership is
-- enforced by its queries. No Supabase browser/Data API access is needed.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE users, documents, schema_migrations FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE users, documents, schema_migrations FROM authenticated;
    END IF;
END $$;
