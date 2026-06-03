'use strict';
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID: uuidv4 } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { createCanvas } = require('canvas');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Upload & output directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// In-memory render status store
const renderJobs = {};

// ─────────────────────────────────────────────
// Helper: Kirim notifikasi ke Drive Uploader Service
// ─────────────────────────────────────────────
async function notifyDriveUpload(renderId, videoType, metadata = {}) {
  const driveUploaderUrl = process.env.DRIVE_UPLOADER_URL;
  if (!driveUploaderUrl) return null;
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const videoUrl = `${baseUrl}/download/${renderId}`;
  const filename = `${videoType}-${renderId}.mp4`;
  try {
    const axios = require('axios');
    const resp = await axios.post(`${driveUploaderUrl}/upload-to-drive`, {
      video_url: videoUrl,
      filename,
      video_type: videoType,
      metadata: { ...metadata, created_at: new Date().toISOString() },
    }, { timeout: 10000 });
    return resp.data;
  } catch (err) {
    console.error('[Drive Upload] Gagal notifikasi:', err.message);
    return null;
  }
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const fileId = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${fileId}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─────────────────────────────────────────────
// Helper: Buat URL publik untuk file output
// ─────────────────────────────────────────────
function makeVideoUrl(req, renderId) {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/download/${renderId}`;
}

// ─────────────────────────────────────────────
// Helper: Get file path dari fileId
// ─────────────────────────────────────────────
function getFilePath(fileId) {
  const files = fs.readdirSync(UPLOAD_DIR);
  const found = files.find((f) => f.startsWith(fileId));
  if (!found) throw new Error(`File tidak ditemukan: ${fileId}`);
  return path.join(UPLOAD_DIR, found);
}

// ─────────────────────────────────────────────
// Helper: Get video info (durasi, resolusi)
// ─────────────────────────────────────────────
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const stream = metadata.streams.find((s) => s.codec_type === 'video');
      resolve({
        duration: metadata.format.duration,
        width: stream ? stream.width : null,
        height: stream ? stream.height : null,
        resolution: stream ? `${stream.width}x${stream.height}` : 'unknown',
      });
    });
  });
}

// ─────────────────────────────────────────────
// GET /download/:renderId  — Unduh video hasil render
// ─────────────────────────────────────────────
app.get('/download/:renderId', (req, res) => {
  const outputPath = path.join(OUTPUT_DIR, `${req.params.renderId}.mp4`);
  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'File tidak ditemukan' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.renderId}.mp4"`);
  fs.createReadStream(outputPath).pipe(res);
});

