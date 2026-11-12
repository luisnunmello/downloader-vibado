import { createApp } from './app.js';
import { seedMasterPassword } from './auth.js';
import { CLEANUP_INTERVAL_MS, MASTER_PASSWORD, PORT } from './config.js';
import { migrate } from './db.js';
import { deleteExpiredFiles } from './files.js';

async function cleanup(): Promise<void> {
  try {
    const n = await deleteExpiredFiles();
    if (n) console.log(`Deleted ${n} expired file(s).`);
  } catch (e) {
    console.error('Cleanup failed:', e);
  }
}

async function main(): Promise<void> {
  await migrate();
  await seedMasterPassword(MASTER_PASSWORD);

  await cleanup();
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

  createApp().listen(PORT, () => console.log(`Listening on http://localhost:${PORT}  (upload page: /upload)`));
}

main().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
