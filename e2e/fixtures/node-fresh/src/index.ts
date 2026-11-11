import { createServer } from 'node:http';
import { greeting } from './greeting.js';

const server = createServer((_req, res) => res.end(greeting('e2e')));
server.listen(0, () => {
  console.log(`listening: ${greeting('e2e')}`);
  server.close();
});
