import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadVideo, isPublicAddress } from '../video-input.js';

test('blocks private, reserved, mapped and transition addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1',
    '192.168.1.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('streaming downloads, redirects, failures, cancellation and cleanup', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-input-test-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
    else if (req.url === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/ok' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/expired') { res.writeHead(403); res.end('expired'); }
    else if (req.url === '/large') { res.writeHead(200, { 'Content-Length': '100' }); res.end('x'.repeat(100)); }
    else if (req.url === '/chunked') { res.write('12345'); res.end('67890'); }
    else if (req.url === '/slow') { res.writeHead(200); res.flushHeaders(); }
    else if (req.url === '/empty') res.end();
    else res.end('video');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const options = {
    tempDir, maxBytes: 8, timeoutMs: 1000,
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (url, opts, cb) => {
      opts.lookup(url.hostname, {}, (err, address) => assert.equal(address, '8.8.8.8'));
      return http.request({ ...opts, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, cb);
    }
  };
  for (const route of ['/ok', '/redirect']) {
    const file = await downloadVideo(`http://example.com${route}?signed=secret`, options);
    assert.equal(await fs.readFile(file.path, 'utf8'), 'video');
    assert.equal(file.size, 5);
    await fs.unlink(file.path);
  }
  for (const [route, status, code] of [
    ['/private', 400, 'URL_NOT_ALLOWED'], ['/loop', 422, 'DOWNLOAD_REDIRECT'],
    ['/expired', 422, 'DOWNLOAD_HTTP_ERROR'], ['/large', 413, 'INPUT_TOO_LARGE'],
    ['/chunked', 413, 'INPUT_TOO_LARGE'], ['/empty', 422, 'DOWNLOAD_EMPTY'],
    ['/slow', 408, 'DOWNLOAD_TIMEOUT']
  ]) {
    await assert.rejects(downloadVideo(`http://example.com${route}`, { ...options, timeoutMs: 100 }), { status, code });
    assert.deepEqual(await fs.readdir(tempDir), []);
  }
  const controller = new AbortController();
  const pending = downloadVideo('http://example.com/slow', { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  await assert.rejects(downloadVideo('http://example.com/ok', {
    ...options, timeoutMs: 50, resolve: () => new Promise(() => {})
  }), { code: 'DOWNLOAD_TIMEOUT' });
  await assert.rejects(downloadVideo('http://example.com/ok', {
    ...options, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
  }), { code: 'URL_NOT_ALLOWED' });
  for (const url of ['file:///etc/passwd', 'http://user:secret@example.com/video', 'broken']) {
    await assert.rejects(downloadVideo(url, options), { code: 'INVALID_URL' });
  }
  assert.deepEqual(await fs.readdir(tempDir), []);
});
