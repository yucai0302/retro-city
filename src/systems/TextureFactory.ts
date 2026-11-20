/**
 * 程序化像素素材工厂。
 * 所有贴图都在运行时用 Canvas 绘制生成：地块图集、人物行走雪碧图、树木等。
 * 每个"逻辑像素"占 2x2 实际像素，保证 16-bit 复古颗粒感。
 */
import * as Phaser from 'phaser';

export const U = 2; // 逻辑像素大小

/** 地块图集帧索引（与 CityGenerator 中 T 枚举一一对应） */
export const T = {
  ASPHALT: 0,
  ROAD_H: 1,
  ROAD_V: 2,
  CROSS_V: 3,
  CROSS_H: 4,
  SIDEWALK: 5,
  GRASS: 6,
  FLOWERS: 7,
  PARKING: 8,
  PLAZA: 9,
  ROOF_E0: 10,
  ROOF_M0: 11,
  ROOF_V0: 12,
  ROOF_E1: 13,
  ROOF_M1: 14,
  ROOF_V1: 15,
  ROOF_E2: 16,
  ROOF_M2: 17,
  ROOF_V2: 18,
  SHADOW: 19,
} as const;

export const TILE_FRAME_COUNT = 20;
export const ROOF_COLORS = 3;

interface Palette {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  shoes: string;
}

const HERO: Palette = {
  skin: '#eab27f',
  hair: '#4a2f1d',
  shirt: '#3e6fb0',
  pants: '#2f3540',
  shoes: '#1d2027',
};

const NPC_PALETTES: Palette[] = [
  { skin: '#eab27f', hair: '#2a2018', shirt: '#b04a4a', pants: '#3a4250', shoes: '#1d2027' },
  { skin: '#c98d5f', hair: '#3a3a44', shirt: '#4a8a5a', pants: '#4a3a30', shoes: '#2b2b30' },
  { skin: '#f0c090', hair: '#8a7a5a', shirt: '#c0c0c0', pants: '#565a60', shoes: '#1d2027' },
  { skin: '#8a5a38', hair: '#1e1a16', shirt: '#7a5aa0', pants: '#33404a', shoes: '#2b2b30' },
  { skin: '#eab27f', hair: '#a05828', shirt: '#d09030', pants: '#3a4250', shoes: '#1d2027' },
  { skin: '#c98d5f', hair: '#2a2018', shirt: '#3a7a8a', pants: '#4a3a30', shoes: '#2b2b30' },
  { skin: '#f0c090', hair: '#5a4630', shirt: '#906040', pants: '#565a60', shoes: '#1d2027' },
  { skin: '#8a5a38', hair: '#2a2018', shirt: '#607050', pants: '#33404a', shoes: '#1d2027' },
];

export const NPC_VARIANTS = NPC_PALETTES.length;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return c;
}

/** 在逻辑坐标系 (16x16) 上画 2x2 像素块 */
function pix(ctx: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(ox + x * U, oy + y * U, w * U, h * U);
}

/** 以逻辑坐标画圆（逐行扫描，保持像素感） */
function pixCircle(ctx: CanvasRenderingContext2D, ox: number, oy: number, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(r * r - y * y));
    ctx.fillRect(ox + (cx - half) * U, oy + (cy + y) * U, half * 2 * U, U);
  }
}

