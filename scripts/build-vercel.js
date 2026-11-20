const { mkdirSync, copyFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const backend = new URL(process.env.RENDER_API_ORIGIN || '');
if (backend.protocol !== 'https:' || backend.username || backend.password ||
    backend.pathname !== '/' || backend.search || backend.hash) {
  throw new Error('RENDER_API_ORIGIN must be an HTTPS origin.');
}
const output = join(root, '.vercel', 'output');
const staticRoot = join(output, 'static');
mkdirSync(join(staticRoot, 'assets'), { recursive: true });
for (const asset of ['index.html', 'app.js', 'workspace.css', 'assets/smartlearning-logo.png']) {
  copyFileSync(join(root, asset), join(staticRoot, asset));
}
writeFileSync(join(output, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: backend.origin + '/api/$1' },
    {
      src: '^/(|login|register|(?:admin|teacher|student)/dashboard)$',
      dest: '/index.html',
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    },
    { handle: 'filesystem' },
  ],
}, null, 2));