// ─────────────────────────────────────────────
// POST /upload
// ─────────────────────────────────────────────
app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diupload' });
    const fileId = path.basename(req.file.filename, path.extname(req.file.filename));
    const info = await getVideoInfo(req.file.path);
    res.json({ fileId, duration: info.duration, resolution: info.resolution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /upload-base64
// ─────────────────────────────────────────────
app.post('/upload-base64', async (req, res) => {
  try {
    const { fileBase64, filename } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 diperlukan' });
    const ext = path.extname(filename || '.mp4') || '.mp4';
    const fileId = uuidv4();
    const filePath = path.join(UPLOAD_DIR, `${fileId}${ext}`);
    const buffer = Buffer.from(fileBase64, 'base64');
    fs.writeFileSync(filePath, buffer);
    const info = await getVideoInfo(filePath);
    res.json({ fileId, duration: info.duration, resolution: info.resolution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// Helper: Buat frame PNG menggunakan canvas
// ─────────────────────────────────────────────
function createBackgroundFrame(width, height, bgColor) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // Konversi warna hex 0x format ke #format
  let color = bgColor;
  if (color.startsWith('0x')) color = '#' + color.slice(2);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

function createSceneFrame(width, height, bgColor, text, subtext, textColor, fontSize = 60) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // Background
  let bg = bgColor;
  if (bg.startsWith('0x')) bg = '#' + bg.slice(2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  // Text color
  let tc = textColor;
  if (tc.startsWith('0x')) tc = '#' + tc.slice(2);
  // Main text
  ctx.fillStyle = tc;
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (text) ctx.fillText(text, width / 2, height / 2);
  // Subtext
  if (subtext) {
    ctx.font = `${Math.round(fontSize * 0.5)}px Arial`;
    ctx.fillText(subtext, width / 2, height / 2 + fontSize);
  }
  return canvas.toBuffer('image/png');
}

// ─────────────────────────────────────────────
// POST /render-text-video
// ─────────────────────────────────────────────
app.post('/render-text-video', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'Rendering dimulai' });

  try {
    const { scenes, style = 'cinematic', duration = 30 } = req.body;
    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);

    const styleColors = {
      cinematic: { bg: 'black', text: 'white', font: 'Arial' },
      vlog: { bg: 'white', text: 'black', font: 'Arial' },
      business: { bg: '#1a1a2e', text: '#e0e0e0', font: 'Arial' },
      music_video: { bg: '#0d0d0d', text: '#ffd700', font: 'Arial' },
      tutorial: { bg: '#f5f5f5', text: '#333333', font: 'Arial' },
      trader: { bg: '#0a0a0a', text: '#00ff88', font: 'Arial' },
    };
    const colors = styleColors[style] || styleColors.cinematic;

    const sceneList = Array.isArray(scenes) ? scenes : [{ text: 'Video Studio', duration: duration }];
    const totalDuration = sceneList.reduce((sum, s) => sum + (s.duration || 3), 0);
    const tempFiles = [];

    // Buat video per-scene lalu concat
    const sceneVideos = [];
    for (let i = 0; i < sceneList.length; i++) {
      const scene = sceneList[i];
      const sceneDur = scene.duration || 3;
      const text = scene.text || '';
      const subtext = scene.subtext || '';

      // Buat frame PNG untuk scene ini
      const framePath = path.join(OUTPUT_DIR, `frame_${renderId}_${i}.png`);
      const frameBuffer = createSceneFrame(1920, 1080, colors.bg, text, subtext, colors.text);
      fs.writeFileSync(framePath, frameBuffer);
      tempFiles.push(framePath);

      // Render scene video dari gambar statis
      const sceneVideo = path.join(OUTPUT_DIR, `scene_${renderId}_${i}.mp4`);
      tempFiles.push(sceneVideo);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(framePath)
          .inputOptions(['-loop', '1', '-framerate', '30'])
          .outputOptions([
            '-c:v', 'libx264',
            '-t', String(sceneDur),
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1920:1080',
          ])
          .output(sceneVideo)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      sceneVideos.push(sceneVideo);
      renderJobs[renderId].progress = Math.round(((i + 1) / sceneList.length) * 70);
    }

    // Concat semua scene
    if (sceneVideos.length === 1) {
      fs.copyFileSync(sceneVideos[0], outputPath);
    } else {
      const concatList = path.join(OUTPUT_DIR, `concat_${renderId}.txt`);
      const concatContent = sceneVideos.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(concatList, concatContent);
      tempFiles.push(concatList);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatList)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    }

    // Cleanup temp files
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'text_video', { title: sceneList[0]?.text || 'Text Video', style }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// POST /edit-video
// ─────────────────────────────────────────────
app.post('/edit-video', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'Editing dimulai' });

  try {
    const { files: fileIds, instructions = {} } = req.body;
    const {
      trim = [],
      order = fileIds,
      textOverlays = [],
      musicFile = null,
      musicVolume = 0.3,
      speed = 1.0,
    } = instructions;

    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);
    const tempFiles = [];

    // Step 1: Trim
    const processedFiles = [];
    for (const fid of (order || fileIds)) {
      const srcPath = getFilePath(fid);
      const trimInstr = trim.find((t) => t.fileId === fid);
      if (trimInstr) {
        const trimmed = path.join(OUTPUT_DIR, `trim_${uuidv4()}.mp4`);
        tempFiles.push(trimmed);
        await new Promise((resolve, reject) => {
          ffmpeg(srcPath)
            .setStartTime(trimInstr.start || 0)
            .setDuration((trimInstr.end || 10) - (trimInstr.start || 0))
            .output(trimmed)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        processedFiles.push(trimmed);
      } else {
        processedFiles.push(srcPath);
      }
    }

    renderJobs[renderId].progress = 30;

    // Step 2: Concat
    const concatList = path.join(OUTPUT_DIR, `concat_${renderId}.txt`);
    const concatContent = processedFiles.map((f) => `file '${f}'`).join('\n');
    fs.writeFileSync(concatList, concatContent);
    tempFiles.push(concatList);

    const concatOutput = path.join(OUTPUT_DIR, `concat_${renderId}.mp4`);
    tempFiles.push(concatOutput);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatList)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p'])
        .output(concatOutput)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    renderJobs[renderId].progress = 60;

    // Step 3: Text overlays
    let currentInput = concatOutput;
    if (textOverlays.length > 0) {
      const textOutput = path.join(OUTPUT_DIR, `text_${renderId}.mp4`);
      tempFiles.push(textOutput);
      const filters = textOverlays.map((t) => {
        const txt = (t.text || '').replace(/'/g, "\\'");
        const pos = t.position || 'bottom';
        const x = pos.includes('right') ? 'w-text_w-20' : pos.includes('left') ? '20' : '(w-text_w)/2';
        const y = pos.includes('top') ? '20' : '(h-text_h-20)';
        return `drawtext=text='${txt}':fontcolor=white:fontsize=40:x=${x}:y=${y}:enable='between(t,${t.startTime || 0},${t.endTime || 5})'`;
      }).join(',');

      await new Promise((resolve, reject) => {
        ffmpeg(currentInput)
          .videoFilters(filters)
          .outputOptions(['-c:v', 'libx264', '-c:a', 'copy'])
          .output(textOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      currentInput = textOutput;
    }

    renderJobs[renderId].progress = 80;

    // Step 4: Musik background
    if (musicFile) {
      const musicPath = getFilePath(musicFile);
      const musicOutput = path.join(OUTPUT_DIR, `music_${renderId}.mp4`);
      tempFiles.push(musicOutput);
      await new Promise((resolve, reject) => {
        ffmpeg(currentInput)
          .input(musicPath)
          .complexFilter([
            `[1:a]volume=${musicVolume}[music]`,
            `[0:a][music]amix=inputs=2:duration=first[aout]`,
          ])
          .outputOptions(['-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-shortest'])
          .output(musicOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      currentInput = musicOutput;
    }

    // Step 5: Speed
    if (speed !== 1.0) {
      const speedOutput = path.join(OUTPUT_DIR, `speed_${renderId}.mp4`);
      tempFiles.push(speedOutput);
      await new Promise((resolve, reject) => {
        ffmpeg(currentInput)
          .videoFilters(`setpts=${1 / speed}*PTS`)
          .audioFilters(`atempo=${speed}`)
          .outputOptions(['-c:v', 'libx264'])
          .output(speedOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      currentInput = speedOutput;
    }

    fs.copyFileSync(currentInput, outputPath);
    tempFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'edited', { title: 'Edited Video' }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// POST /picture-in-picture
// ─────────────────────────────────────────────
app.post('/picture-in-picture', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'PiP processing dimulai' });

  try {
    const { mainVideo, facecamVideo, position = 'bottom-right', size = '25%' } = req.body;
    const mainPath = getFilePath(mainVideo);
    const facecamPath = getFilePath(facecamVideo);
    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);

    const sizePercent = parseInt(size) / 100;
    const overlayX = position.includes('right') ? 'main_w-overlay_w-20' : '20';
    const overlayY = position.includes('top') ? '20' : 'main_h-overlay_h-20';

    await new Promise((resolve, reject) => {
      ffmpeg(mainPath)
        .input(facecamPath)
        .complexFilter([
          `[1:v]scale=iw*${sizePercent}:ih*${sizePercent}[pip]`,
          `[0:v][pip]overlay=${overlayX}:${overlayY}[v]`,
        ])
        .outputOptions(['-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-c:a', 'aac', '-shortest'])
        .output(outputPath)
        .on('progress', (p) => { renderJobs[renderId].progress = Math.min(90, Math.round(p.percent || 0)); })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'pip', { title: 'Picture-in-Picture Video' }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// POST /add-subtitles
// ─────────────────────────────────────────────
app.post('/add-subtitles', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'Subtitle processing dimulai' });

  try {
    const { fileId, subtitles = [] } = req.body;
    const srcPath = getFilePath(fileId);
    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);

    const srtPath = path.join(OUTPUT_DIR, `${renderId}.srt`);
    const srtContent = subtitles.map((s, i) => {
      const startTime = formatSrtTime(s.start);
      const endTime = formatSrtTime(s.end);
      return `${i + 1}\n${startTime} --> ${endTime}\n${s.text}\n`;
    }).join('\n');
    fs.writeFileSync(srtPath, srtContent);

    await new Promise((resolve, reject) => {
      ffmpeg(srcPath)
        .outputOptions([
          '-vf', `subtitles=${srtPath}:force_style='FontSize=24,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2'`,
          '-c:v', 'libx264',
          '-c:a', 'copy',
        ])
        .output(outputPath)
        .on('progress', (p) => { renderJobs[renderId].progress = Math.min(90, Math.round(p.percent || 0)); })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    fs.unlink(srtPath, () => {});
    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'edited', { title: 'Video with Subtitles' }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// POST /google-search-animation
// ─────────────────────────────────────────────
app.post('/google-search-animation', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'Google search animation dimulai' });

  try {
    const { searchQuery = 'Search query', results = [], style = 'light' } = req.body;
    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);
    const duration = 5 + results.length * 1.5;
    const tempFiles = [];

    const bgColor = style === 'dark' ? '#1a1a1a' : '#ffffff';
    const textColor = style === 'dark' ? '#ffffff' : '#202124';
    const linkColor = '#1a0dab';

    // Buat frame PNG yang menampilkan Google Search UI
    const width = 1920;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // Google logo area
    ctx.fillStyle = style === 'dark' ? '#e8eaed' : '#4285f4';
    ctx.font = 'bold 40px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('Google', 80, 60);

    // Search bar
    ctx.strokeStyle = style === 'dark' ? '#5f6368' : '#dfe1e5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Rounded rect manual (kompatibel semua versi canvas)
    const rx = 80, ry = 80, rw = 800, rh = 50, rr = 25;
    ctx.moveTo(rx + rr, ry);
    ctx.lineTo(rx + rw - rr, ry);
    ctx.arcTo(rx + rw, ry, rx + rw, ry + rr, rr);
    ctx.lineTo(rx + rw, ry + rh - rr);
    ctx.arcTo(rx + rw, ry + rh, rx + rw - rr, ry + rh, rr);
    ctx.lineTo(rx + rr, ry + rh);
    ctx.arcTo(rx, ry + rh, rx, ry + rh - rr, rr);
    ctx.lineTo(rx, ry + rr);
    ctx.arcTo(rx, ry, rx + rr, ry, rr);
    ctx.closePath();
    ctx.stroke();

    // Search query text
    ctx.fillStyle = textColor;
    ctx.font = '20px Arial';
    ctx.fillText(searchQuery, 110, 112);

    // Results
    const resultItems = results.slice(0, 5);
    resultItems.forEach((result, i) => {
      const yBase = 200 + i * 100;
      // URL-like text
      ctx.fillStyle = style === 'dark' ? '#bdc1c6' : '#202124';
      ctx.font = '14px Arial';
      ctx.fillText('www.example.com', 80, yBase);
      // Title (link)
      ctx.fillStyle = linkColor;
      ctx.font = '20px Arial';
      ctx.fillText(result.substring(0, 70), 80, yBase + 28);
      // Description
      ctx.fillStyle = style === 'dark' ? '#bdc1c6' : '#4d5156';
      ctx.font = '16px Arial';
      ctx.fillText('Lorem ipsum dolor sit amet, consectetur adipiscing elit...', 80, yBase + 55);
    });

    const framePath = path.join(OUTPUT_DIR, `gsearch_${renderId}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
    tempFiles.push(framePath);

    // Render video dari gambar statis
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(framePath)
        .inputOptions(['-loop', '1', '-framerate', '30'])
        .outputOptions([
          '-c:v', 'libx264',
          '-t', String(Math.ceil(duration)),
          '-pix_fmt', 'yuv420p',
          '-vf', 'scale=1920:1080',
        ])
        .output(outputPath)
        .on('progress', (p) => { renderJobs[renderId].progress = Math.min(90, Math.round(p.percent || 0)); })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Cleanup
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'rendered', { title: `Google Search: ${searchQuery}` }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// POST /combine-videos
// ─────────────────────────────────────────────
app.post('/combine-videos', async (req, res) => {
  const renderId = uuidv4();
  renderJobs[renderId] = { status: 'processing', progress: 0 };
  res.json({ renderId, message: 'Combine videos dimulai' });

  try {
    const { fileIds, music = null } = req.body;
    const outputPath = path.join(OUTPUT_DIR, `${renderId}.mp4`);
    const tempFiles = [];

    const concatList = path.join(OUTPUT_DIR, `concat_${renderId}.txt`);
    const filePaths = fileIds.map((fid) => getFilePath(fid));
    const concatContent = filePaths.map((f) => `file '${f}'`).join('\n');
    fs.writeFileSync(concatList, concatContent);
    tempFiles.push(concatList);

    let currentOutput = path.join(OUTPUT_DIR, `combined_${renderId}.mp4`);
    tempFiles.push(currentOutput);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatList)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p'])
        .output(currentOutput)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    renderJobs[renderId].progress = 60;

    if (music) {
      const musicPath = getFilePath(music);
      const musicOutput = path.join(OUTPUT_DIR, `music_${renderId}.mp4`);
      tempFiles.push(musicOutput);
      await new Promise((resolve, reject) => {
        ffmpeg(currentOutput)
          .input(musicPath)
          .complexFilter([
            '[1:a]volume=0.3[music]',
            '[0:a][music]amix=inputs=2:duration=first[aout]',
          ])
          .outputOptions(['-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-shortest'])
          .output(musicOutput)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      currentOutput = musicOutput;
    }

    fs.copyFileSync(currentOutput, outputPath);
    tempFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

    renderJobs[renderId] = {
      status: 'done',
      progress: 100,
      videoUrl: `/download/${renderId}`,
      renderId,
    };
    // Upload otomatis ke Google Drive
    notifyDriveUpload(renderId, 'merged', { title: 'Combined Video' }).then(driveResult => {
      if (driveResult?.view_link) renderJobs[renderId].driveUrl = driveResult.view_link;
    });
  } catch (err) {
    renderJobs[renderId] = { status: 'error', progress: 0, error: err.message };
  }
});

// ─────────────────────────────────────────────
// GET /status/:renderId
// ─────────────────────────────────────────────
app.get('/status/:renderId', (req, res) => {
  const job = renderJobs[req.params.renderId];
  if (!job) return res.status(404).json({ error: 'Render job tidak ditemukan' });
  res.json(job);
});

// ─────────────────────────────────────────────
// GET /templates
// ─────────────────────────────────────────────
app.get('/templates', (req, res) => {
  res.json({
    sceneTypes: [
      { id: 'title_scene', name: 'Title Scene', desc: 'Judul besar di tengah layar' },
      { id: 'text_scene', name: 'Text Scene', desc: 'Teks utama + subtext' },
      { id: 'lyric_scene', name: 'Lyric Scene', desc: 'Teks lirik satu per satu' },
      { id: 'tips_scene', name: 'Tips Scene', desc: 'Numbered list tips' },
      { id: 'split_scene', name: 'Split Scene', desc: 'Teks kiri, visual kanan' },
      { id: 'outro_scene', name: 'Outro Scene', desc: 'Penutup dengan CTA' },
      { id: 'lower_third', name: 'Lower Third', desc: 'Teks bawah seperti berita TV' },
      { id: 'google_search', name: 'Google Search', desc: 'Animasi tampilan pencarian Google' },
      { id: 'phone_mockup', name: 'Phone Mockup', desc: 'Tampilan layar HP' },
      { id: 'data_scene', name: 'Data Scene', desc: 'Angka besar + label untuk bisnis' },
    ],
    animations: ['fadeIn', 'fadeOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'zoomIn', 'zoomOut', 'typewriter', 'bounce', 'shake'],
    stylePresets: [
      { id: 'cinematic', name: 'Cinematic', desc: 'Gelap, elegan' },
      { id: 'vlog', name: 'Vlog', desc: 'Cerah, casual' },
      { id: 'business', name: 'Business', desc: 'Bersih, profesional' },
      { id: 'music_video', name: 'Music Video', desc: 'Bold, dramatis' },
      { id: 'tutorial', name: 'Tutorial', desc: 'Clean, informatif' },
      { id: 'trader', name: 'Trader', desc: 'Dark mode, chart style' },
    ],
  });
});

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Video Studio Backend', 
    version: '3.0.0',
    googleDriveIntegration: !!process.env.DRIVE_UPLOADER_URL,
    driveFolderUrl: 'https://drive.google.com/drive/folders/1dXb_6JfB0XyT7wXCHGMRPW2k4b888lMQ'
  });
});

// ─────────────────────────────────────────────
// Helper: Format waktu untuk SRT
// ─────────────────────────────────────────────
function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ─────────────────────────────────────────────
// MCP Streamable HTTP Endpoint (untuk Claude AI web)
// Protokol: JSON-RPC 2.0 via POST /mcp
// ─────────────────────────────────────────────
const MCP_TOOLS = [
  {
    name: 'render_text_video',
    description: 'Buat video dari teks dengan animasi. Cocok untuk konten edukasi, lirik, tips, atau presentasi.',
    inputSchema: {
      type: 'object',
      properties: {
        scenes: { type: 'array', description: 'Array scene. Setiap scene: {type, text, subtext, duration, animation, style}' },
        outputFormat: { type: 'string', enum: ['mp4', 'webm'], default: 'mp4' },
        resolution: { type: 'string', enum: ['1920x1080', '1080x1920', '1280x720'], default: '1920x1080' },
      },
      required: ['scenes'],
    },
  },
  {
    name: 'edit_video',
    description: 'Edit video: trim, crop, tambah teks overlay, musik background, ubah kecepatan.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'ID file video yang sudah diupload' },
        trim: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } },
        textOverlay: { type: 'object', properties: { text: { type: 'string' }, position: { type: 'string' }, fontSize: { type: 'number' }, color: { type: 'string' }, startTime: { type: 'number' }, endTime: { type: 'number' } } },
        speed: { type: 'number', description: 'Kecepatan video: 0.5=lambat, 1=normal, 2=cepat' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'combine_videos',
    description: 'Gabungkan beberapa video menjadi satu video panjang.',
    inputSchema: {
      type: 'object',
      properties: {
        fileIds: { type: 'array', items: { type: 'string' }, description: 'Array ID file video' },
        music: { type: 'string', description: 'ID file musik background (opsional)' },
      },
      required: ['fileIds'],
    },
  },
  {
    name: 'picture_in_picture',
    description: 'Tambahkan video kecil di atas video utama (picture-in-picture).',
    inputSchema: {
      type: 'object',
      properties: {
        mainVideoId: { type: 'string' },
        overlayVideoId: { type: 'string' },
        position: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], default: 'bottom-right' },
        scale: { type: 'number', description: 'Ukuran overlay 0.1-0.5', default: 0.3 },
      },
      required: ['mainVideoId', 'overlayVideoId'],
    },
  },
  {
    name: 'add_subtitles',
    description: 'Tambahkan subtitle/teks ke video.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        subtitles: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } } } },
      },
      required: ['fileId', 'subtitles'],
    },
  },
  {
    name: 'google_search_animation',
    description: 'Buat animasi tampilan pencarian Google untuk konten viral.',
    inputSchema: {
      type: 'object',
      properties: {
        searchQuery: { type: 'string' },
        results: { type: 'array', items: { type: 'string' } },
        style: { type: 'string', enum: ['light', 'dark'], default: 'light' },
      },
      required: ['searchQuery'],
    },
  },
  {
    name: 'get_templates',
    description: 'Dapatkan daftar semua template scene, animasi, dan style preset yang tersedia.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_render_status',
    description: 'Cek status render video. Gunakan renderId dari hasil render sebelumnya.',
    inputSchema: {
      type: 'object',
      properties: { renderId: { type: 'string' } },
      required: ['renderId'],
    },
  },
  {
    name: 'upload_video_url',
    description: 'Upload video dari URL publik ke server untuk diproses.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL publik video' }, filename: { type: 'string' } },
      required: ['url'],
    },
  },
];

// MCP session store
const mcpSessions = {};

// GET /mcp - untuk SSE atau info
app.get('/mcp', (req, res) => {
  res.json({ name: 'Video Studio MCP', version: '1.0.0', tools: MCP_TOOLS.map(t => t.name) });
});

// POST /mcp - JSON-RPC 2.0 handler
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;
  
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  try {
    if (method === 'initialize') {
      const sessionId = uuidv4();
      mcpSessions[sessionId] = { initialized: true, clientInfo: params.clientInfo };
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'video-studio-mcp', version: '1.0.0' },
        },
      });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      let result;

      if (name === 'get_templates') {
        const templates = await require('axios').get(`${baseUrl}/templates`);
        result = { content: [{ type: 'text', text: JSON.stringify(templates.data, null, 2) }] };
      } else if (name === 'check_render_status') {
        const job = renderJobs[args.renderId];
        if (!job) return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Render job tidak ditemukan' }] } });
        result = { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
      } else if (name === 'render_text_video') {
        const resp = await require('axios').post(`${baseUrl}/render-text-video`, args);
        result = { content: [{ type: 'text', text: `Render dimulai! renderId: ${resp.data.renderId}. Gunakan check_render_status untuk memantau progress. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'edit_video') {
        const resp = await require('axios').post(`${baseUrl}/edit-video`, args);
        result = { content: [{ type: 'text', text: `Edit dimulai! renderId: ${resp.data.renderId}. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'combine_videos') {
        const resp = await require('axios').post(`${baseUrl}/combine-videos`, args);
        result = { content: [{ type: 'text', text: `Combine dimulai! renderId: ${resp.data.renderId}. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'picture_in_picture') {
        const resp = await require('axios').post(`${baseUrl}/picture-in-picture`, args);
        result = { content: [{ type: 'text', text: `PiP dimulai! renderId: ${resp.data.renderId}. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'add_subtitles') {
        const resp = await require('axios').post(`${baseUrl}/add-subtitles`, args);
        result = { content: [{ type: 'text', text: `Subtitle dimulai! renderId: ${resp.data.renderId}. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'google_search_animation') {
        const resp = await require('axios').post(`${baseUrl}/google-search-animation`, args);
        result = { content: [{ type: 'text', text: `Animasi dimulai! renderId: ${resp.data.renderId}. URL video: ${baseUrl}/download/${resp.data.renderId}` }] };
      } else if (name === 'upload_video_url') {
        const axios = require('axios');
        const { url, filename = 'video.mp4' } = args;
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const fileId = uuidv4();
        const ext = path.extname(filename) || '.mp4';
        const filePath = path.join(UPLOAD_DIR, `${fileId}${ext}`);
        fs.writeFileSync(filePath, response.data);
        result = { content: [{ type: 'text', text: `Upload berhasil! fileId: ${fileId}. Gunakan fileId ini untuk edit atau proses video.` }] };
      } else {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool '${name}' tidak ditemukan` } });
      }

      return res.json({ jsonrpc: '2.0', id, result });
    }

    if (method === 'notifications/initialized') {
      return res.json({ jsonrpc: '2.0', id: null, result: {} });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method '${method}' tidak dikenal` } });
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video Studio Backend v2.0 berjalan di port ${PORT}`);
});

module.exports = app;