/** 为每帧内部添加深色描边（不跨帧，避免动画串帧） */
function outlineFrames(canvas: HTMLCanvasElement, frameW: number, frameH: number): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const cols = Math.floor(canvas.width / frameW);
  const rows = Math.floor(canvas.height / frameH);
  const R = 26, G = 24, B = 32;
  for (let fr = 0; fr < rows; fr++) {
    for (let fc = 0; fc < cols; fc++) {
      const x0 = fc * frameW, y0 = fr * frameH;
      const src = new Uint8ClampedArray(d);
      const alpha = (x: number, y: number): number => {
        if (x < x0 || x >= x0 + frameW || y < y0 || y >= y0 + frameH) return -1; // 帧外视为透明但不写入
        return src[(y * canvas.width + x) * 4 + 3];
      };
      for (let y = y0; y < y0 + frameH; y++) {
        for (let x = x0; x < x0 + frameW; x++) {
          const i = (y * canvas.width + x) * 4;
          if (src[i + 3] === 0) {
            const n =
              (x > x0 && alpha(x - 1, y) > 0) ||
              (x < x0 + frameW - 1 && alpha(x + 1, y) > 0) ||
              (y > y0 && alpha(x, y - 1) > 0) ||
              (y < y0 + frameH - 1 && alpha(x, y + 1) > 0);
            if (n) {
              d[i] = R;
              d[i + 1] = G;
              d[i + 2] = B;
              d[i + 3] = 255;
            }
          }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 绘制一个 16x16 逻辑帧的人物（dir: 0 下 / 1 上 / 2 侧向） */
function drawPerson(ctx: CanvasRenderingContext2D, ox: number, oy: number, pal: Palette, dir: 0 | 1 | 2, frame: number): void {
  const { skin, hair, shirt, pants, shoes } = pal;

  // ---- 腿部（下行 12-14，鞋在腿末端）----
  if (dir === 2) {
    // 侧向：前后腿交替跨步
    const spread = frame === 0 || frame === 2;
    const xA = frame === 2 ? 9 : 4;
    const xB = frame === 2 ? 4 : 9;
    if (spread) {
      pix(ctx, ox, oy, xA, 12, 2, 2, pants);
      pix(ctx, ox, oy, xA, 14, 2, 1, shoes);
      pix(ctx, ox, oy, xB, 12, 2, 2, pants);
      pix(ctx, ox, oy, xB, 14, 2, 1, shoes);
    } else {
      pix(ctx, ox, oy, 6, 12, 2, 2, pants);
      pix(ctx, ox, oy, 6, 14, 2, 1, shoes);
      pix(ctx, ox, oy, 8, 12, 2, 2, pants);
      pix(ctx, ox, oy, 8, 14, 2, 1, shoes);
    }
  } else {
    // 上下向：两腿交替伸缩
    const legH = [3, 2, 2, 2];
    legH[0] = frame === 0 ? 3 : 2;
    legH[1] = frame === 2 ? 3 : 2;
    for (let i = 0; i < 2; i++) {
      const lx = i === 0 ? 5 : 9;
      const h = legH[i];
      pix(ctx, ox, oy, lx, 12, 2, h - 1, pants);
      pix(ctx, ox, oy, lx, 12 + h - 1, 2, 1, shoes);
    }
  }

  // ---- 躯干 ----
  pix(ctx, ox, oy, 4, 7, 8, 2, shirt);
  pix(ctx, ox, oy, 5, 9, 6, 3, shirt);

  // ---- 手臂 ----
  if (dir === 2) {
    const swing = frame === 1 || frame === 3 ? 1 : 0;
    pix(ctx, ox, oy, 6, 8 + swing, 2, 3, shirt);
    pix(ctx, ox, oy, 6, 11 + swing - (swing ? 1 : 0), 2, 1, skin);
  } else {
    pix(ctx, ox, oy, 4, 8, 1, 2, shirt);
    pix(ctx, ox, oy, 11, 8, 1, 2, shirt);
    pix(ctx, ox, oy, 4, 10, 1, 1, skin);
    pix(ctx, ox, oy, 11, 10, 1, 1, skin);
  }

  // ---- 头部 ----
  if (dir === 1) {
    // 背面：整块头发
    pix(ctx, ox, oy, 5, 1, 6, 6, hair);
    pix(ctx, ox, oy, 6, 6, 4, 1, shirt); // 后领
  } else if (dir === 0) {
    pix(ctx, ox, oy, 5, 1, 6, 2, hair);
    pix(ctx, ox, oy, 5, 3, 1, 3, hair);
    pix(ctx, ox, oy, 10, 3, 1, 3, hair);
    pix(ctx, ox, oy, 6, 3, 4, 4, skin); // 脸
    pix(ctx, ox, oy, 6, 4, 1, 1, '#141820'); // 眼
    pix(ctx, ox, oy, 9, 4, 1, 1, '#141820');
  } else {
    // 侧向（左）
    pix(ctx, ox, oy, 4, 1, 7, 2, hair);
    pix(ctx, ox, oy, 9, 3, 2, 4, hair); // 后脑
    pix(ctx, ox, oy, 4, 3, 5, 4, skin); // 脸
    pix(ctx, ox, oy, 3, 5, 1, 1, skin); // 鼻尖
    pix(ctx, ox, oy, 5, 4, 1, 1, '#141820'); // 眼
  }
}

/** 生成 4 方向 x 4 帧 行走雪碧图（32x32 每帧，共 128x128） */
function makePersonSheet(pal: Palette): HTMLCanvasElement {
  const canvas = newCanvas(128, 128);
  const ctx = canvas.getContext('2d')!;
  for (let f = 0; f < 4; f++) {
    for (let d = 0; d < 4; d++) {
      const ox = f * 32;
      const oy = d * 32;
      if (d === 3) {
        // 右向 = 左向镜像
        ctx.save();
        ctx.translate(ox + 32, oy);
        ctx.scale(-1, 1);
        drawPerson(ctx, 0, 0, pal, 2, f);
        ctx.restore();
      } else {
        drawPerson(ctx, ox, oy, pal, d as 0 | 1 | 2, f);
      }
    }
  }
  outlineFrames(canvas, 32, 32);
  return canvas;
}

// ---------- 地块绘制 ----------

function noise(ctx: CanvasRenderingContext2D, ox: number, oy: number, colors: string[], count: number, rng: () => number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * 16);
    const y = Math.floor(rng() * 16);
    pix(ctx, ox, oy, x, y, 1, 1, colors[Math.floor(rng() * colors.length)]);
  }
}

function drawTile(ctx: CanvasRenderingContext2D, index: number, rng: () => number): void {
  const ox = index * 32;
  const oy = 0;
  const roofPalettes = [
    { base: '#6b7280', dark: '#484f59', light: '#7f8894' },
    { base: '#8f5a44', dark: '#63402f', light: '#a06a52' },
    { base: '#a8905e', dark: '#7d6b42', light: '#bba676' },
  ];

  switch (index) {
    case T.ASPHALT: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#34383d');
      noise(ctx, ox, oy, ['#2c3036', '#3b4046', '#303439'], 26, rng);
      break;
    }
    case T.ROAD_H: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#34383d');
      noise(ctx, ox, oy, ['#2c3036', '#3b4046'], 22, rng);
      for (let x = 0; x < 16; x += 5) {
        pix(ctx, ox, oy, x, 7, 4, 1, '#d7b13c');
        pix(ctx, ox, oy, x, 8, 4, 1, '#a8872c');
      }
      break;
    }
    case T.ROAD_V: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#34383d');
      noise(ctx, ox, oy, ['#2c3036', '#3b4046'], 22, rng);
      for (let y = 0; y < 16; y += 5) {
        pix(ctx, ox, oy, 7, y, 1, 4, '#d7b13c');
        pix(ctx, ox, oy, 8, y, 1, 4, '#a8872c');
      }
      break;
    }
    case T.CROSS_V: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#34383d');
      for (let x = 2; x < 16; x += 4) {
        pix(ctx, ox, oy, x, 0, 2, 16, '#c9c9c9');
        noise(ctx, ox + x * U, oy, ['#a8a8a8'], 3, rng);
        ctx.fillStyle = '#a8a8a8';
        ctx.fillRect(ox + x * U, oy, 2 * U, 2 * U); // 磨损的条纹头
      }
      break;
    }
    case T.CROSS_H: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#34383d');
      for (let y = 2; y < 16; y += 4) {
        pix(ctx, ox, oy, 0, y, 16, 2, '#c9c9c9');
        ctx.fillStyle = '#a8a8a8';
        ctx.fillRect(ox, oy + y * U, 2 * U, 2 * U);
      }
      break;
    }
    case T.SIDEWALK: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#8f959c');
      noise(ctx, ox, oy, ['#9aa0a7', '#848a91'], 18, rng);
      for (let i = 0; i < 16; i += 5) {
        pix(ctx, ox, oy, 0, i, 16, 1, '#7d838a');
        pix(ctx, ox, oy, ((i / 5) % 2 === 0 ? 0 : 8), i, 1, 5, '#7d838a');
      }
      pix(ctx, ox, oy, 8, 15, 8, 1, '#7d838a');
      break;
    }
    case T.GRASS: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#4a7c3c');
      noise(ctx, ox, oy, ['#3f6b33', '#558a45', '#446e38'], 30, rng);
      break;
    }
    case T.FLOWERS: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#4a7c3c');
      noise(ctx, ox, oy, ['#3f6b33', '#558a45'], 24, rng);
      const flowers = ['#e8d24a', '#d96a5a', '#f2f2f2'];
      for (let i = 0; i < 5; i++) {
        const x = 1 + Math.floor(rng() * 14);
        const y = 1 + Math.floor(rng() * 14);
        pix(ctx, ox, oy, x, y, 1, 1, flowers[Math.floor(rng() * flowers.length)]);
      }
      break;
    }
    case T.PARKING: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#3a3e44');
      noise(ctx, ox, oy, ['#33373c', '#42464c'], 20, rng);
      for (const x of [3, 7, 11, 15]) {
        pix(ctx, ox, oy, x, 1, 1, 14, '#c2c2c2');
      }
      pix(ctx, ox, oy, 5, 12, 3, 1, '#26292d'); // 油渍
      break;
    }
    case T.PLAZA: {
      pix(ctx, ox, oy, 0, 0, 16, 16, '#b3a98e');
      noise(ctx, ox, oy, ['#a89e83', '#bdb396'], 16, rng);
      for (let i = 0; i < 16; i += 5) {
        pix(ctx, ox, oy, 0, i, 16, 1, '#a39a7f');
        pix(ctx, ox, oy, i, 0, 1, 16, '#a39a7f');
      }
      break;
    }
    case T.SHADOW: {
      ctx.clearRect(ox, oy, 32, 32);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(ox, oy, 32, 32);
      break;
    }
    default: {
      // 屋顶：10-12 -> 色号 0；13-15 -> 1；16-18 -> 2
      const colorIdx = Math.floor((index - T.ROOF_E0) / 3);
      const kind = (index - T.ROOF_E0) % 3; // 0 边缘 1 内部 2 通风口
      const p = roofPalettes[colorIdx];
      pix(ctx, ox, oy, 0, 0, 16, 16, p.base);
      noise(ctx, ox, oy, [p.dark, p.light], 10, rng);
      if (kind === 0) {
        // 边缘：四周深色包边
        pix(ctx, ox, oy, 0, 0, 16, 1, p.dark);
        pix(ctx, ox, oy, 0, 15, 16, 1, p.dark);
        pix(ctx, ox, oy, 0, 0, 1, 16, p.dark);
        pix(ctx, ox, oy, 15, 0, 1, 16, p.dark);
        pix(ctx, ox, oy, 1, 1, 14, 1, p.light);
      } else if (kind === 2) {
        // 屋顶通风口 / 天窗
        pix(ctx, ox, oy, 4, 4, 8, 8, '#8b939c');
        pix(ctx, ox, oy, 4, 4, 8, 1, '#5f666e');
        pix(ctx, ox, oy, 4, 11, 8, 1, '#5f666e');
        pix(ctx, ox, oy, 4, 4, 1, 8, '#5f666e');
        pix(ctx, ox, oy, 11, 4, 1, 8, '#5f666e');
        pix(ctx, ox, oy, 6, 6, 4, 4, '#5f666e');
      }
      break;
    }
  }
}

