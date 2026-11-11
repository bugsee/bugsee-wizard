import { createServer } from 'node:http';

createServer((_req, res) => res.end('ok')).listen(3000);
