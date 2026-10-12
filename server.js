import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { existsSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import PDFDocument from 'pdfkit';

// ffmpeg binary: an explicit FFMPEG_PATH wins, then the bundled static build,
// then whatever `ffmpeg` is on PATH (how the Docker image provides it).
const ffmpegPath = process.env.FFMPEG_PATH
  || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : null);
if (ffmpegPath) {
  if (!existsSync(ffmpegPath)) {
    console.error(`FFMPEG_PATH does not exist: ${ffmpegPath}`);
    process.exit(1);
  }
  ffmpeg.setFfmpegPath(ffmpegPath);
}
console.log(`ffmpeg: ${ffmpegPath || 'from PATH'}`);

// ffprobe is optional: if unavailable we fall back to the duration that
// ffmpeg reports on its first pass (codecData event).
let ffprobeAvailable = false;
if (process.env.FFPROBE_PATH) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
  ffprobeAvailable = true;
} else {
  try {
    const { default: ffprobeStatic } = await import('ffprobe-static');
    if (ffprobeStatic?.path) {
      ffmpeg.setFfprobePath(ffprobeStatic.path);
      ffprobeAvailable = true;
    }
  } catch {
    console.warn('ffprobe not configured: duration will be read from ffmpeg output');
  }
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

// Transcripts arrive as JSON, form-urlencoded or raw text
const bodyLimit = process.env.TEXT_BODY_LIMIT || '20mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: false, limit: bodyLimit }));
app.use(express.text({ limit: bodyLimit, type: ['text/plain', 'text/markdown'] }));

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

// Generated files are named <32 hex>.<ext>, or <32 hex>.once.<ext> when the
// caller asked for the file to be dropped right after it is downloaded.
const FILE_NAME_RE = /^[a-f0-9]{32}(\.once)?\.(mp4|pdf)$/;

// Public download of compressed videos. Names are random (128 bits), so the
// URL itself is the credential; files are deleted after FILE_TTL_MINUTES at
// the latest, or as soon as they are fully downloaded if marked `.once`.
app.get('/files/:name', (req, res, next) => {
  const name = path.basename(req.params.name);
  if (!FILE_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid filename' });

  const oneShot = /\.once\.[a-z0-9]+$/.test(name);

  // Optional ?name=... only changes the filename the browser/client saves as
  const asName = sanitizeDownloadName(req.query?.name, path.extname(name));
  if (asName) res.setHeader('Content-Disposition', `attachment; filename="${asName}"`);
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

// Random, unguessable name for a generated file. The `.once` marker makes the
// download handler delete it as soon as it has been fully served.
function generatedName(ext, oneShot) {
  return `${crypto.randomBytes(16).toString('hex')}${oneShot ? '.once' : ''}.${ext}`;
}

// Keeps a caller-supplied download name but strips anything path- or
// header-unsafe, and forces the real extension.
function sanitizeDownloadName(raw, ext) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const base = path.basename(raw).replace(/[^\w .,()\-\u00c0-\u024f]/g, '_').slice(0, 120).trim();
  if (!base || base === '.' || base === '..') return null;
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

function isTruthy(value, fallback = false) {
  if (value == null) return fallback;
  return /^(1|true|yes)$/i.test(String(value));
}

function publicUrlFor(req, name) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${publicBaseUrl || `${proto}://${host}`}/files/${name}`;
}

// Configure multer for disk storage in OS temp dir. The stored name is random:
// an uploaded name can carry control characters (n8n sends the filename in a
// header and multer decodes it as latin1, so a multi-byte char turns into C1
// control bytes) and ffmpeg then fails to open the path with EINVAL.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').match(/^\.[A-Za-z0-9]{1,10}$/) || [''])[0];
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
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
  // The download name is only a header; the path on disk stays random
  const downloadName = sanitizeDownloadName(path.parse(req.file.originalname || '').name, '.mp3')
    || 'audio.mp3';
  const outPath = path.join(os.tmpdir(), generatedName('mp3', false));

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
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    // Stream the file then cleanup
    const stream = createReadStream(outPath);
    stream.on('close', async () => {
      // Best-effort cleanup
      try { await fs.unlink(outPath); } catch {}
      try { await fs.unlink(inputPath); } catch {}
    });
    stream.pipe(res);
  } catch (err) {
    // JSON-escaped so control characters in the uploaded name stay visible
    console.error('ffmpeg error:', err?.message || err);
    console.error('  original name:', JSON.stringify(req.file.originalname));
    console.error('  in:', inputPath, '-> out:', outPath);
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

  const deleteAfterDownload = isTruthy(opt('delete_after_download'), deleteAfterDownloadDefault);

  const inputPath = req.file.path;
  const outName = generatedName('mp4', deleteAfterDownload);
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

    res.json({
      video_url: publicUrlFor(req, outName),
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

// --- Transcript to PDF -------------------------------------------------

const PAGE_SIZES = ['A4', 'LETTER', 'LEGAL', 'A5'];

// Renders the transcript into a paginated PDF. Blank lines become paragraph
// breaks; every other line keeps its own break and wraps on its own.
function buildPdf(outPath, { text, title, subtitle, pageSize, fontSize, lineGap, margin }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: pageSize,
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      bufferPages: true,
      info: { Title: title || 'Transcripción', Creator: 'audio-extract-api' }
    });

    const stream = createWriteStream(outPath);
    stream.on('error', reject);
    doc.on('error', reject);

    if (title) {
      doc.font('Helvetica-Bold').fontSize(Math.round(fontSize * 1.7)).fillColor('#111');
      doc.text(title, { align: 'left' });
      doc.moveDown(0.25);
    }
    if (subtitle) {
      doc.font('Helvetica').fontSize(Math.round(fontSize * 0.85)).fillColor('#666');
      doc.text(subtitle, { align: 'left' });
      doc.moveDown(0.25);
    }
    if (title || subtitle) {
      const y = doc.y + 2;
      doc.moveTo(margin, y).lineTo(doc.page.width - margin, y).strokeColor('#dddddd').lineWidth(1).stroke();
      doc.moveDown(0.9);
    }

    doc.font('Helvetica').fontSize(fontSize).fillColor('#000');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let pendingBreak = false;
    for (const line of lines) {
      if (!line.trim()) {
        pendingBreak = true;
        continue;
      }
      if (pendingBreak) {
        doc.moveDown(0.6);
        pendingBreak = false;
      }
      doc.text(line, { align: 'left', lineGap });
    }

    // Page numbers, written below the bottom margin on each buffered page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // keep the footer from spawning a new page
      doc.font('Helvetica').fontSize(Math.round(fontSize * 0.8)).fillColor('#888');
      doc.text(
        `${i + 1} / ${range.count}`,
        margin,
        doc.page.height - margin * 0.6,
        { width: doc.page.width - margin * 2, align: 'center', lineBreak: false }
      );
    }

    stream.on('finish', () => resolve({ pages: range.count }));
    doc.pipe(stream);
    doc.end();
  });
}

// POST /pdf turns a transcript into a PDF.
// Body: JSON { text, title?, subtitle?, filename?, ... }, form-urlencoded,
// form-data or raw text/plain. Same options also accepted as query params.
// Returns JSON with pdf_url by default, or the PDF itself with response=file.
app.post('/pdf', requireAuth, upload.none(), async (req, res) => {
  const body = typeof req.body === 'string' ? { text: req.body } : (req.body || {});
  const opt = (name) => body?.[name] ?? req.query?.[name];

  const raw = opt('text') ?? opt('transcript');
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return res.status(400).json({
      error: 'No text provided. Send JSON { "text": "..." }, a form field "text", or a text/plain body.'
    });
  }

  const title = typeof opt('title') === 'string' ? opt('title').slice(0, 300) : '';
  const subtitle = typeof opt('subtitle') === 'string' ? opt('subtitle').slice(0, 300) : '';
  const pageSizeRaw = String(opt('page_size') || 'A4').toUpperCase();
  const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 'A4';
  const fontSize = Math.round(clamp(opt('font_size'), 6, 36, 11));
  const lineGap = Math.round(clamp(opt('line_gap'), 0, 20, 3));
  const margin = Math.round(clamp(opt('margin'), 18, 140, 56));
  const asFile = String(opt('response') || '').toLowerCase() === 'file';
  const deleteAfterDownload = isTruthy(opt('delete_after_download'), deleteAfterDownloadDefault);
  const downloadName = sanitizeDownloadName(opt('filename'), '.pdf');

  // In file mode nothing is published, so it goes straight to the temp dir
  const outName = generatedName('pdf', deleteAfterDownload);
  const outPath = asFile
    ? path.join(os.tmpdir(), outName)
    : path.join(filesDir, outName);

  try {
    const { pages } = await buildPdf(outPath, {
      text, title, subtitle, pageSize, fontSize, lineGap, margin
    });
    const { size } = await fs.stat(outPath);

    if (asFile) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName || 'transcript.pdf'}"`);
      const stream = createReadStream(outPath);
      stream.on('close', async () => { try { await fs.unlink(outPath); } catch {} });
      return stream.pipe(res);
    }

    const url = publicUrlFor(req, outName);
    res.json({
      pdf_url: downloadName ? `${url}?name=${encodeURIComponent(downloadName)}` : url,
      size_mb: Number((size / MB).toFixed(3)),
      size_bytes: size,
      pages,
      characters: text.length,
      filename: outName,
      expires_at: new Date(Date.now() + fileTtlMinutes * 60 * 1000).toISOString(),
      delete_after_download: deleteAfterDownload
    });
  } catch (err) {
    console.error('pdf error:', err?.message || err);
    try { await fs.unlink(outPath); } catch {}
    res.status(500).json({ error: 'Failed to build PDF', detail: String(err?.message || err) });
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
  console.log(`audio-extract-api listening on 0.0.0.0:${port} (files: ${filesDir}, tmp: ${os.tmpdir()})`);
});

// Compressing a long video can take several minutes; don't let the socket die
server.requestTimeout = 0;
server.headersTimeout = 120 * 1000;
server.timeout = 0;