function makeTileAtlas(rng: () => number): HTMLCanvasElement {
  const canvas = newCanvas(TILE_FRAME_COUNT * 32, 32);
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < TILE_FRAME_COUNT; i++) drawTile(ctx, i, rng);
  return canvas;
}

function makeTree(variant: 0 | 1): HTMLCanvasElement {
  const canvas = newCanvas(48, 56);
  const ctx = canvas.getContext('2d')!;
  const ox = 0;
  const oy = 0;
  // 树干
  pix(ctx, ox, oy, 10, 17, 3, 9, '#5a3a24');
  pix(ctx, ox, oy, 12, 17, 1, 9, '#463020');
  // 树冠（分层圆）
  const colors =
    variant === 0
      ? { base: '#35632e', dark: '#2a5226', light: '#4d8a3e' }
      : { base: '#4a7030', dark: '#3a5a26', light: '#6a9440' };
  pixCircle(ctx, ox, oy, 12, 10, 10, colors.base);
  pixCircle(ctx, ox, oy, 10, 8, 7, colors.light);
  pixCircle(ctx, ox, oy, 15, 12, 6, colors.dark);
  pixCircle(ctx, ox, oy, 8, 13, 5, colors.base);
  outlineFrames(canvas, 48, 56);
  return canvas;
}

