import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function inputError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Pin the connection to a validated DNS result; validate again on each redirect.
// IPv6 is restricted to global unicast, excluding embedded/transition IPv4 ranges.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3]
]) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function parseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw inputError(400, 'INVALID_URL', 'Provide an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

async function resolveTarget(url, signal, resolve) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([resolve(hostname, { all: true }), cancelled]);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw inputError(400, 'URL_NOT_ALLOWED', 'The URL must resolve to a public Internet address.');
    }
    return addresses[0];
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function downloadVideo(raw, {
  maxBytes = 1024 ** 3, timeoutMs = 300000, signal: clientSignal,
  tempDir = os.tmpdir(), resolve = lookup,
  request = (url, options, cb) => (url.protocol === 'https:' ? https : http).request(url, options, cb)
} = {}) {
  let url = parseUrl(raw);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = clientSignal ? AbortSignal.any([clientSignal, deadline]) : deadline;
  const inputPath = path.join(tempDir, `video-url-${crypto.randomBytes(16).toString('hex')}`);
  try {
    for (let redirects = 0; ; redirects++) {
      const target = await resolveTarget(url, signal, resolve);
      signal.throwIfAborted();
      const response = await new Promise((resolveResponse, reject) => {
        const req = request(url, {
          method: 'GET', agent: false, signal,
          headers: { 'Accept-Encoding': 'identity' },
          lookup: (hostname, options, callback) => {
            callback(null, options?.all ? [target] : target.address, target.family);
          }
        }, resolveResponse);
        req.on('error', reject);
        req.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (redirects >= 3 || !response.headers.location) {
          throw inputError(422, 'DOWNLOAD_REDIRECT', 'Video URL has too many redirects or an invalid redirect.');
        }
        try { url = parseUrl(new URL(response.headers.location, url).href); }
        catch { throw inputError(400, 'INVALID_URL', 'Invalid video URL redirect.'); }
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw inputError(422, 'DOWNLOAD_HTTP_ERROR', `Video URL returned HTTP ${response.statusCode}. Check that the signed URL has not expired.`);
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy();
        throw inputError(413, 'INPUT_TOO_LARGE', 'Video exceeds the input size limit.');
      }
      let size = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes
            ? inputError(413, 'INPUT_TOO_LARGE', 'Video exceeds the input size limit.')
            : null, chunk);
        }
      });
      await pipeline(response, counter, createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }), { signal });
      if (!size) throw inputError(422, 'DOWNLOAD_EMPTY', 'Video URL returned an empty file.');
      let originalname = 'video.mp4';
      try { originalname = path.basename(decodeURIComponent(url.pathname)) || originalname; } catch {}
      return { path: inputPath, size, originalname };
    }
  } catch (err) {
    await fs.unlink(inputPath).catch(() => {});
    if (clientSignal?.aborted) throw inputError(499, 'ABORTED', 'Client disconnected.');
    if (deadline.aborted) throw inputError(408, 'DOWNLOAD_TIMEOUT', 'Video download timed out.');
    if (err.status) throw err;
    if (['ENOSPC', 'EACCES', 'EROFS', 'EMFILE', 'EIO'].includes(err.code)) {
      throw inputError(500, 'DOWNLOAD_STORAGE_ERROR', 'Unable to store the video on disk.');
    }
    // Never expose signed URL query parameters through native error messages.
    throw inputError(422, 'DOWNLOAD_FAILED', 'Unable to download video. Check that the URL is reachable and has not expired.');
  }
}
