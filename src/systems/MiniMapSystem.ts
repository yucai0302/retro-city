/**
 * 小地图系统：屏幕右下角固定复古像素小地图。
 * - 中心跟随玩家（上车后跟随车辆）；
 * - 显示道路 / 建筑轮廓 / 街区（预渲染 1px/tile 全城底图裁剪显示）；
 * - 图标：玩家朝向箭头、警车、电话亭、武器店、维修点、车库、警察局、
 *   地面现金包、导航目标与完整导航路径；
 * - 节流刷新（~15fps），不影响性能；不遮挡现有 HUD（音量提示已移至左下）。
 */
import * as Phaser from 'phaser';
import { TILE, MAP_W, MAP_H } from '../config';
import { T } from './TextureFactory';
import { CityGenerator } from './CityGenerator';
import type { GameScene } from '../scenes/GameScene';
import type { Place } from './PlaceManager';

/** 小地图尺寸（屏幕 px）与视野（tile 数） */
const MM_SIZE = 160;
const MM_TILES = 40;
const MM_PX_PER_TILE = MM_SIZE / MM_TILES; // 4

const MARGIN = 12;

const ICON_COLORS: Record<string, number> = {
  phone: 0xffd76a,
  gunshop: 0xff5a4a,
  repair: 0x5ad4e6,
  garage: 0xff9a3a,
  police: 0x5a8ada,
};

const GROUND_COLORS: Record<number, string> = {
  [T.ASPHALT]: '#3a3f47',
  [T.ROAD_H]: '#4a505a',
  [T.ROAD_V]: '#4a505a',
  [T.CROSS_V]: '#565c66',
  [T.CROSS_H]: '#565c66',
  [T.SIDEWALK]: '#6d727c',
  [T.GRASS]: '#3d6b3d',
  [T.FLOWERS]: '#4f7a44',
  [T.PARKING]: '#565860',
  [T.PLAZA]: '#7c766a',
};

const ROOF_EDGE = ['#8a5a3a', '#7a4a3a', '#5a6a7a'];
const ROOF_MID = ['#6a4630', '#5c3a30', '#46586a'];

/**
 * 预渲染全城底图 canvas（1 canvas px = 1 tile * pxPerTile）。
 * minimap-base（1x）与 fullmap-base（4x）共用本函数。
 */
export function buildMapCanvas(gen: CityGenerator, pxPerTile: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = MAP_W * pxPerTile;
  c.height = MAP_H * pxPerTile;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let r = 0; r < MAP_H; r++) {
    for (let col = 0; col < MAP_W; col++) {
      const roof = gen.roof[r][col];
      let color: string;
      if (roof >= T.ROOF_E0) {
        const idx = Math.floor((roof - T.ROOF_E0) / 3);
        const kind = (roof - T.ROOF_E0) % 3;
        color = kind === 0 ? ROOF_EDGE[idx] : ROOF_MID[idx];
      } else if (gen.shadow[r][col] >= 0) {
        color = '#2a2d34';
      } else {
        color = GROUND_COLORS[gen.ground[r][col]] ?? '#000000';
      }
      ctx.fillStyle = color;
      ctx.fillRect(col * pxPerTile, r * pxPerTile, pxPerTile, pxPerTile);
    }
  }
  return c;
}

export class MiniMapSystem {
  private scene: Phaser.Scene;
  private game: GameScene;
  private bg: Phaser.GameObjects.Rectangle;
  private border: Phaser.GameObjects.Rectangle;
  private mapImg: Phaser.GameObjects.Image;
  private overlay: Phaser.GameObjects.Graphics;
  private cropX = 0;
  private cropY = 0;
  /** 实际绘制使用的整数裁剪原点（overlay 图标坐标与底图保持一致） */
  private drawX = 0;
  private drawY = 0;
  private acc = 999;
  /** 实时小纹理（每帧从底图 drawImage 重绘，规避 canvas 纹理 setCrop 在 WebGL 下的渲染缺陷） */
  private liveCtx: CanvasRenderingContext2D;
  private baseSource: HTMLCanvasElement;

