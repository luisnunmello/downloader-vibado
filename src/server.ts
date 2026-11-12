import { createApp } from './app.js';
import { seedMasterPassword } from './auth.js';
import { CLEANUP_INTERVAL_MS, MASTER_PASSWORD, PORT } from './config.js';
import { migrate } from './db.js';
import { deleteExpiredFiles } from './files.js';
import { moveLegacyFilesToDisk } from './legacy.js';
import { initStorage } from './storage.js';
import { deleteExpiredSessions } from './session.js';
import { expireTemps } from './video.js';

async function cleanup(): Promise<void> {
  try {
    const n = await deleteExpiredFiles();
    if (n) console.log(`Deleted ${n} expired file(s).`);
    await deleteExpiredSessions();
    await expireTemps(6 * 60 * 60 * 1000); // temporary videos nobody came back for
  } catch (e) {
    console.error('Cleanup failed:', e);
  }
}

async function main(): Promise<void> {
  await migrate();
  await initStorage();
  await moveLegacyFilesToDisk();
  await seedMasterPassword(MASTER_PASSWORD);

  await cleanup();
  setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();

  const server = createApp().listen(PORT, () =>
    console.log(`Listening on http://localhost:${PORT}  (upload page: /upload)`),
  );
  // Big uploads can take a long time; Node's default 5 minute request timeout would cut them off.
  server.requestTimeout = 0;
}

main().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
