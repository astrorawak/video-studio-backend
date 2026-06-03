/**
 * Scene Builder - Konversi natural language scenes ke FFmpeg filter instructions
 * Mendukung semua 10 scene types dan 6 style presets dari blueprint
 */

const STYLE_PRESETS = {
  cinematic: {
    bg: 'black',
    textColor: 'white',
    accentColor: '0xd4af37',
    fontSize: 64,
    fontFamily: 'Arial',
    overlay: 'rgba(0,0,0,0.7)',
  },
  vlog: {
    bg: '0xfafafa',
    textColor: '0x222222',
    accentColor: '0xff6b6b',
    fontSize: 56,
    fontFamily: 'Arial',
    overlay: 'rgba(255,255,255,0.8)',
  },
  business: {
    bg: '0x1a1a2e',
    textColor: '0xe0e0e0',
    accentColor: '0x0f3460',
    fontSize: 60,
    fontFamily: 'Arial',
    overlay: 'rgba(26,26,46,0.9)',
  },
  music_video: {
    bg: '0x0d0d0d',
    textColor: '0xffd700',
    accentColor: '0xff4500',
    fontSize: 72,
    fontFamily: 'Arial',
    overlay: 'rgba(0,0,0,0.85)',
  },
  tutorial: {
    bg: '0xf5f5f5',
    textColor: '0x333333',
    accentColor: '0x4285f4',
    fontSize: 52,
    fontFamily: 'Arial',
    overlay: 'rgba(245,245,245,0.9)',
  },
  trader: {
    bg: '0x0a0a0a',
    textColor: '0x00ff88',
    accentColor: '0xff3333',
    fontSize: 58,
    fontFamily: 'Arial',
    overlay: 'rgba(0,0,0,0.95)',
  },
};

/**
 * Buat FFmpeg drawtext filter dari scene object
 * @param {Object} scene - Scene configuration
 * @param {string} style - Style preset name
 * @param {number} startTime - Waktu mulai scene (detik)
 * @returns {Array} Array of FFmpeg filter strings
 */
function buildSceneFilters(scene, style = 'cinematic', startTime = 0) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.cinematic;
  const endTime = startTime + (scene.duration || 3);
  const filters = [];

  const escapeText = (text) =>
    String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');

  switch (scene.type) {
    case 'title_scene': {
      const title = escapeText(scene.title || scene.text || 'TITLE');
      const subtitle = escapeText(scene.subtitle || '');
      filters.push(
        `drawtext=text='${title}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize + 16}:x=(w-text_w)/2:y=(h-text_h)/2-40:enable='between(t,${startTime},${endTime})'`
      );
      if (subtitle) {
        filters.push(
          `drawtext=text='${subtitle}':fontcolor=${preset.accentColor}:fontsize=${preset.fontSize - 16}:x=(w-text_w)/2:y=(h+text_h)/2+20:enable='between(t,${startTime},${endTime})'`
        );
      }
      break;
    }

    case 'text_scene': {
      const text = escapeText(scene.text || '');
      const subtext = escapeText(scene.subtext || '');
      filters.push(
        `drawtext=text='${text}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize}:x=(w-text_w)/2:y=(h-text_h)/2-30:enable='between(t,${startTime},${endTime})'`
      );
      if (subtext) {
        filters.push(
          `drawtext=text='${subtext}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize - 20}:x=(w-text_w)/2:y=(h+text_h)/2+10:enable='between(t,${startTime},${endTime})'`
        );
      }
      break;
    }

    case 'lyric_scene': {
      const lyrics = Array.isArray(scene.lyrics) ? scene.lyrics : [scene.text || ''];
      const perLine = (scene.duration || 3) / lyrics.length;
      lyrics.forEach((line, i) => {
        const ls = startTime + i * perLine;
        const le = ls + perLine;
        const txt = escapeText(line);
        filters.push(
          `drawtext=text='${txt}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${ls},${le})'`
        );
      });
      break;
    }

    case 'tips_scene': {
      const tips = Array.isArray(scene.tips) ? scene.tips : [scene.text || ''];
      tips.slice(0, 6).forEach((tip, i) => {
        const txt = escapeText(`${i + 1}. ${tip}`);
        const yPos = 200 + i * 100;
        const ts = startTime + i * 0.5;
        filters.push(
          `drawtext=text='${txt}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize - 12}:x=100:y=${yPos}:enable='between(t,${ts},${endTime})'`
        );
      });
      break;
    }

    case 'lower_third': {
      const name = escapeText(scene.name || scene.text || '');
      const role = escapeText(scene.role || scene.subtext || '');
      filters.push(
        `drawtext=text='${name}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize - 8}:x=80:y=h-160:enable='between(t,${startTime},${endTime})'`
      );
      if (role) {
        filters.push(
          `drawtext=text='${role}':fontcolor=${preset.accentColor}:fontsize=${preset.fontSize - 24}:x=80:y=h-110:enable='between(t,${startTime},${endTime})'`
        );
      }
      break;
    }

    case 'data_scene': {
      const value = escapeText(scene.value || '0');
      const label = escapeText(scene.label || '');
      filters.push(
        `drawtext=text='${value}':fontcolor=${preset.accentColor}:fontsize=${preset.fontSize + 32}:x=(w-text_w)/2:y=(h-text_h)/2-40:enable='between(t,${startTime},${endTime})'`
      );
      if (label) {
        filters.push(
          `drawtext=text='${label}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize - 16}:x=(w-text_w)/2:y=(h+text_h)/2+20:enable='between(t,${startTime},${endTime})'`
        );
      }
      break;
    }

    case 'outro_scene': {
      const cta = escapeText(scene.cta || scene.text || 'Subscribe!');
      const handle = escapeText(scene.handle || '');
      filters.push(
        `drawtext=text='${cta}':fontcolor=${preset.accentColor}:fontsize=${preset.fontSize + 8}:x=(w-text_w)/2:y=(h-text_h)/2-30:enable='between(t,${startTime},${endTime})'`
      );
      if (handle) {
        filters.push(
          `drawtext=text='${handle}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize - 20}:x=(w-text_w)/2:y=(h+text_h)/2+10:enable='between(t,${startTime},${endTime})'`
        );
      }
      break;
    }

    default: {
      // Fallback: text_scene
      const text = escapeText(scene.text || '');
      filters.push(
        `drawtext=text='${text}':fontcolor=${preset.textColor}:fontsize=${preset.fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${startTime},${endTime})'`
      );
    }
  }

  return filters;
}

/**
 * Konversi array scenes ke satu string FFmpeg filter complex
 * @param {Array} scenes - Array of scene objects
 * @param {string} style - Style preset
 * @returns {Object} { filterComplex, totalDuration }
 */
function buildFilterComplex(scenes, style = 'cinematic') {
  let currentTime = 0;
  const allFilters = [];

  for (const scene of scenes) {
    const filters = buildSceneFilters(scene, style, currentTime);
    allFilters.push(...filters);
    currentTime += scene.duration || 3;
  }

  return {
    filterComplex: allFilters.join(','),
    totalDuration: currentTime,
  };
}

module.exports = { buildSceneFilters, buildFilterComplex, STYLE_PRESETS };
