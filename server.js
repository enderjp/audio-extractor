import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

// Configure ffmpeg binary
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

// ffprobe is optional: if unavailable we fall back to the duration that
// ffmpeg reports on its first pass (codecData event).
let ffprobeAvailable = false;
try {
  const { default: ffprobeStatic } = await import('ffprobe-static');
  if (ffprobeStatic?.path) {
    ffmpeg.setFfprobePath(ffprobeStatic.path);
    ffprobeAvailable = true;
  }
} catch {
  console.warn('ffprobe-static not installed: duration will be read from ffmpeg output');
}

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const port = process.env.PORT || 3080;
const apiToken = process.env.API_TOKEN || '';

// Where compressed videos are published from, and for how long they live
const filesDir = process.env.FILES_DIR || path.join(process.cwd(), 'files');
const fileTtlMinutes = Number(process.env.FILE_TTL_MINUTES || 180);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// Default for /compress?delete_after_download: borrar en cuanto se descarga
const deleteAfterDownloadDefault = /^(1|true|yes)$/i.test(process.env.DELETE_AFTER_DOWNLOAD || '');

await fs.mkdir(filesDir, { recursive: true });

app.set('trust proxy', 'loopback');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

// Auth middleware (Bearer token)
function requireAuth(req, res, next) {
  if (!apiToken) return res.status(503).json({ error: 'API not configured (missing API_TOKEN)' });
  const auth = req.headers['authorization'] || '';
  const match = auth.startsWith('Bearer ')? auth.slice(7): '';
  if (match && match === apiToken) return next();
  res.setHeader('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Unauthorized' });
}

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'audio-extract-api' });
});

// Compressed videos are named <32 hex>.mp4, or <32 hex>.once.mp4 when the
// caller asked for the file to be dropped right after it is downloaded.
const FILE_NAME_RE = /^[a-f0-9]{32}(\.once)?\.mp4$/;

// Public download of compressed videos. Names are random (128 bits), so the
// URL itself is the credential; files are deleted after FILE_TTL_MINUTES at
// the latest, or as soon as they are fully downloaded if marked `.once`.
app.get('/files/:name', (req, res, next) => {
  const name = path.basename(req.params.name);
  if (!FILE_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid filename' });

  const oneShot = name.endsWith('.once.mp4');
  if (oneShot) {
    // A partial download must stay downloadable, so don't serve ranges
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
  }

  res.sendFile(name, {
    root: filesDir,
    acceptRanges: !oneShot,
    maxAge: oneShot ? 0 : '1h',
    dotfiles: 'deny'
  }, (err) => {
    if (err) {
      if (res.headersSent) return res.destroy();
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'Not found or expired' });
      return next(err);
    }
    // Only drop the file once the whole body actually made it out
    if (oneShot && res.writableEnded && res.statusCode === 200) {
      fs.unlink(path.join(filesDir, name))
        .then(() => console.log(`one-shot delete: ${name}`))
        .catch(() => {});
    }
  });
});

// Configure multer for disk storage in OS temp dir
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(file.originalname)}`)
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1 GB max
  }
});

// POST /extract expects form-data with field "video"
app.post('/extract', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data field "video".' });
  }

  const inputPath = req.file.path;
  const baseName = path.parse(req.file.originalname).name || 'audio';
  const outPath = path.join(os.tmpdir(), `${baseName}-${Date.now()}.mp3`);

  try {
    // Transcode to MP3 with sensible defaults (128k bitrate, 44100 Hz)
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .audioFrequency(44100)
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .save(outPath);
    });

    const stat = await fs.stat(outPath);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.mp3"`);

    // Stream the file then cleanup
    const stream = createReadStream(outPath);
    stream.on('close', async () => {
      // Best-effort cleanup
      try { await fs.unlink(outPath); } catch {}
      try { await fs.unlink(inputPath); } catch {}
    });
    stream.pipe(res);
  } catch (err) {
    console.error('ffmpeg error:', err?.message || err);
    try { await fs.unlink(outPath); } catch {}
    try { await fs.unlink(inputPath); } catch {}
    res.status(500).json({ error: 'Failed to extract audio', detail: String(err?.message || err) });
  }
});

// --- Video compression -------------------------------------------------

const MB = 1024 * 1024;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Builds the common filter chain: downscale (never upscale) + cap fps
function videoFilter({ maxWidth, maxHeight, fps }) {
  return `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${fps}`;
}

// Runs one ffmpeg encode. `rate` is either {crf} or {videoBitrateKbps}.
function encode({ inputPath, outPath, filter, preset, audioBitrateKbps, rate }) {
  return new Promise((resolve, reject) => {
    let duration = null;
    const options = ['-vf', filter, '-preset', preset, '-movflags', '+faststart'];

    if (rate.crf != null) {
      options.push('-crf', String(rate.crf));
    } else {
      const kbps = rate.videoBitrateKbps;
      options.push(
        '-b:v', `${kbps}k`,
        '-maxrate', `${Math.round(kbps * 1.5)}k`,
        '-bufsize', `${Math.round(kbps * 2)}k`
      );
    }

    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate(`${audioBitrateKbps}k`)
      .outputOptions(options)
      .format('mp4')
      .on('codecData', (data) => {
        // data.duration looks like "00:12:34.56"
        const parts = String(data?.duration || '').split(':').map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
          duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      })
      .on('error', reject)
      .on('end', () => resolve({ duration }))
      .save(outPath);
  });
}

