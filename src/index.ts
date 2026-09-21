// Load .env for local/self-hosted runs. Must come before other imports so env
// vars are set before firebaseAdmin and the route modules read them at import
// time. On Vercel env vars come from the dashboard and .env doesn't exist, so
// this is a no-op there.
import 'dotenv/config';
import { createApp } from './app';

const app = createApp();

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default server;
