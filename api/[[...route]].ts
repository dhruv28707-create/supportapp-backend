import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/app';

// Disable platform pre-parsing so express.json()/express.raw() inside app
// control body handling exactly as they do in local/server runs.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req, res);
}
