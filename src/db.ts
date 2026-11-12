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

    -- Ownership by guest id (the uploader name stays for display). Deleting a guest keeps their files.
    -- The backfill runs once, when the column is first added.
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'guest_id'
      ) THEN
        ALTER TABLE files ADD COLUMN guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL;
        UPDATE files SET guest_id = g.id FROM guests g
          WHERE files.uploader <> 'master' AND lower(files.uploader) = lower(g.name);
      END IF;
    END $$;

    -- Per-guest limits; NULL means "use the default" (size) or "no limit" (expiry).
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS max_size_mb INTEGER;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS max_expiry_minutes INTEGER;

    -- Total storage a guest may use across all their files, in MB. NULL = no limit.
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS max_total_mb INTEGER;
    -- Replaced by the storage quota above.
    ALTER TABLE guests DROP COLUMN IF EXISTS max_files;

    -- Explicit flag for downloads without a password. Rows with no hash and no flag (files from before
    -- per-file passwords) stay unavailable instead of becoming public.
    ALTER TABLE files ADD COLUMN IF NOT EXISTS no_password BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('master', 'guest')),
      guest_id INTEGER REFERENCES guests(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
}
