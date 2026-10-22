-- Application ownership IDs remain unchanged when a verified identity is linked.
ALTER TABLE users ADD COLUMN auth_user_id UUID UNIQUE;