// ---------- 车辆贴图（俯视，车头朝上，旋转表示朝向） ----------

interface CarPalette {
  body: string;
  light: string;
  dark: string;
  glass: string;
}

const CAR_GLASS = '#39424e';
const CAR_WHEEL = '#17191d';
const CAR_TAIL = '#ff5040';
const CAR_HEAD = '#fff6c0';

const SEDAN_COLORS = ['#c9c9c9', '#c23b3b', '#3b62c2', '#3ba352', '#d2763b', '#2f3540'];
const SPORTS_COLORS = ['#c23b3b', '#2d89e8', '#e8d23b', '#d8d8d8'];

/** 变亮(+f)/变暗(-f) */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function carPalette(base: string): CarPalette {
  return { body: base, light: shade(base, 0.28), dark: shade(base, -0.24), glass: CAR_GLASS };
}

/** 车前灯光束：从车头向远处扩散、逐渐变淡（画布顶部 4 行，标明车头方向） */
function drawBeam(ctx: CanvasRenderingContext2D, ox: number, oy: number, wL: number): void {
  const widths = [12, 10, 8, 6];
  const alphas = [0.08, 0.16, 0.3, 0.5];
  for (let i = 0; i < 4; i++) {
    const w = widths[i];
    ctx.fillStyle = `rgba(255,247,207,${alphas[i]})`;
    ctx.fillRect(ox + ((wL - w) / 2) * U, oy + i * U, w * U, U);
  }
}

function drawCarWheels(ctx: CanvasRenderingContext2D, ox: number, oy: number, wL: number, ys: number[], h = 4): void {
  for (const wy of ys) {
    pix(ctx, ox, oy, 0, wy, 2, h, CAR_WHEEL);
    pix(ctx, ox, oy, wL - 2, wy, 2, h, CAR_WHEEL);
  }
}