  constructor(scene: Phaser.Scene, game: GameScene) {
    this.scene = scene;
    this.game = game;
    const w = scene.scale.width;
    const h = scene.scale.height;
    const cx = w - MARGIN - MM_SIZE / 2;
    const cy = h - MARGIN - MM_SIZE / 2;

    this.bg = scene.add.rectangle(cx, cy, MM_SIZE + 8, MM_SIZE + 8, 0x101216, 0.85);
    this.border = scene.add.rectangle(cx, cy, MM_SIZE + 8, MM_SIZE + 8).setStrokeStyle(2, 0x565c66);

    // 实时裁剪纹理：40x40 px，显示时放大 MM_PX_PER_TILE
    if (!scene.textures.exists('minimap-live')) {
      scene.textures.createCanvas('minimap-live', MM_TILES, MM_TILES);
    }
    const live = scene.textures.get('minimap-live') as Phaser.Textures.CanvasTexture;
    this.liveCtx = (live.getSourceImage() as HTMLCanvasElement).getContext('2d')!;
    this.liveCtx.imageSmoothingEnabled = false;
    // 底图源 canvas（addCanvas 添加，getSourceImage 即原始 canvas 元素）
    this.baseSource = scene.textures.get('minimap-base').getSourceImage() as HTMLCanvasElement;

    this.mapImg = scene.add.image(cx, cy, 'minimap-live').setOrigin(0.5, 0.5).setScale(MM_PX_PER_TILE);
    this.overlay = scene.add.graphics();
  }

  /** 每帧调用（内部节流重绘） */
  update(delta: number): void {
    this.acc += delta;
    if (this.acc < 66) return;
    this.acc = 0;
    this.redraw();
  }

  /** 屏幕尺寸变化时重新摆放 */
  layout(): void {
    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const cx = w - MARGIN - MM_SIZE / 2;
    const cy = h - MARGIN - MM_SIZE / 2;
    this.bg.setPosition(cx, cy);
    this.border.setPosition(cx, cy);
    this.mapImg.setPosition(cx, cy);
    this.overlay.setPosition(cx - MM_SIZE / 2, cy - MM_SIZE / 2);
    this.redraw();
  }

