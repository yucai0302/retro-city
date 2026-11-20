/**
 * 程序化音效工厂：运行时合成 16-bit PCM WAV（data URI），全部原创、零外部素材。
 * 警笛为双音交替循环音，其余为通缉变化/发现玩家/逃脱提示音。
 */

const RATE = 22050; // 采样率

interface TonePart {
  freq: number | ((t: number) => number); // 固定频率或时间函数（秒）
  dur: number; // 时长（秒）
  at?: number; // 开始时间（秒），默认顺序排列
  wave?: 'square' | 'sine' | 'tri';
  vol?: number;
  attack?: number; // 起音时间（秒）
  release?: number; // 释音时间（秒）
}

/** 16-bit 单声道 WAV 编码（data URI） */
function encodeWav(samples: Float32Array): string {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const wstr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return 'data:audio/wav;base64,' + btoa(bin);
}

function osc(wave: 'square' | 'sine' | 'tri', phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase);
    case 'tri': {
      const p = (phase / (2 * Math.PI)) % 1;
      return 4 * Math.abs(p - 0.5) - 1;
    }
    default:
      return Math.sin(phase) >= 0 ? 0.7 : -0.7; // 方波降幅避免刺耳
  }
}

/** 混合渲染多个音符（按 at 时刻叠加） */
function render(parts: TonePart[]): Float32Array {
  let total = 0;
  for (const p of parts) total = Math.max(total, (p.at ?? 0) + p.dur);
  const out = new Float32Array(Math.ceil(total * RATE));
  for (const p of parts) {
    const wave = p.wave ?? 'square';
    const vol = p.vol ?? 0.22;
    const attack = p.attack ?? 0.008;
    const release = p.release ?? 0.04;
    const start = Math.floor((p.at ?? 0) * RATE);
    const len = Math.floor(p.dur * RATE);
    let phase = 0;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE;
      const f = typeof p.freq === 'function' ? p.freq(t) : p.freq;
      phase += (2 * Math.PI * f) / RATE;
      let env = 1;
      if (t < attack) env = t / attack;
      else if (t > p.dur - release) env = Math.max(0, (p.dur - t) / release);
      out[start + i] += osc(wave, phase) * vol * env;
    }
  }
  return out;
}

/** 生成全部音效 data URI（在 BootScene 预加载） */
export function buildSfx(): Record<string, string> {
  return {
    // 警笛：双音交替循环（wail）
    'sfx-siren': encodeWav(
      render([{ freq: (t) => (Math.floor(t / 0.4) % 2 === 0 ? 660 : 900), dur: 1.6, wave: 'square', vol: 0.16, attack: 0.05, release: 0.05 }])
    ),
    // 通缉升级：上行三连音
    'sfx-levelup': encodeWav(
      render([
        { freq: 523, dur: 0.11 },
        { freq: 659, dur: 0.11, at: 0.11 },
        { freq: 784, dur: 0.18, at: 0.22 },
      ])
    ),
    // 通缉降级：下行双音
    'sfx-leveldown': encodeWav(
      render([
        { freq: 659, dur: 0.12 },
        { freq: 494, dur: 0.18, at: 0.12 },
      ])
    ),
    // 被警察发现：急促双闪音
    'sfx-spotted': encodeWav(
      render([
        { freq: 980, dur: 0.09, vol: 0.25 },
        { freq: 980, dur: 0.09, at: 0.14, vol: 0.25 },
      ])
    ),
    // 逃脱成功：上行四音小旋律
    'sfx-escaped': encodeWav(
      render([
        { freq: 523, dur: 0.14, wave: 'tri' },
        { freq: 659, dur: 0.14, wave: 'tri', at: 0.14 },
        { freq: 784, dur: 0.14, wave: 'tri', at: 0.28 },
        { freq: 1046, dur: 0.32, wave: 'tri', at: 0.42 },
      ])
    ),
  };
}