/** 轿车/出租车（16x36 逻辑格，画布顶部 4 行为灯光束） */
function drawSedan(ctx: CanvasRenderingContext2D, ox: number, oy: number, p: CarPalette, taxi: boolean): void {
  drawBeam(ctx, ox, oy, 16);
  drawCarWheels(ctx, ox, oy, 16, [9, 24]);
  // 车身
  pix(ctx, ox, oy, 1, 6, 14, 25, p.body);
  pix(ctx, ox, oy, 2, 7, 12, 4, p.light); // 引擎盖高光
  pix(ctx, ox, oy, 3, 11, 10, 3, p.glass); // 前挡风
  pix(ctx, ox, oy, 3, 14, 10, 9, p.dark); // 车顶
  pix(ctx, ox, oy, 3, 23, 10, 3, p.glass); // 后挡风
  pix(ctx, ox, oy, 2, 26, 12, 4, p.body); // 后备箱
  pix(ctx, ox, oy, 1, 30, 14, 1, p.dark); // 后保险杠
  // 明亮前灯 + 白色灯芯
  pix(ctx, ox, oy, 2, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 11, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 3, 6, 1, 1, '#ffffff');
  pix(ctx, ox, oy, 12, 6, 1, 1, '#ffffff');
  // 尾灯
  pix(ctx, ox, oy, 2, 29, 3, 1, CAR_TAIL);
  pix(ctx, ox, oy, 11, 29, 3, 1, CAR_TAIL);
  if (taxi) {
    // 后备箱格子涂装 + 车顶出租车牌
    for (let x = 2; x < 14; x += 2) {
      pix(ctx, ox, oy, x, 26, 2, 1, (x / 2) % 2 === 0 ? '#f2f2f2' : '#1d2027');
      pix(ctx, ox, oy, x, 27, 2, 1, (x / 2) % 2 === 0 ? '#1d2027' : '#f2f2f2');
    }
    pix(ctx, ox, oy, 6, 17, 4, 3, '#1d2027');
    pix(ctx, ox, oy, 7, 18, 2, 1, '#f6f2e2');
  }
}

/** 跑车（16x34 逻辑格）：尖车头 + 尾翼，画布顶部 4 行为灯光束 */
function drawSports(ctx: CanvasRenderingContext2D, ox: number, oy: number, p: CarPalette): void {
  drawBeam(ctx, ox, oy, 16);
  drawCarWheels(ctx, ox, oy, 16, [8, 21]);
  pix(ctx, ox, oy, 3, 5, 10, 1, p.body); // 尖车头
  pix(ctx, ox, oy, 1, 6, 14, 21, p.body);
  pix(ctx, ox, oy, 2, 7, 12, 3, p.light);
  pix(ctx, ox, oy, 4, 10, 8, 3, p.glass); // 前挡风
  pix(ctx, ox, oy, 4, 13, 8, 6, p.dark); // 座舱
  pix(ctx, ox, oy, 4, 19, 8, 2, p.glass);
  // 尾翼
  pix(ctx, ox, oy, 1, 25, 14, 2, p.dark);
  pix(ctx, ox, oy, 1, 27, 14, 1, CAR_WHEEL);
  // 车灯
  pix(ctx, ox, oy, 3, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 10, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 4, 6, 1, 1, '#ffffff');
  pix(ctx, ox, oy, 11, 6, 1, 1, '#ffffff');
  pix(ctx, ox, oy, 2, 24, 3, 1, CAR_TAIL);
  pix(ctx, ox, oy, 11, 24, 3, 1, CAR_TAIL);
}

/** 货车（18x42 逻辑格）：前置驾驶室 + 大货箱，画布顶部 4 行为灯光束 */
function drawTruck(ctx: CanvasRenderingContext2D, ox: number, oy: number): void {
  drawBeam(ctx, ox, oy, 18);
  for (const wy of [10, 19, 30]) {
    pix(ctx, ox, oy, 0, wy, 2, 5, CAR_WHEEL);
    pix(ctx, ox, oy, 16, wy, 2, 5, CAR_WHEEL);
  }
  const cab = { body: '#a84a38', light: '#c26048' };
  // 驾驶室
  pix(ctx, ox, oy, 1, 6, 16, 11, cab.body);
  pix(ctx, ox, oy, 2, 7, 14, 3, cab.light);
  pix(ctx, ox, oy, 3, 10, 12, 3, CAR_GLASS);
  pix(ctx, ox, oy, 2, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 13, 6, 3, 1, CAR_HEAD);
  pix(ctx, ox, oy, 3, 6, 1, 1, '#ffffff');
  pix(ctx, ox, oy, 14, 6, 1, 1, '#ffffff');
  // 货箱
  pix(ctx, ox, oy, 1, 17, 16, 19, '#c6cbd2');
  pix(ctx, ox, oy, 1, 17, 16, 1, '#8f959c');
  for (let y = 21; y < 36; y += 5) pix(ctx, ox, oy, 2, y, 14, 1, '#a9aeb5');
  pix(ctx, ox, oy, 1, 35, 16, 1, '#8f959c');
  pix(ctx, ox, oy, 2, 36, 2, 1, CAR_TAIL);
  pix(ctx, ox, oy, 14, 36, 2, 1, CAR_TAIL);
}

