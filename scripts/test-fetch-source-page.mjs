import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchSourcePage } from './fetch-source-page.mjs';

test('source transport survives redirects, truncation, slow and oversized responses', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/broken') { res.writeHead(200, { 'Content-Length': 100 }); res.write('partial'); setImmediate(() => res.destroy()); }
    else if (req.url === '/slow') { /* Timeout must close this socket. */ }
    else if (req.url === '/blocked') { res.writeHead(403); res.end(); }
    else res.end('annonce');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetchSourcePage(base + '/redirect')).text, 'annonce');
    await assert.rejects(fetchSourcePage(base + '/loop'), /redirects/);
    await assert.rejects(fetchSourcePage(base + '/broken'), /interrupted|aborted|reset/i);
    await assert.rejects(fetchSourcePage(base + '/slow', { timeoutMs: 50 }), /Timeout/);
    await assert.rejects(fetchSourcePage(base + '/ok', { maxBytes: 2 }), /too large/);
    await assert.rejects(fetchSourcePage(base + '/blocked'), /HTTP 403/);
    assert.equal((await fetchSourcePage(base + '/ok')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
