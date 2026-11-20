/**
 * 程序化城市地图生成器。
 * 布局：横/纵道路网格 + 街区（建筑群/公园/停车场/广场）+ 十字路口斑马线。
 * 同时输出可行走掩码（供 NPC 寻路）与建筑/树木碰撞列表。
 */
import * as Phaser from 'phaser';
import { MAP_W, MAP_H, TILE } from '../config';
import { T } from './TextureFactory';

export interface RoadBand {
  start: number;
  size: number;
  dash: number; // 车道虚线所在行/列（带内相对索引）
}

export interface ParkingLot {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BuildingRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: number; // 屋顶色号 0-2
}

export interface TreePos {
  tx: number;
  ty: number;
  tex: string;
}

const WALKABLE = new Set<number>([T.SIDEWALK, T.GRASS, T.FLOWERS, T.PLAZA, T.PARKING, T.CROSS_H, T.CROSS_V]);

export class CityGenerator {
  readonly ground: number[][] = [];
  readonly shadow: number[][] = [];
  readonly roof: number[][] = [];
  readonly mask: Uint8Array = new Uint8Array(MAP_W * MAP_H);
  readonly buildings: BuildingRect[] = [];
  readonly trees: TreePos[] = [];
  readonly parkingLots: ParkingLot[] = [];
  readonly hBands: RoadBand[] = [];
  readonly vBands: RoadBand[] = [];
  playerStart: { tx: number; ty: number } = { tx: 0, ty: 0 };

  private rng = new Phaser.Math.RandomDataGenerator(['retro-city-1997']);
  readonly inH: boolean[][] = [];
  readonly inV: boolean[][] = [];

  constructor() {
    this.generate();
  }

  private generate(): void {
    const hBands = this.pickBands();
    const vBands = this.pickBands();
    this.hBands.push(...hBands);
    this.vBands.push(...vBands);

    // 初始化：全人行道
    for (let r = 0; r < MAP_H; r++) {
      this.ground[r] = new Array(MAP_W).fill(T.SIDEWALK);
      this.shadow[r] = new Array(MAP_W).fill(-1);
      this.roof[r] = new Array(MAP_W).fill(-1);
      this.inH[r] = new Array(MAP_W).fill(false);
      this.inV[r] = new Array(MAP_W).fill(false);
    }

    // 道路基底
    for (const b of hBands) {
      for (let r = b.start; r < b.start + b.size; r++) {
        for (let c = 0; c < MAP_W; c++) this.inH[r][c] = true;
      }
    }
    for (const b of vBands) {
      for (let c = b.start; c < b.start + b.size; c++) {
        for (let r = 0; r < MAP_H; r++) this.inV[r][c] = true;
      }
    }

    for (let r = 0; r < MAP_H; r++) {
      for (let c = 0; c < MAP_W; c++) {
        if (this.inH[r][c] && this.inV[r][c]) {
          this.ground[r][c] = T.ASPHALT; // 交叉路口
        } else if (this.inH[r][c]) {
          const b = hBands.find((x) => r >= x.start && r < x.start + x.size)!;
          this.ground[r][c] = b.dash === r - b.start ? T.ROAD_H : T.ASPHALT;
        } else if (this.inV[r][c]) {
          const b = vBands.find((x) => c >= x.start && c < x.start + x.size)!;
          this.ground[r][c] = b.dash === c - b.start ? T.ROAD_V : T.ASPHALT;
        }
      }
    }

    // 十字路口四周斑马线（位于路口外一圈的道路边缘上）
    for (const hb of hBands) {
      for (const vb of vBands) {
        const r1 = hb.start;
        const r2 = hb.start + hb.size - 1;
        const c1 = vb.start;
        const c2 = vb.start + vb.size - 1;
        if (r1 - 1 >= 0) for (let c = c1; c <= c2; c++) this.ground[r1 - 1][c] = T.CROSS_V;
        if (r2 + 1 < MAP_H) for (let c = c1; c <= c2; c++) this.ground[r2 + 1][c] = T.CROSS_V;
        if (c1 - 1 >= 0) for (let r = r1; r <= r2; r++) this.ground[r][c1 - 1] = T.CROSS_H;
        if (c2 + 1 < MAP_W) for (let r = r1; r <= r2; r++) this.ground[r][c2 + 1] = T.CROSS_H;
      }
    }

    // 街区填充
    const rowBlocks = this.blockRanges(hBands, MAP_H);
    const colBlocks = this.blockRanges(vBands, MAP_W);
    for (const [r0, r1] of rowBlocks) {
      for (const [c0, c1] of colBlocks) {
        this.fillBlock(r0, r1, c0, c1);
      }
    }

    // 建筑屋顶 + 阴影
    for (const b of this.buildings) this.paintRoof(b);
    this.paintShadows();

    // 可行走掩码
    for (let r = 0; r < MAP_H; r++) {
      for (let c = 0; c < MAP_W; c++) {
        this.mask[r * MAP_W + c] = WALKABLE.has(this.ground[r][c]) ? 1 : 0;
      }
    }

    // 玩家出生点：地图中心附近找可行走地块
    this.playerStart = this.findWalkableNear(Math.floor(MAP_W / 2), Math.floor(MAP_H / 2));
  }