/** 警车（16x28 逻辑格 ×2 帧）：黑白涂装 + 车顶红蓝警灯。帧0 红灯亮 / 帧1 蓝灯亮 */
function drawPolice(ctx: CanvasRenderingContext2D, ox: number, oy: number, frame: 0 | 1): void {
  drawCarWheels(ctx, ox, oy, 16, [5, 20]);
  const body = '#20242c'; // 黑色车身
  const hood = '#2e3440';
  const stripe = '#e8e8e8'; // 白色车门带
  pix(ctx, ox, oy, 1, 2, 14, 25, body);
  pix(ctx, ox, oy, 2, 3, 12, 4, hood); // 引擎盖
  pix(ctx, ox, oy, 3, 7, 10, 3, CAR_GLASS); // 前挡风
  pix(ctx, ox, oy, 3, 10, 10, 8, body); // 车顶（放警灯）
  pix(ctx, ox, oy, 1, 12, 14, 6, stripe); // 白色车门带
  pix(ctx, ox, oy, 3, 18, 10, 3, CAR_GLASS); // 后挡风
  pix(ctx, ox, oy, 2, 21, 12, 5, body); // 后备箱
  pix(ctx, ox, oy, 1, 26, 14, 1, '#161a20'); // 后保险杠
  // 车顶警灯底座（左红右蓝，亮/暗交替）
  const redOn = '#ff4a3c';
  const redDim = '#6e1e18';
  const blueOn = '#3c7cff';
  const blueDim = '#182866';
  pix(ctx, ox, oy, 4, 13, 4, 2, frame === 0 ? redOn : redDim);
  pix(ctx, ox, oy, 8, 13, 4, 2, frame === 1 ? blueOn : blueDim);
  // 白带上"PD"标识块
  pix(ctx, ox, oy, 6, 14, 4, 2, '#20242c');
  pix(ctx, ox, oy, 7, 14, 2, 1, '#e8e8e8');
  // 车灯
  pix(ctx, ox, oy, 3, 2, 2, 1, CAR_HEAD);
  pix(ctx, ox, oy, 11, 2, 2, 1, CAR_HEAD);
  pix(ctx, ox, oy, 2, 25, 3, 1, CAR_TAIL);
  pix(ctx, ox, oy, 11, 25, 3, 1, CAR_TAIL);
}

function makeCarCanvas(wL: number, hL: number, draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void): HTMLCanvasElement {
  const canvas = newCanvas(wL * U, hL * U);
  const ctx = canvas.getContext('2d')!;
  draw(ctx, 0, 0);
  outlineFrames(canvas, wL * U, hL * U);
  return canvas;
}

/** 地面现金包（8x8 逻辑像素的小钱袋，绿色 + $ 标记） */
function makeCashBag(): HTMLCanvasElement {
  const canvas = newCanvas(16, 16);
  const ctx = canvas.getContext('2d')!;
  const BODY = '#2e7a3a';
  const DARK = '#1f5628';
  const MARK = '#a8e6a0';
  // 袋口扎结
  pix(ctx, 0, 0, 3, 0, 2, 1, DARK);
  // 圆形袋身（去四角）
  for (let y = 1; y <= 6; y++) {
    for (let x = 1; x <= 6; x++) {
      const skip = (x === 1 || x === 6) && (y === 1 || y === 6);
      if (skip) continue;
      pix(ctx, 0, 0, x, y, 1, 1, BODY);
    }
  }
  // 描边（底边加深）
  pix(ctx, 0, 0, 2, 7, 4, 1, DARK);
  // $ 记号（S 形 + 竖线）
  pix(ctx, 0, 0, 4, 2, 1, 1, MARK);
  pix(ctx, 0, 0, 3, 3, 1, 1, MARK);
  pix(ctx, 0, 0, 4, 4, 1, 1, MARK);
  pix(ctx, 0, 0, 3, 5, 1, 1, MARK);
  pix(ctx, 0, 0, 4, 3, 1, 3, MARK);
  return canvas;
}

// ---------- POI 图标（复古 GTA 风格，16x16 逻辑像素，自绘降级方案） ----------

