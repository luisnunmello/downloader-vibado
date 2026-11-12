import { setMasterPassword } from './auth.js';
import { migrate, pool } from './db.js';

const [password] = process.argv.slice(2);
if (!password) {
  console.error('Usage: npm run set-password -- <new-master-password>');
  process.exit(1);
}

(async () => {
  await migrate();
  await setMasterPassword(password);
  console.log('Master password updated.');
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