  /** 在范围内挑选道路带（宽 2-4，间隔 7-12） */
  private pickBands(): RoadBand[] {
    const bands: RoadBand[] = [];
    let pos = 4;
    const limit = MAP_W - 5;
    while (pos < limit) {
      const roll = this.rng.frac();
      const size = roll < 0.45 ? 2 : roll < 0.8 ? 3 : 4;
      if (pos + size >= limit) break;
      bands.push({ start: pos, size, dash: Math.floor((size - 1) / 2) });
      pos += size + 7 + this.rng.between(0, 5);
    }
    return bands;
  }

  /** 两条道路带之间的街区范围（含两端） */
  private blockRanges(bands: RoadBand[], max: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let prevEnd = -1;
    for (const b of bands) {
      if (b.start - 1 - (prevEnd + 1) >= 0) ranges.push([prevEnd + 1, b.start - 1]);
      prevEnd = b.start + b.size - 1;
    }
    if (prevEnd + 1 <= max - 1) ranges.push([prevEnd + 1, max - 1]);
    return ranges;
  }

  private fillBlock(r0: number, r1: number, c0: number, c1: number): void {
    const w = c1 - c0 + 1;
    const h = r1 - r0 + 1;
    if (w < 5 || h < 5) return; // 太小：保留人行道
    const iy0 = r0 + 1;
    const iy1 = r1 - 1;
    const ix0 = c0 + 1;
    const ix1 = c1 - 1;
    const iw = ix1 - ix0 + 1;
    const ih = iy1 - iy0 + 1;

    const roll = this.rng.frac();
    if (roll < 0.62) {
      this.fillBuildings(iy0, iy1, ix0, ix1, iw, ih);
    } else if (roll < 0.78) {
      this.fillPark(iy0, iy1, ix0, ix1);
    } else if (roll < 0.9) {
      for (let r = iy0; r <= iy1; r++)
        for (let c = ix0; c <= ix1; c++) this.ground[r][c] = T.PARKING;
      this.parkingLots.push({ x0: ix0, y0: iy0, x1: ix1, y1: iy1 });
    } else {
      for (let r = iy0; r <= iy1; r++)
        for (let c = ix0; c <= ix1; c++) this.ground[r][c] = T.PLAZA;
      this.plantTrees(iy0, iy1, ix0, ix1, 2);
    }
  }