/** 电话亭：绿色公用电话（机身 + 听筒 + 按键区） */
function makePoiPhone(): HTMLCanvasElement {
  const canvas = newCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  const BODY = '#3a8a4a';
  const DARK = '#26603a';
  const LIGHT = '#5ab46a';
  const FACE = '#d8e8d0';
  // 机身
  pix(ctx, 0, 0, 4, 2, 8, 12, BODY);
  pix(ctx, 0, 0, 4, 2, 8, 1, LIGHT);
  pix(ctx, 0, 0, 4, 13, 8, 1, DARK);
  // 听筒（横杠 + 两端块）
  pix(ctx, 0, 0, 5, 3, 6, 2, LIGHT);
  pix(ctx, 0, 0, 4, 3, 1, 2, DARK);
  pix(ctx, 0, 0, 11, 3, 1, 2, DARK);
  // 面板与按键
  pix(ctx, 0, 0, 6, 6, 4, 2, FACE);
  for (let y = 9; y <= 11; y++) {
    for (let x = 5; x <= 10; x += 2) {
      pix(ctx, 0, 0, x, y, 1, 1, FACE);
    }
  }
  outlineFrames(canvas, 32, 32);
  return canvas;
}

/** 武器店：红色手枪（枪管 + 握把 + 扳机护圈缺口） */
function makePoiGunshop(): HTMLCanvasElement {
  const canvas = newCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  const BODY = '#c23b3b';
  const DARK = '#8a2626';
  const LIGHT = '#e06a5a';
  // 枪管与枪身
  pix(ctx, 0, 0, 2, 5, 11, 3, BODY);
  pix(ctx, 0, 0, 2, 5, 11, 1, LIGHT);
  // 枪口
  pix(ctx, 0, 0, 1, 5, 1, 2, DARK);
  // 准星
  pix(ctx, 0, 0, 11, 3, 1, 2, BODY);
  // 握把（斜块）
  pix(ctx, 0, 0, 9, 8, 3, 2, BODY);
  pix(ctx, 0, 0, 10, 10, 2, 3, BODY);
  pix(ctx, 0, 0, 10, 13, 1, 1, DARK);
  // 扳机护圈缺口
  pix(ctx, 0, 0, 7, 8, 1, 2, DARK);
  outlineFrames(canvas, 32, 32);
  return canvas;
}

/** 维修厂：橙色扳手（顶部开口环 + 竖柄） */
function makePoiRepair(): HTMLCanvasElement {
  const canvas = newCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  const BODY = '#e08a3a';
  const DARK = '#a85a20';
  const LIGHT = '#f2b46a';
  // 顶部环（缺口圆）
  for (let y = 1; y <= 6; y++) {
    for (let x = 4; x <= 11; x++) {
      const dx = x - 7.5;
      const dy = y - 3.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const isHole = Math.abs(dx) < 1.6 && dy < 1.4; // 开口
      if (d <= 3.6 && d >= 1.8 && !isHole) pix(ctx, 0, 0, x, y, 1, 1, BODY);
    }
  }
  pix(ctx, 0, 0, 4, 1, 2, 1, LIGHT);
  // 柄（上宽下窄）
  pix(ctx, 0, 0, 6, 7, 3, 6, BODY);
  pix(ctx, 0, 0, 6, 7, 1, 6, LIGHT);
  pix(ctx, 0, 0, 7, 13, 1, 2, DARK);
  outlineFrames(canvas, 32, 32);
  return canvas;
}

/** 车库：蓝色卷帘门车库（门框 + 横条纹） */
function makePoiGarage(): HTMLCanvasElement {
  const canvas = newCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  const FRAME = '#3a62b8';
  const DARK = '#263e78';
  const DOOR = '#5a8ada';
  const LIGHT = '#8ab0ea';
  // 外框
  pix(ctx, 0, 0, 2, 3, 12, 10, FRAME);
  pix(ctx, 0, 0, 2, 3, 12, 1, LIGHT);
  // 门内横条纹
  pix(ctx, 0, 0, 3, 4, 10, 8, DOOR);
  for (let y = 5; y <= 11; y += 2) {
    pix(ctx, 0, 0, 3, y, 10, 1, LIGHT);
  }
  pix(ctx, 0, 0, 3, 11, 10, 1, DARK);
  // 底部地面线
  pix(ctx, 0, 0, 1, 13, 14, 1, DARK);
  outlineFrames(canvas, 32, 32);
  return canvas;
}

/** 警察局：蓝灰盾牌（盾形 + 徽章横条） */
function makePoiPolice(): HTMLCanvasElement {
  const canvas = newCanvas(32, 32);
  const ctx = canvas.getContext('2d')!;
  const BODY = '#5a7a9a';
  const DARK = '#3a5470';
  const LIGHT = '#8aa8c2';
  const BADGE = '#d8e0e8';
  // 盾形（宽顶、收底、尖底）
  for (let y = 2; y <= 13; y++) {
    const half = y <= 4 ? 6 : y <= 10 ? 6 - Math.floor((y - 5) / 3) : Math.max(1, 4 - (y - 10));
    pix(ctx, 0, 0, 8 - half, y, half * 2, 1, y === 13 ? DARK : BODY);
  }
  pix(ctx, 0, 0, 2, 2, 12, 1, LIGHT);
  // 徽章横条
  pix(ctx, 0, 0, 5, 6, 6, 1, BADGE);
  pix(ctx, 0, 0, 6, 8, 4, 1, BADGE);
  outlineFrames(canvas, 32, 32);
  return canvas;
}

