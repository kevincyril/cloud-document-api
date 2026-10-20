ALTER TABLE documents
ADD COLUMN extracted_text TEXT,
ADD COLUMN word_count INTEGER CHECK (word_count >= 0),
ADD COLUMN character_count INTEGER CHECK (character_count >= 0),
ADD COLUMN processed_at TIMESTAMPTZ;