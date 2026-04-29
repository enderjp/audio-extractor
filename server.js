import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { fileURLToPath } from 'url';

// Configure ffmpeg binary
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();
const port = process.env.PORT || 3080;
const apiToken = process.env.API_TOKEN || '';

app.set('trust proxy', 'loopback');
app.use(helmet());

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

// Configure multer for disk storage in OS temp dir
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`)
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
    const stream = (await import('fs')).createReadStream(outPath);
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

// Basic error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`audio-extract-api listening on 127.0.0.1:${port}`);
});
