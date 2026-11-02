// Focused tests for the loopback demo server.
//
// The server is spawned as a child process because importing it starts
// listening. Only a loopback port is used; nothing leaves the machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/serve.mjs');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timed out')));
  });
}

async function start(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [script, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`serve.mjs exited before listening (${code})`)));
  });
  return { port, child };
}

test('a malformed percent escape is refused and the demo server keeps serving', async (t) => {
  const { port, child } = await start(t);

  // decodeURIComponent('/%FF') throws. That must become a response, not an
  // unhandled rejection that takes the demo process down with it.
  const malformed = await request(port, '/%FF');
  assert.equal(malformed.status, 400);
  assert.equal(child.exitCode, null, 'the server must survive the malformed request');

  const page = await request(port, '/index.html');
  assert.equal(page.status, 200, 'the server still answers after the refusal');
});

test('well-formed paths still resolve', async (t) => {
  const { port } = await start(t);
  const page = await request(port, '/index.html');
  assert.equal(page.status, 200);
  assert.match(page.body, /DSH/);
  const missing = await request(port, '/nope.txt');
  assert.equal(missing.status, 404);
  // Encoded separators are decoded after the URL is parsed, so this path only
  // leaves the root if the normalized-prefix check fails.
  const outside = await request(port, '/..%2fpackage.json');
  assert.equal(outside.status, 403, 'a traversal attempt is refused');
});