  /** 世界坐标 → 面板内相对坐标（原点 = 面板左上角，与整数裁剪原点对齐） */
  private worldToPanel(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx / TILE - this.drawX) * MM_PX_PER_TILE,
      y: (wy / TILE - this.drawY) * MM_PX_PER_TILE,
    };
  }

  private redraw(): void {
    const g = this.game;
    const player = g.player;
    const active = g.vehicles.active; // 上车后小地图跟随车辆
    const px = active ? active.x : player.x;
    const py = active ? active.y : player.y;

    // 裁剪窗口（clamp 到地图边缘）：以 tile 为单位取整，保证 drawImage 像素对齐
    const pt = px / TILE;
    const ppt = py / TILE;
    this.cropX = Phaser.Math.Clamp(pt - MM_TILES / 2, 0, MAP_W - MM_TILES);
    this.cropY = Phaser.Math.Clamp(ppt - MM_TILES / 2, 0, MAP_H - MM_TILES);
    // 用 2D drawImage 把底图对应区域重绘到实时小纹理（替代 setCrop，避免 WebGL 裁剪缺陷）
    const sx = Math.floor(this.cropX);
    const sy = Math.floor(this.cropY);
    this.drawX = sx;
    this.drawY = sy;
    this.liveCtx.clearRect(0, 0, MM_TILES, MM_TILES);
    this.liveCtx.drawImage(this.baseSource, sx, sy, MM_TILES, MM_TILES, 0, 0, MM_TILES, MM_TILES);
    (this.scene.textures.get('minimap-live') as Phaser.Textures.CanvasTexture).refresh();

    const o = this.overlay;
    o.clear();

    // 导航路径（完整折线）
    const nav = g.navigation;
    if (nav.active && nav.path.length > 1) {
      o.lineStyle(2, 0xe65ad4, 0.9);
      o.beginPath();
      let first = true;
      for (const p of nav.path) {
        const q = this.worldToPanel(p.x, p.y);
        if (first) {
          o.moveTo(q.x, q.y);
          first = false;
        } else {
          o.lineTo(q.x, q.y);
        }
      }
      o.strokePath();
    }

    // 兴趣点图标：深色描边 + 亮色主体（底图上任何位置都可见）；
    // 靠近视野边缘时 clamp 到面板内，保证边缘 POI 也能看到
    for (const place of g.places.places as Place[]) {
      const raw = this.worldToPanel(place.x, place.y);
      if (raw.x < -8 || raw.y < -8 || raw.x > MM_SIZE + 8 || raw.y > MM_SIZE + 8) continue;
      const qx = Phaser.Math.Clamp(raw.x, 5, MM_SIZE - 5);
      const qy = Phaser.Math.Clamp(raw.y, 5, MM_SIZE - 5);
      o.fillStyle(0x101216, 0.9);
      o.fillRect(qx - 5, qy - 5, 10, 10);
      o.fillStyle(ICON_COLORS[place.type] ?? 0xffffff, 1);
      o.fillRect(qx - 3, qy - 3, 6, 6);
    }

    // 地面现金包（绿色小点）
    for (const bag of g.cashDrops.activeBags) {
      const q = this.worldToPanel(bag.sprite.x, bag.sprite.y);
      if (q.x < 0 || q.y < 0 || q.x > MM_SIZE || q.y > MM_SIZE) continue;
      o.fillStyle(0x7ad46a, 0.95);
      o.fillRect(q.x - 2, q.y - 2, 4, 4);
    }

    // 警车（蓝色圆点）
    for (const p of g.police.polices) {
      const q = this.worldToPanel(p.x, p.y);
      if (q.x < 0 || q.y < 0 || q.x > MM_SIZE || q.y > MM_SIZE) continue;
      o.fillStyle(0x5a8ada, 0.95);
      o.fillCircle(q.x, q.y, 3);
    }

    // 导航目标（品红菱形标记）
    if (nav.active && nav.target) {
      const q = this.worldToPanel(nav.target.x, nav.target.y);
      if (q.x > 0 && q.y > 0 && q.x < MM_SIZE && q.y < MM_SIZE) {
        o.fillStyle(0xe65ad4, 1);
        o.beginPath();
        o.moveTo(q.x, q.y - 6);
        o.lineTo(q.x + 6, q.y);
        o.lineTo(q.x, q.y + 6);
        o.lineTo(q.x - 6, q.y);
        o.closePath();
        o.fillPath();
      }
    }

    // 玩家方向箭头（白色三角，指向朝向）
    let heading: number;
    if (active) {
      const r = active.rotation;
      heading = Math.atan2(-Math.cos(r), Math.sin(r));
    } else {
      heading = player.facingAngle;
    }
    // 箭头锚点 = 玩家/车辆在小地图面板内的实际位置（与整数裁剪原点对齐）
    const a = this.worldToPanel(px, py);
    const p0 = this.rot(11, 0, heading);
    const p1 = this.rot(-7, 7, heading);
    const p2 = this.rot(-7, -7, heading);
    o.fillStyle(0xffffff, 1);
    o.beginPath();
    o.moveTo(a.x + p0.x, a.y + p0.y);
    o.lineTo(a.x + p1.x, a.y + p1.y);
    o.lineTo(a.x + p2.x, a.y + p2.y);
    o.closePath();
    o.fillPath();
  }

  private rot(x: number, y: number, a: number): { x: number; y: number } {
    return {
      x: x * Math.cos(a) - y * Math.sin(a),
      y: x * Math.sin(a) + y * Math.cos(a),
    };
  }
}
