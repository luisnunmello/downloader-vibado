import { Pool } from 'pg';
import { DATABASE_URL } from './config.js';

export const pool = new Pool({ connectionString: DATABASE_URL });

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credentials (
      role TEXT PRIMARY KEY,
      salt BYTEA NOT NULL,
      hash BYTEA NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size BIGINT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE files ADD COLUMN IF NOT EXISTS pw_salt BYTEA;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS pw_hash BYTEA;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS files_expires_at_idx ON files (expires_at) WHERE expires_at IS NOT NULL;
    -- Download passwords are now per file; the shared one is obsolete.
    DELETE FROM credentials WHERE role = 'download';
    -- The upload password became the master password.
    UPDATE credentials SET role = 'master'
      WHERE role = 'upload' AND NOT EXISTS (SELECT 1 FROM credentials WHERE role = 'master');

    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      salt BYTEA NOT NULL,
      hash BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS guests_name_lower_idx ON guests (lower(name));

    ALTER TABLE files ADD COLUMN IF NOT EXISTS uploader TEXT NOT NULL DEFAULT 'master';

    CREATE TABLE IF NOT EXISTS downloads (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL REFERENCES files(token) ON DELETE CASCADE,
      downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS downloads_token_idx ON downloads (token);
  `);
}
