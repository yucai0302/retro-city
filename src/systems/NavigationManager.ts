/**
 * 导航系统：基于 CityGenerator 道路网络 / 可行走掩码的 A* 路径规划。
 * - 驾驶模式：沿道路 tile（inH/inV）规划，绝不穿建筑；
 * - 步行模式：沿可行走掩码（人行道/公园/广场/停车场）规划；
 * - 路径经视线平滑（拉直但不离开可通行区域）；
 * - 小地图绘制完整路径，HUD 显示剩余距离，抵达范围给到达提示；
 * - 支持取消 / 更换目标；未来 MissionManager 通过 setTarget 自动设置任务导航。
 */
import { MAP_W, MAP_H, TILE } from '../config';
import { CityGenerator } from './CityGenerator';

interface Tile {
  tx: number;
  ty: number;
}

export type NavMode = 'road' | 'walk';

/** 二叉最小堆（按 f 值） */
class MinHeap {
  private ids: number[] = [];
  private fs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, f: number): void {
    this.ids.push(id);
    this.fs.push(f);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p] <= this.fs[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastF = this.fs.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.fs[l] < this.fs[m]) m = l;
        if (r < this.ids.length && this.fs[r] < this.fs[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = ti;
    const tf = this.fs[a];
    this.fs[a] = this.fs[b];
    this.fs[b] = tf;
  }
}

const ARRIVE_DIST = 80; // 距目标小于该值视为抵达（px）
const REPLAN_INTERVAL = 450; // 玩家换 tile 后的重规划间隔（ms）
const SNAP_MAX_R = 14; // 目标点吸附可行走/道路 tile 的最大搜索半径

export class NavigationManager {
  /** 当前导航目标（世界坐标），null = 无导航 */
  target: { x: number; y: number } | null = null;
  /** 平滑后的路径路点（世界坐标，tile 中心） */
  path: Array<{ x: number; y: number }> = [];
  /** 剩余距离（按路径折算，px；1 tile ≈ 1m 显示） */
  distRemaining = 0;
  /** 是否已抵达目标范围 */
  arrived = false;
  /** 是否处于导航状态 */
  active = false;

  private gen: CityGenerator;
  private mode: NavMode = 'walk';
  private lastPlayerTile: Tile | null = null;
  private replanAcc = 9999;

  // A* 复用缓冲
  private gScore = new Float32Array(MAP_W * MAP_H);
  private cameFrom = new Int32Array(MAP_W * MAP_H);
  private closed = new Uint8Array(MAP_W * MAP_H);

  constructor(gen: CityGenerator) {
    this.gen = gen;
  }

  /** 设置/更换导航目标（世界坐标）。失败返回 false（目标无法到达或被建筑完全围死） */
  setTarget(wx: number, wy: number, playerX: number, playerY: number, mode: NavMode): boolean {
    const start = this.snapTile(Math.floor(playerX / TILE), Math.floor(playerY / TILE), mode, false);
    const goal = this.snapTile(Math.floor(wx / TILE), Math.floor(wy / TILE), mode, true);
    if (!start || !goal) return false;

    const tiles = this.astar(start, goal, mode);
    if (!tiles) return false;

    this.mode = mode;
    this.target = { x: wx, y: wy };
    this.path = this.smooth(tiles, mode).map((t) => ({
      x: t.tx * TILE + TILE / 2,
      y: t.ty * TILE + TILE / 2,
    }));
    this.active = true;
    this.arrived = false;
    this.lastPlayerTile = start;
    this.replanAcc = 0;
    this.recomputeDist(playerX, playerY);
    return true;
  }

  /** 取消导航 */
  clear(): void {
    this.target = null;
    this.path = [];
    this.distRemaining = 0;
    this.arrived = false;
    this.active = false;
    this.lastPlayerTile = null;
  }

  /**
   * 每帧更新：抵达判定 + 玩家跨 tile / 模式切换时的重规划（带间隔节流）。
   * @param inVehicle 当前是否驾驶（决定道路/步行两种规划模式）
   */
  update(delta: number, playerX: number, playerY: number, inVehicle: boolean): void {
    if (!this.active || !this.target) return;

    const mode: NavMode = inVehicle ? 'road' : 'walk';
    const dist = Math.hypot(this.target.x - playerX, this.target.y - playerY);
    if (dist < ARRIVE_DIST) {
      this.arrived = true;
    } else if (this.arrived && dist > ARRIVE_DIST * 1.6) {
      this.arrived = false; // 离开后又拉远（如目标被追着换）重新导航
    }

    this.recomputeDist(playerX, playerY);

    // 模式切换（上下车）立即重规划
    if (mode !== this.mode) {
      this.replan(playerX, playerY, mode);
      return;
    }

    const pt: Tile = { tx: Math.floor(playerX / TILE), ty: Math.floor(playerY / TILE) };
    const movedTile =
      !this.lastPlayerTile || pt.tx !== this.lastPlayerTile.tx || pt.ty !== this.lastPlayerTile.ty;
    if (movedTile) {
      this.replanAcc += delta;
      if (this.replanAcc >= REPLAN_INTERVAL) this.replan(playerX, playerY, mode);
    } else {
      this.replanAcc = 0;
    }
  }