/** 注册全部运行时素材 */
export function createTextures(scene: Phaser.Scene): void {
  let seed = 1337;
  const rng = (): number => {
    seed = (seed * 16807 + 11) % 2147483647;
    return (seed % 100000) / 100000;
  };

  scene.textures.addSpriteSheet(
    'city-tiles',
    makeTileAtlas(rng) as unknown as HTMLImageElement,
    {
      frameWidth: 32,
      frameHeight: 32,
    }
  );

  scene.textures.addSpriteSheet(
    'hero',
    makePersonSheet(HERO) as unknown as HTMLImageElement,
    {
      frameWidth: 32,
      frameHeight: 32,
    }
  );

  for (let i = 0; i < NPC_PALETTES.length; i++) {
    scene.textures.addSpriteSheet(
      `npc${i}`,
      makePersonSheet(NPC_PALETTES[i]) as unknown as HTMLImageElement,
      {
        frameWidth: 32,
        frameHeight: 32,
      }
    );
  }

  scene.textures.addImage('tree', makeTree(0) as unknown as HTMLImageElement);
  scene.textures.addImage('tree2', makeTree(1) as unknown as HTMLImageElement);
  // 地面现金包（Phase 4.1 经济系统）
  scene.textures.addCanvas('cash-bag', makeCashBag());
  // POI 图标（Phase 4.1 修复：自绘复古图标，纹理缺失时渲染层用色块降级）
  scene.textures.addCanvas('poi-phone', makePoiPhone());
  scene.textures.addCanvas('poi-gunshop', makePoiGunshop());
  scene.textures.addCanvas('poi-repair', makePoiRepair());
  scene.textures.addCanvas('poi-garage', makePoiGarage());
  scene.textures.addCanvas('poi-police', makePoiPolice());

  // 车辆：每种车型多色变体贴图（不用 tint，保证车灯颜色不被染色）；车头带灯光束朝上
  SEDAN_COLORS.forEach((c, i) => {
    scene.textures.addCanvas(`car-sedan-${i}`, makeCarCanvas(16, 36, (ctx, x, y) => drawSedan(ctx, x, y, carPalette(c), false)));
  });
  SPORTS_COLORS.forEach((c, i) => {
    scene.textures.addCanvas(`car-sports-${i}`, makeCarCanvas(16, 34, (ctx, x, y) => drawSports(ctx, x, y, carPalette(c))));
  });
  scene.textures.addCanvas(
    'car-taxi',
    makeCarCanvas(16, 36, (ctx, x, y) => drawSedan(ctx, x, y, carPalette('#e3c02f'), true))
  );
  scene.textures.addCanvas('car-truck', makeCarCanvas(18, 42, drawTruck));
  // 警车：双帧雪碧图（帧0 红灯亮 / 帧1 蓝灯亮），供警灯交替闪烁动画使用
  const policeCanvas = newCanvas(64, 56);
  const pctx = policeCanvas.getContext('2d')!;
  drawPolice(pctx, 0, 0, 0);
  drawPolice(pctx, 32, 0, 1);
  outlineFrames(policeCanvas, 32, 56);
  scene.textures.addSpriteSheet('car-police', policeCanvas as unknown as HTMLImageElement, {
    frameWidth: 32,
    frameHeight: 56,
  });
}

/** 创建警灯闪烁动画（红蓝交替，用于警戒/追捕/搜索状态） */
export function createPoliceAnims(scene: Phaser.Scene): void {
  if (!scene.anims.exists('police-flash')) {
    scene.anims.create({
      key: 'police-flash',
      frames: scene.anims.generateFrameNumbers('car-police', { frames: [0, 1] }),
      frameRate: 5,
      repeat: -1,
    });
  }
}

/** 创建全部行走动画（hero + npc0..n） */
export function createWalkAnims(scene: Phaser.Scene): void {
  const dirs = ['down', 'up', 'left', 'right'];
  const keys: Array<[string, string]> = [['hero', 'hero']];
  for (let i = 0; i < NPC_VARIANTS; i++) keys.push([`npc${i}`, `npc${i}`]);
  for (const [texKey] of keys) {
    for (let d = 0; d < 4; d++) {
      const key = texKey === 'hero' ? `hero-${dirs[d]}` : `${texKey}-${dirs[d]}`;
      if (scene.anims.exists(key)) continue;
      scene.anims.create({
        key,
        frames: scene.anims.generateFrameNumbers(texKey, {
          frames: [d * 4, d * 4 + 1, d * 4 + 2, d * 4 + 3],
        }),
        frameRate: 8,
        repeat: -1,
      });
    }
  }
}