function probeDuration(inputPath) {
  if (!ffprobeAvailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    ffmpeg(inputPath).ffprobe((err, data) => {
      const d = Number(data?.format?.duration);
      resolve(!err && Number.isFinite(d) && d > 0 ? d : null);
    });
  });
}

// POST /compress expects form-data with field "video".
// Optional fields (form-data or query): max_mb, max_width, max_height, fps,
// crf, audio_kbps, preset.
app.post('/compress', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data field "video".' });
  }

  const opt = (name) => req.body?.[name] ?? req.query?.[name];

  const maxMb = clamp(opt('max_mb'), 1, 2048, 74);
  const maxWidth = Math.round(clamp(opt('max_width'), 160, 3840, 1280));
  const maxHeight = Math.round(clamp(opt('max_height'), 120, 2160, 720));
  const fps = clamp(opt('fps'), 1, 60, 15);
  const crf = Math.round(clamp(opt('crf'), 0, 51, 28));
  const audioBitrateKbps = Math.round(clamp(opt('audio_kbps'), 16, 320, 96));
  const preset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow']
    .includes(String(opt('preset'))) ? String(opt('preset')) : 'fast';

  const rawFlag = opt('delete_after_download');
  const deleteAfterDownload = rawFlag == null
    ? deleteAfterDownloadDefault
    : /^(1|true|yes)$/i.test(String(rawFlag));

  const inputPath = req.file.path;
  const outName = `${crypto.randomBytes(16).toString('hex')}${deleteAfterDownload ? '.once' : ''}.mp4`;
  const outPath = path.join(filesDir, outName);
  const filter = videoFilter({ maxWidth, maxHeight, fps });
  const targetBytes = maxMb * MB;

  // Leave headroom so the muxer overhead / rate-control drift stays under target
  const budgetBytes = Math.floor(targetBytes * 0.95);

  const attempts = [];
  let duration = await probeDuration(inputPath);

  try {
    // Pass 1: constant quality. Good videos land well under target already.
    const first = await encode({ inputPath, outPath, filter, preset, audioBitrateKbps, rate: { crf } });
    if (!duration) duration = first.duration;
    let size = (await fs.stat(outPath)).size;
    attempts.push({ mode: `crf ${crf}`, size_mb: Number((size / MB).toFixed(2)) });

    // Passes 2..4: if still too big, switch to a bitrate computed from the
    // remaining budget, correcting with the measured size each round.
    let round = 0;
    while (size > targetBytes && round < 3) {
      if (!duration || duration <= 0) {
        throw new Error('Cannot determine video duration to hit the size target');
      }
      const totalKbps = (budgetBytes * 8) / 1000 / duration;
      let videoKbps = Math.floor(totalKbps - audioBitrateKbps);

      if (round > 0) {
        // Scale down proportionally to how much we overshot last time
        videoKbps = Math.floor(videoKbps * (budgetBytes / size));
      }
      if (videoKbps < 48) {
        throw new Error(`Video too long for ${maxMb} MB: needs < 48 kbps of video`);
      }

      await encode({ inputPath, outPath, filter, preset, audioBitrateKbps, rate: { videoBitrateKbps: videoKbps } });
      size = (await fs.stat(outPath)).size;
      attempts.push({ mode: `${videoKbps} kbps`, size_mb: Number((size / MB).toFixed(2)) });
      round += 1;
    }

    if (size > targetBytes) {
      throw new Error(`Could not get under ${maxMb} MB (best: ${(size / MB).toFixed(2)} MB)`);
    }

    const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = publicBaseUrl || `${proto}://${host}`;

    res.json({
      video_url: `${baseUrl}/files/${outName}`,
      size_mb: Number((size / MB).toFixed(2)),
      filename: outName,
      original_filename: req.file.originalname,
      original_size_mb: Number((req.file.size / MB).toFixed(2)),
      duration_sec: duration ? Number(duration.toFixed(2)) : null,
      expires_at: new Date(Date.now() + fileTtlMinutes * 60 * 1000).toISOString(),
      delete_after_download: deleteAfterDownload,
      attempts
    });
  } catch (err) {
    console.error('compress error:', err?.message || err);
    try { await fs.unlink(outPath); } catch {}
    res.status(500).json({ error: 'Failed to compress video', detail: String(err?.message || err) });
  } finally {
    try { await fs.unlink(inputPath); } catch {}
  }
});

// DELETE /files/:name lets the caller drop a file as soon as it was consumed
app.delete('/files/:name', requireAuth, async (req, res) => {
  const name = path.basename(req.params.name);
  if (!FILE_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    await fs.unlink(path.join(filesDir, name));
    res.json({ ok: true, deleted: name });
  } catch (err) {
    if (err?.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Periodic cleanup of expired compressed videos
async function sweepFiles() {
  const cutoff = Date.now() - fileTtlMinutes * 60 * 1000;
  try {
    for (const name of await fs.readdir(filesDir)) {
      const full = path.join(filesDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(full);
      } catch {}
    }
  } catch (err) {
    console.error('sweep error:', err?.message || err);
  }
}
sweepFiles();
setInterval(sweepFiles, 10 * 60 * 1000).unref();

// Basic error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`audio-extract-api listening on 0.0.0.0:${port} (files: ${filesDir})`);
});

// Compressing a long video can take several minutes; don't let the socket die
server.requestTimeout = 0;
server.headersTimeout = 120 * 1000;
server.timeout = 0;
