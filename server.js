'use strict';
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID: uuidv4 } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

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
      business: { bg: '0x1a1a2e', text: '0xe0e0e0', font: 'Arial' },
      music_video: { bg: '0x0d0d0d', text: '0xffd700', font: 'Arial' },
      tutorial: { bg: '0xf5f5f5', text: '0x333333', font: 'Arial' },
      trader: { bg: '0x0a0a0a', text: '0x00ff88', font: 'Arial' },
    };
    const colors = styleColors[style] || styleColors.cinematic;

    const sceneList = Array.isArray(scenes) ? scenes : [{ text: 'Video Studio', duration: duration }];
    const totalDuration = sceneList.reduce((sum, s) => sum + (s.duration || 3), 0);

    let filterParts = [];
    let currentTime = 0;

    sceneList.forEach((scene) => {
      const sceneDur = scene.duration || 3;
      const text = (scene.text || '').replace(/'/g, "\\'").replace(/:/g, '\\:');
      const subtext = (scene.subtext || '').replace(/'/g, "\\'").replace(/:/g, '\\:');
      const startT = currentTime;
      const endT = currentTime + sceneDur;

      filterParts.push(
        `drawtext=text='${text}':fontcolor=${colors.text}:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${startT},${endT})'`
      );
      if (subtext) {
        filterParts.push(
          `drawtext=text='${subtext}':fontcolor=${colors.text}:fontsize=30:x=(w-text_w)/2:y=(h+text_h)/2+20:enable='between(t,${startT},${endT})'`
        );
      }
      currentTime = endT;
    });

    const filterComplex = filterParts.join(',');

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(`color=${colors.bg}:size=1920x1080:duration=${totalDuration}:rate=30`)
        .inputOptions(['-f', 'lavfi'])
        .videoFilters(filterComplex)
        .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('progress', (p) => {
          renderJobs[renderId].progress = Math.min(90, Math.round((p.percent || 0)));
        })
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

    const bg = style === 'dark' ? 'black' : 'white';
    const textColor = style === 'dark' ? 'white' : 'black';
    const queryText = searchQuery.replace(/'/g, "\\'");

    const filters = [
      `drawtext=text='${queryText}':fontcolor=${textColor}:fontsize=36:x=120:y=80:enable='gte(t,0.5)'`,
    ];

    results.slice(0, 5).forEach((result, i) => {
      const resultText = result.replace(/'/g, "\\'").substring(0, 60);
      const yPos = 200 + i * 80;
      const startT = 1 + i * 1.5;
      filters.push(
        `drawtext=text='${resultText}':fontcolor=blue:fontsize=22:x=80:y=${yPos}:enable='gte(t,${startT})'`
      );
    });

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(`color=${bg}:size=1920x1080:duration=${duration}:rate=30`)
        .inputOptions(['-f', 'lavfi'])
        .videoFilters(filters.join(','))
        .outputOptions(['-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
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
  res.json({ status: 'ok', service: 'Video Studio Backend', version: '2.0.0' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video Studio Backend v2.0 berjalan di port ${PORT}`);
});

module.exports = app;