  private replan(playerX: number, playerY: number, mode: NavMode): void {
    if (!this.target) return;
    const ok = this.setTarget(this.target.x, this.target.y, playerX, playerY, mode);
    if (!ok) this.clear(); // 目标永久不可达（如建筑内）时静默取消
  }

  /** 沿路径折算剩余距离（px） */
  private recomputeDist(playerX: number, playerY: number): void {
    let d = 0;
    let px = playerX;
    let py = playerY;
    for (const p of this.path) {
      d += Math.hypot(p.x - px, p.y - py);
      px = p.x;
      py = p.y;
    }
    if (this.target) d += Math.hypot(this.target.x - px, this.target.y - py);
    this.distRemaining = d;
  }

  // ---------------- 寻路核心 ----------------

  private passable(tx: number, ty: number, mode: NavMode): boolean {
    if (mode === 'road') {
      return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H && (this.gen.inH[ty][tx] || this.gen.inV[ty][tx]);
    }
    return this.gen.isWalkableTile(tx, ty);
  }

  /** 螺旋搜索最近的合法 tile（start=false 时终点优先自身 tile，允许落点本身就是合法 tile） */
  private snapTile(tx: number, ty: number, mode: NavMode, isGoal: boolean): Tile | null {
    if (this.passable(tx, ty, mode)) return { tx, ty };
    for (let r = 1; r <= SNAP_MAX_R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (this.passable(nx, ny, mode)) return { tx: nx, ty: ny };
        }
      }
    }
    return null;
  }

  /** A* 主过程：返回 tile 序列（含起终点） */
  private astar(s: Tile, g: Tile, mode: NavMode): Tile[] | null {
    const W = MAP_W;
    const N = MAP_W * MAP_H;
    this.gScore.fill(Infinity);
    this.cameFrom.fill(-1);
    this.closed.fill(0);

    const si = s.ty * W + s.tx;
    const gi = g.ty * W + g.tx;
    this.gScore[si] = 0;
    this.cameFrom[si] = si;

    const heap = new MinHeap();
    heap.push(si, this.heuristic(s, g));

    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === gi) return this.reconstruct(gi, si);
      if (this.closed[cur]) continue;
      this.closed[cur] = 1;

      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        const ni = ny * W + nx;
        if (this.closed[ni] || !this.passable(nx, ny, mode)) continue;
        const tentative = this.gScore[cur] + 1;
        if (tentative < this.gScore[ni]) {
          this.gScore[ni] = tentative;
          this.cameFrom[ni] = cur;
          heap.push(ni, tentative + this.heuristic({ tx: nx, ty: ny }, g));
        }
      }
      if (heap.size > 20000) break; // 安全阀
    }
    return null;
  }

  private heuristic(a: Tile, b: Tile): number {
    return Math.abs(a.tx - b.tx) + Math.abs(a.ty - b.ty);
  }

  private reconstruct(gi: number, si: number): Tile[] {
    const out: Tile[] = [];
    let cur = gi;
    while (cur !== si) {
      out.push({ tx: cur % MAP_W, ty: (cur / MAP_W) | 0 });
      cur = this.cameFrom[cur];
      if (out.length > N_GUARD) break;
    }
    out.push({ tx: si % MAP_W, ty: (si / MAP_W) | 0 });
    out.reverse();
    return out;
  }

  /** 视线平滑：在不离开可通行区域的前提下尽量拉直 */
  private smooth(tiles: Tile[], mode: NavMode): Tile[] {
    if (tiles.length <= 2) return tiles;
    const out: Tile[] = [tiles[0]];
    let i = 0;
    while (i < tiles.length - 1) {
      let j = tiles.length - 1;
      for (; j > i + 1; j--) {
        if (this.lineClear(tiles[i], tiles[j], mode)) break;
      }
      out.push(tiles[j]);
      i = j;
    }
    return out;
  }

  private lineClear(a: Tile, b: Tile, mode: NavMode): boolean {
    const dx = b.tx - a.tx;
    const dy = b.ty - a.ty;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.passable(Math.round(a.tx + dx * t), Math.round(a.ty + dy * t), mode)) return false;
    }
    return true;
  }
}

const N_GUARD = 20000;
