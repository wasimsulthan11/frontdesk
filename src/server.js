'use strict';
const { init } = require('./db');
const { createApp, loadHolidays, sweep } = require('./app');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL (see README)');
  await init();
  await loadHolidays();
  await sweep();
  setInterval(() => sweep().catch(console.error), 5 * 60 * 1000).unref();
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Frontdesk listening on :${port}`));
})().catch((e) => { console.error(e); process.exit(1); });
