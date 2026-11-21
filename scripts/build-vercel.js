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
mkdirSync(join(staticRoot, 'vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/livekit-client/dist/livekit-client.umd.js'), join(staticRoot, 'vendor/livekit.js'));
for (const asset of ['index.html', 'app.js', 'workspace.css', 'assets/smartlearning-logo.png', 'assets/learning-studio.webp', 'assets/teaching-studio.webp', 'assets/futora-labs.webp']) {
  copyFileSync(join(root, asset), join(staticRoot, asset));
}
writeFileSync(join(output, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: backend.origin + '/api/$1' },
    {
      src: '^/(|index\\.html|login|register|forgot-password|reset-password|(?:admin|teacher|student)/dashboard|modules/[a-zA-Z0-9_-]+)$',
      dest: '/index.html',
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    },
    { handle: 'filesystem' },
  ],
}, null, 2));
