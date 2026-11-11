import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import http from 'node:http';

test('multipart compatibility, response contract, deletion and URL validation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-endpoints-test-'));
  Object.assign(process.env, {
    PORT: '0', API_TOKEN: 'test-token', FILES_DIR: path.join(dir, 'files'),
    PUBLIC_BASE_URL: '', TMPDIR: dir, FFMPEG_PATH: ffmpegPath, FFMPEG_THREADS: '1',
    MAX_INPUT_MB: '1', DOWNLOAD_TIMEOUT_MS: '1000'
  });
  const { server } = await import('../server.js');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-token' };
  const fixture = path.join(dir, 'source.mp4');
  await promisify(execFile)(ffmpegPath, [
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '0.4', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-y', fixture
  ]);
  const video = await fs.readFile(fixture);
  // Route the public-IP test origin to a local fixture; no external network.
  const origin = http.createServer((req, res) => res.end(video));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  });
  const originalRequest = http.request;
  t.mock.method(http, 'request', (url, options, cb) => {
    if (url instanceof URL && url.hostname === '8.8.8.8') {
      return originalRequest({ ...options, hostname: '127.0.0.1', port: origin.address().port, path: url.pathname }, cb);
    }
    return originalRequest(url, options, cb);
  });
  for (const [route, mode] of ['/compress?max_mb=1', '/extract'].flatMap(route =>
    [[route, 'multipart'], [route, 'url']])) {
    let body;
    let requestHeaders = headers;
    if (mode === 'multipart') {
      body = new FormData();
      body.append('video', new Blob([video]), 'meeting.mp4');
    } else {
      body = JSON.stringify({ url: 'http://8.8.8.8/meeting.mp4?signature=secret' });
      requestHeaders = { ...headers, 'Content-Type': 'application/json' };
    }
    const response = await fetch(base + route, { method: 'POST', headers: requestHeaders, body });
    assert.equal(response.status, 200);
    if (route.startsWith('/compress')) {
      const result = await response.json();
      assert.match(result.filename, /^[a-f0-9]{32}\.mp4$/);
      assert.equal(result.video_url, `${base}/files/${result.filename}`);
      assert.equal(result.original_filename, 'meeting.mp4');
      assert.equal((await fetch(result.video_url)).status, 200);
      assert.equal((await fetch(result.video_url, { method: 'DELETE', headers })).status, 200);
      assert.equal((await fetch(result.video_url)).status, 404);
    } else {
      assert.match(response.headers.get('content-type'), /audio\/mpeg/);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
  }
  for (const endpoint of ['/compress', '/extract']) {
    for (const [body, code] of [[{}, 'MISSING_VIDEO'], [{ url: 'file:///etc/passwd' }, 'INVALID_URL'],
      [{ url: 'http://127.0.0.1/video' }, 'URL_NOT_ALLOWED']]) {
      const response = await fetch(base + endpoint, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, code);
    }
    const unauthorized = await fetch(base + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"http://127.0.0.1"}'
    });
    assert.equal(unauthorized.status, 401);
  }
  // Extraction cleanup is asynchronous after the response stream closes.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['files', 'source.mp4']);
});
