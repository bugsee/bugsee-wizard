import Fastify from 'fastify';

const app = Fastify();
app.get('/', async () => ({ ok: true }));
await app.listen({ port: 3000 });
