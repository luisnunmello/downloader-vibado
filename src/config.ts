import path from 'path';

// Both src/ (tsx) and dist/ (compiled) sit one level below the project root.
const ROOT = path.join(__dirname, '..');

export const PORT = Number(process.env.PORT || 3000);
export const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/downloader';
// UPLOAD_PASSWORD is the pre-rename name, still accepted for existing setups.
export const MASTER_PASSWORD = process.env.MASTER_PASSWORD ?? process.env.UPLOAD_PASSWORD;

// Set when behind a reverse proxy: a hop count (e.g. "1") or an Express trust-proxy value.
// Needed so the client IP, rate limiting and the Secure cookie flag work correctly.
const trustProxy = process.env.TRUST_PROXY;
export const TRUST_PROXY: number | string | undefined =
  trustProxy === undefined || trustProxy === '' ? undefined : Number.isNaN(Number(trustProxy)) ? trustProxy : Number(trustProxy);

// A file is stored in one Postgres bytea value, which holds at most 1 GB. Nobody can exceed this,
// not even the master.
export const HARD_MAX_SIZE_MB = 1000;
export const HARD_MAX_SIZE = HARD_MAX_SIZE_MB * 1024 * 1024;

// Default size limit for guests without their own limit. Files are held in memory, so keep this moderate.
export const MAX_SIZE = Math.min(Number(process.env.MAX_SIZE_MB || 100), HARD_MAX_SIZE_MB) * 1024 * 1024;
export const MAX_EXPIRY_MINUTES = 365 * 24 * 60;
export const CLEANUP_INTERVAL_MS = 60 * 1000;

export const VIEWS_DIR = path.join(ROOT, 'views');
export const PUBLIC_DIR = path.join(ROOT, 'public');
