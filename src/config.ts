import path from 'path';

// Both src/ (tsx) and dist/ (compiled) sit one level below the project root.
const ROOT = path.join(__dirname, '..');

export const PORT = Number(process.env.PORT || 3000);
export const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/downloader';
// UPLOAD_PASSWORD is the pre-rename name, still accepted for existing setups.
export const MASTER_PASSWORD = process.env.MASTER_PASSWORD ?? process.env.UPLOAD_PASSWORD;

// Files are stored in a bytea column and held in memory, so keep this moderate.
export const MAX_SIZE = Number(process.env.MAX_SIZE_MB || 100) * 1024 * 1024;
export const MAX_EXPIRY_MINUTES = 365 * 24 * 60;
export const CLEANUP_INTERVAL_MS = 60 * 1000;

export const VIEWS_DIR = path.join(ROOT, 'views');
export const PUBLIC_DIR = path.join(ROOT, 'public');
