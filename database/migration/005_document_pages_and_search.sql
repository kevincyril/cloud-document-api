-- One unit per physical PDF page; UTF-8 text files have one unit and no page number.
CREATE TABLE document_pages (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL CHECK (unit_index > 0),
    page_number INTEGER CHECK (page_number > 0 AND page_number = unit_index),
    text TEXT NOT NULL,
    search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED,
    PRIMARY KEY (document_id, unit_index)
);
CREATE INDEX document_pages_search_idx ON document_pages USING GIN (search_vector);

-- Express connects as table owner and enforces its own JWT ownership checks.
-- There is no browser/Supabase Data API access to this table.
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE document_pages FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE document_pages FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE document_pages FROM authenticated;
    END IF;
END $$;
