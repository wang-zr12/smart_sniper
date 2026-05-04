import { createServer } from '../../packages/server/api/server.js';

const port = Number(process.env.PORT ?? 4317);
createServer().listen(port, '127.0.0.1', () => {
  console.log(`Smart Sniper launcher listening on http://127.0.0.1:${port}`);
});