  private fillBuildings(iy0: number, iy1: number, ix0: number, ix1: number, iw: number, ih: number): void {
    const nx = Math.max(1, Math.round(iw / 6));
    const ny = Math.max(1, Math.round(ih / 6));
    const cw = Math.floor(iw / nx);
    const ch = Math.floor(ih / ny);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const gx0 = ix0 + cx * cw;
        const gy0 = iy0 + cy * ch;
        const gx1 = cx < nx - 1 ? gx0 + cw - 2 : ix0 + iw - 1; // 内侧留 1 格巷道
        const gy1 = cy < ny - 1 ? gy0 + ch - 2 : iy0 + ih - 1;
        if (gx1 - gx0 + 1 < 2 || gy1 - gy0 + 1 < 2) continue;
        if (this.rng.frac() < 0.12) {
          // 留白小庭院
          for (let r = gy0; r <= gy1; r++)
            for (let c = gx0; c <= gx1; c++) this.ground[r][c] = T.GRASS;
          continue;
        }
        this.buildings.push({
          x0: gx0,
          y0: gy0,
          x1: gx1,
          y1: gy1,
          color: this.rng.between(0, 2),
        });
      }
    }
  }

  private fillPark(iy0: number, iy1: number, ix0: number, ix1: number): void {
    for (let r = iy0; r <= iy1; r++) {
      for (let c = ix0; c <= ix1; c++) {
        this.ground[r][c] = this.rng.frac() < 0.1 ? T.FLOWERS : T.GRASS;
      }
    }
    const count = Math.max(1, Math.floor(((iy1 - iy0 + 1) * (ix1 - ix0 + 1)) / 18));
    this.plantTrees(iy0, iy1, ix0, ix1, count);
  }

  private plantTrees(iy0: number, iy1: number, ix0: number, ix1: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const ty = this.rng.between(iy0, iy1);
      const tx = this.rng.between(ix0, ix1);
      if (this.ground[ty][tx] === T.GRASS || this.ground[ty][tx] === T.FLOWERS || this.ground[ty][tx] === T.PLAZA) {
        this.trees.push({
          tx,
          ty,
          tex: this.rng.frac() < 0.5 ? 'tree' : 'tree2',
        });
      }
    }
  }

  private paintRoof(b: BuildingRect): void {
    const e = T.ROOF_E0 + b.color * 3;
    const m = T.ROOF_M0 + b.color * 3;
    const v = T.ROOF_V0 + b.color * 3;
    for (let r = b.y0; r <= b.y1; r++) {
      for (let c = b.x0; c <= b.x1; c++) {
        const edge = r === b.y0 || r === b.y1 || c === b.x0 || c === b.x1;
        if (edge) {
          this.roof[r][c] = e;
        } else {
          this.roof[r][c] = this.rng.frac() < 0.08 ? v : m;
        }
        this.mask[r * MAP_W + c] = 0; // 建筑不可通行
      }
    }
  }

  private paintShadows(): void {
    for (const b of this.buildings) {
      // 南侧 + 东侧投影
      for (let c = b.x0; c <= Math.min(b.x1 + 1, MAP_W - 1); c++) {
        if (b.y1 + 1 < MAP_H && !this.inH[b.y1 + 1][c] && !this.inV[b.y1 + 1][c]) {
          this.shadow[b.y1 + 1][c] = T.SHADOW;
        }
      }
      for (let r = b.y0; r <= Math.min(b.y1, MAP_H - 1); r++) {
        if (b.x1 + 1 < MAP_W && !this.inH[r][b.x1 + 1] && !this.inV[r][b.x1 + 1]) {
          this.shadow[r][b.x1 + 1] = T.SHADOW;
        }
      }
    }
  }

  private findWalkableNear(cx: number, cy: number): { tx: number; ty: number } {
    for (let radius = 0; radius < 40; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
          if (this.mask[ty * MAP_W + tx] === 1) return { tx, ty };
        }
      }
    }
    return { tx: cx, ty: cy };
  }

  isWalkableTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return this.mask[ty * MAP_W + tx] === 1;
  }

  isWalkablePx(px: number, py: number): boolean {
    return this.isWalkableTile(Math.floor(px / TILE), Math.floor(py / TILE));
  }

  /** 找一个随机可行走出生地块（避开中心附近，供 NPC 使用） */
  randomWalkableTile(): { tx: number; ty: number } {
    for (let i = 0; i < 300; i++) {
      const tx = this.rng.between(1, MAP_W - 2);
      const ty = this.rng.between(1, MAP_H - 2);
      if (this.isWalkableTile(tx, ty)) return { tx, ty };
    }
    return { tx: 1, ty: 1 };
  }
}
