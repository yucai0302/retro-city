/**
 * 警察管理器：警车生成/增援/裁撤、道路寻路（BFS）、视野判断、犯罪目击、警笛控制。
 *
 * 性能设计：
 * - 警车数量有硬上限（POLICE.maxCount）。
 * - 寻路用城市道路 tile 图上的 BFS（数千格，毫秒级），并按状态错开重寻路间隔。
 * - 视野检测每车约 160ms 一次（错开相位），建筑遮挡用预计算网格 O(1) 查询。
 * - 距离玩家过远的巡逻警车不参与目标分配之外的任何高频计算。
 */
import * as Phaser from 'phaser';
import { MAP_W, MAP_H, TILE, POLICE, ARREST } from '../config';
import { CityGenerator } from './CityGenerator';
import { VehicleManager } from './VehicleManager';
import { WantedSystem } from './WantedSystem';
import { PoliceInterceptionSystem, InterceptSnapshot } from './PoliceInterceptionSystem';
import { Police, PoliceCtx } from '../entities/Police';
import { Officer } from '../entities/Officer';
import { Vehicle } from '../entities/Vehicle';

/** 玩家快照：每帧由 GameScene 传入（警察/拦截/抓捕共用的统一玩家状态） */
export interface PlayerSnap {
  x: number;
  y: number;
  inVehicle: boolean;
  speed: number;
  vx: number;
  vy: number;
  level: number;
}

interface RoadTile {
  tx: number;
  ty: number;
}

interface SpawnPos {
  x: number;
  y: number;
  rot: number;
}

export class PoliceManager extends Phaser.Events.EventEmitter {
  readonly group: Phaser.Physics.Arcade.Group;
  readonly polices: Police[] = [];
  /** 步行警察（下车追捕用）及其物理组 */
  readonly officers: Officer[] = [];
  readonly officerGroup: Phaser.Physics.Arcade.Group;
  /** 拦截系统（GameScene 注入）：为 CHASE 警车提供前置拦截目标 */
  interception: PoliceInterceptionSystem | null = null;
  /** 当前是否有警车处于 CHASE（供 WantedSystem 判断衰减与 HUD） */
  chaseActive = false;
  /** 本帧是否有警察真实目击玩家 */
  anySeen = false;

  private scene: Phaser.Scene;
  private gen: CityGenerator;
  private vehicles: VehicleManager;
  private wanted: WantedSystem;

  private buildingGrid: Uint8Array; // 建筑遮挡查询网格（tile 级）
  private roadTiles: RoadTile[] = []; // 可驾驶道路 tile 池（生成点候选）
  private bfsPrev: Int32Array;
  private bfsQueue: Int32Array;

  private spawnCooldown = 0;
  private despawnCooldown = 0;
  private radioCooldown = 0;
  private chaseSlotCounter = 0;
  private siren: Phaser.Sound.BaseSound | null = null;

  // 玩家快照（每帧由 GameScene 更新）
  private playerX = 0;
  private playerY = 0;
  private playerInVehicle = false;
  private playerSpeed = 0;
  private playerVX = 0;
  private playerVY = 0;
  private level = 0;

  constructor(
    scene: Phaser.Scene,
    gen: CityGenerator,
    solids: Phaser.Physics.Arcade.StaticGroup,
    vehicles: VehicleManager,
    npcGroup: Phaser.Physics.Arcade.Group,
    wanted: WantedSystem
  ) {
    super();
    this.scene = scene;
    this.gen = gen;
    this.vehicles = vehicles;
    this.wanted = wanted;
    this.group = scene.physics.add.group();
    this.officerGroup = scene.physics.add.group();

    // 步行警察与建筑/车辆碰撞（不穿墙、不穿车）
    scene.physics.add.collider(this.officerGroup, solids);
    scene.physics.add.collider(this.officerGroup, vehicles.group);
    scene.physics.add.collider(this.officerGroup, npcGroup);

    // 玩家初始位置快照（供初始警车生成避开玩家出生点）
    this.playerX = gen.playerStart.tx * TILE;
    this.playerY = gen.playerStart.ty * TILE;

    // 建筑遮挡网格：LOS 射线采样 O(1) 查询
    this.buildingGrid = new Uint8Array(MAP_W * MAP_H);
    for (const b of gen.buildings) {
      for (let r = b.y0; r <= b.y1; r++) {
        for (let c = b.x0; c <= b.x1; c++) {
          if (r >= 0 && r < MAP_H && c >= 0 && c < MAP_W) this.buildingGrid[r * MAP_W + c] = 1;
        }
      }
    }

    // 可驾驶道路 tile 池（inH/inV 覆盖的道路带，与地图 asphalt 完全一致）
    for (let r = 0; r < MAP_H; r++) {
      for (let c = 0; c < MAP_W; c++) {
        if (this.isRoad(c, r)) this.roadTiles.push({ tx: c, ty: r });
      }
    }

    // BFS 复用缓冲
    this.bfsPrev = new Int32Array(MAP_W * MAP_H);
    this.bfsQueue = new Int32Array(MAP_W * MAP_H);

    // 初始巡逻警车（分散全城，远离出生点）
    for (let i = 0; i < POLICE.initialCount; i++) {
      const pos = this.findSpawnPos(320);
      if (pos) this.spawnAt(pos);
    }

    // 碰撞：警车 vs 建筑/障碍（撞墙减速）
    scene.physics.add.collider(this.group, solids, (obj) => {
      (obj as Police).noteImpact(scene.time.now);
    });
    // 警车之间互相排开，不允许叠成一团
    scene.physics.add.collider(this.group, this.group);
    // 警车 vs NPC
    scene.physics.add.collider(this.group, npcGroup);
    // 警车 vs 车辆：玩家驾驶撞警车 = 犯罪（撞击警车）
    scene.physics.add.collider(this.group, vehicles.group, (a, b) => {
      const t = scene.time.now;
      (a as Vehicle).noteImpact(t);
      (b as Vehicle).noteImpact(t);
      const pv = vehicles.active;
      const police = (a === pv ? b : a) as Police;
      // 仅当玩家主动撞击警车才算犯罪：车速>70 且车头朝向警车（被追尾/侧撞时警车不在车头方向，不算）
      if (pv && (a === pv || b === pv) && pv.speed > 70 && t - pv.lastThrottleAt < 400) {
        const fx = Math.sin(pv.rotation);
        const fy = -Math.cos(pv.rotation);
        const dx = police.x - pv.x;
        const dy = police.y - pv.y;
        const dot = (fx * dx + fy * dy) / Math.max(1, Math.hypot(dx, dy));
        if (dot > 0.35) {
          this.wanted.reportCrime('hit_police', pv.x, pv.y, t);
          // 被撞的警车立即转入追捕
          if (police.state === 'PATROL' || police.state === 'ALERT' || police.state === 'SEARCH') {
            police.enterState('CHASE');
          }
        }
      }
    });

    // 警笛（循环音，追捕时播放）
    this.siren = scene.sound.add('sfx-siren', { loop: true, volume: 0.55 });
  }

  // ---------------- 生成与裁撤 ----------------

  private spawnAt(pos: SpawnPos): Police {
    const p = new Police(this.scene, pos.x, pos.y, pos.rot);
    this.group.add(p);
    this.polices.push(p);
    return p;
  }

  /**
   * 在玩家视野之外、合理道路位置寻找增援生成点：
   * 距离窗口内（距离制排除，兼容超大视口）+ 不在建筑内 + 与现有警车保持间距。
   */
  private findSpawnPos(minSpacing: number): SpawnPos | null {
    for (let i = 0; i < 60; i++) {
      const t = Phaser.Utils.Array.GetRandom(this.roadTiles);
      const x = t.tx * TILE + TILE / 2;
      const y = t.ty * TILE + TILE / 2;
      const dp = Math.hypot(x - this.playerX, y - this.playerY);
      if (dp < POLICE.spawnMinDist || dp > POLICE.spawnMaxDist) continue;
      if (this.buildingGrid[t.ty * MAP_W + t.tx]) continue; // 不能生成在建筑内部
      let tooClose = false;
      for (const p of this.polices) {
        if (Math.hypot(p.x - x, p.y - y) < minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      return { x, y, rot: this.laneRotation(t.tx, t.ty) };
    }
    return null;
  }

  /** 生成朝向与道路方向一致 */
  private laneRotation(tx: number, ty: number): number {
    const h = this.gen.inH[ty][tx];
    const v = this.gen.inV[ty][tx];
    if (h && !v) return Math.PI / 2; // 横向道路
    if (v && !h) return Math.random() < 0.5 ? 0 : Math.PI; // 纵向道路
    return Phaser.Math.FloatBetween(0, Math.PI * 2); // 路口
  }

  /** 按通缉等级维持警车规模：增援逐步进入，裁撤渐进离开 */
  private maintainFleet(delta: number): void {
    const target = Math.min(POLICE.targetByLevel[this.level], POLICE.maxCount);
    this.spawnCooldown -= delta;
    this.despawnCooldown -= delta;
    if (this.polices.length < target && this.spawnCooldown <= 0) {
      const pos = this.findSpawnPos(POLICE.minSpacing);
      if (pos) {
        this.spawnAt(pos);
        this.spawnCooldown = 2200; // 增援逐辆进场
      } else {
        this.spawnCooldown = 800;
      }
    } else if (this.polices.length > target && this.despawnCooldown <= 0) {
      // 撤离：优先裁撤距离远、不在视野内、且未在追捕的警车
      const view = this.scene.cameras.main.worldView;
      let far: Police | null = null;
      let farD = 0;
      for (const p of this.polices) {
        if (p.chasing) continue;
        const d = Math.hypot(p.x - this.playerX, p.y - this.playerY);
        if (d > 700 && !view.contains(p.x, p.y) && d > farD) {
          farD = d;
          far = p;
        }
      }
      if (far) {
        this.polices.splice(this.polices.indexOf(far), 1);
        far.destroy();
        this.despawnCooldown = 3000;
      } else {
        this.despawnCooldown = 1500;
      }
    }
  }

  // ---------------- 视野与目击 ----------------

  /** 建筑遮挡的直线视距检测（步进 14px 采样） */
  private losClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    const steps = Math.ceil(d / 14);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const tx = ((x0 + dx * t) / TILE) | 0;
      const ty = ((y0 + dy * t) / TILE) | 0;
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
      if (this.buildingGrid[ty * MAP_W + tx]) return false;
    }
    return true;
  }

  /** 是否有警车目击了 (x,y) 处发生的事情（供 WantedSystem 判定犯罪目击） */
  anyWitness(x: number, y: number): boolean {
    for (const p of this.polices) {
      if (Math.hypot(p.x - x, p.y - y) < POLICE.witnessDist && this.losClear(p.x, p.y, x, y)) {
        return true;
      }
    }
    return false;
  }

  /** 目击犯罪的警察前往现场调查 */
  dispatchTo(x: number, y: number): void {
    for (const p of this.polices) {
      if (Math.hypot(p.x - x, p.y - y) < POLICE.witnessDist && p.state === 'PATROL') {
        p.investigate(x, y);
      }
    }
  }

  // ---------------- 寻路（道路 tile BFS + 视线平滑） ----------------

  private isRoad(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H && (this.gen.inH[ty][tx] || this.gen.inV[ty][tx]);
  }

  /** 螺旋找最近的可行车 tile */
  private nearestRoadTile(tx: number, ty: number, maxR: number): RoadTile | null {
    if (this.isRoad(tx, ty)) return { tx, ty };
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (this.isRoad(nx, ny)) return { tx: nx, ty: ny };
        }
      }
    }
    return null;
  }

  /** 在 (tx,ty) 附近 minR-maxR 的环带内随机取一个道路 tile */
  private randomRoadTileNear(tx: number, ty: number, minR: number, maxR: number): RoadTile | null {
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const nx = Math.round(tx + Math.cos(ang) * r);
      const ny = Math.round(ty + Math.sin(ang) * r);
      if (this.isRoad(nx, ny)) return { tx: nx, ty: ny };
    }
    return this.nearestRoadTile(tx, ty, maxR + 4);
  }

  /**
   * 在 (tx,ty) 周围指定方位 ang 的楔形区域（±45°，minR-maxR 环带）取一个道路 tile。
   * 用于 3 星以上的多车方位包围：不同 chaseSlot 的警车被派往玩家不同方向的路口，
   * 而不是全部沿同一条路逼近。
   */
  private slotRoadTileNear(tx: number, ty: number, ang: number, minR: number, maxR: number): RoadTile | null {
    for (let i = 0; i < 50; i++) {
      const a = ang + (Math.random() - 0.5) * (Math.PI / 2);
      const r = minR + Math.random() * (maxR - minR);
      const nx = Math.round(tx + Math.cos(a) * r);
      const ny = Math.round(ty + Math.sin(a) * r);
      if (this.isRoad(nx, ny)) return { tx: nx, ty: ny };
    }
    return null; // 该方位无路（如地图边缘），由调用方回退默认目标点
  }

  /** 直线是否全程落在道路 tile 上（用于路径平滑） */
  private lineOnRoad(a: RoadTile, b: RoadTile): boolean {
    const dx = b.tx - a.tx;
    const dy = b.ty - a.ty;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.tx + dx * t;
      const y = a.ty + dy * t;
      if (!this.isRoad(Math.round(x), Math.round(y))) return false;
    }
    return true;
  }

  /** 道路 BFS 寻路：返回平滑后的世界坐标路点序列 */
  private findPath(sx: number, sy: number, tx: number, ty: number): Array<{ x: number; y: number }> | null {
    if (sx === tx && sy === ty) return [{ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 }];
    const W = MAP_W;
    const prev = this.bfsPrev;
    prev.fill(-1);
    const q = this.bfsQueue;
    let head = 0;
    let tail = 0;
    const s = sy * W + sx;
    const goal = ty * W + tx;
    q[tail++] = s;
    prev[s] = s;
    let found = false;
    while (head < tail && tail < 14000) {
      const cur = q[head++];
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= MAP_H) continue;
        const ni = ny * W + nx;
        if (prev[ni] !== -1 || !this.isRoad(nx, ny)) continue;
        prev[ni] = cur;
        q[tail++] = ni;
      }
    }
    if (!found) return null;

    // 回溯
    const rev: RoadTile[] = [];
    let cur = goal;
    while (cur !== s && cur !== -1) {
      rev.push({ tx: cur % W, ty: (cur / W) | 0 });
      cur = prev[cur];
    }
    rev.push({ tx: sx, ty: sy });
    rev.reverse();

    // 视线平滑：合并直线可见的路点，减少路带内蛇形
    const pts: Array<{ x: number; y: number }> = [];
    let i = 0;
    while (i < rev.length - 1) {
      let j = Math.min(i + 6, rev.length - 1);
      while (j > i + 1 && !this.lineOnRoad(rev[i], rev[j])) j--;
      const wp = rev[j];
      pts.push({ x: wp.tx * TILE + TILE / 2, y: wp.ty * TILE + TILE / 2 });
      i = j;
    }
    return pts.length > 0 ? pts : null;
  }

  /** 让警车寻路前往目标 tile */
  private setPathTo(p: Police, tx: number, ty: number): void {
    const st = this.nearestRoadTile(Math.floor(p.x / TILE), Math.floor(p.y / TILE), 10);
    if (!st) {
      p.needTarget = true;
      p.repathTimer = 600;
      return;
    }
    const pts = this.findPath(st.tx, st.ty, tx, ty);
    if (pts && pts.length > 0) {
      p.setPath(pts);
    } else {
      p.needTarget = true;
      p.repathTimer = 600;
    }
  }

  /** 按警车状态分配导航目标 */
  private assignTarget(p: Police): void {
    const chase = p.state === 'CHASE';
    if (p.repathTimer > 0) return;
    p.repathTimer = chase ? POLICE.repathChase : POLICE.repathOther;

    if (chase) {
      // Phase 3.1：拦截系统提供前置阻挡目标（玩家驾驶、偶数 slot、进入拦截距离时）
      const dist = Math.hypot(this.playerX - p.x, this.playerY - p.y);
      const snap: InterceptSnapshot = {
        playerX: this.playerX,
        playerY: this.playerY,
        playerVX: this.playerVX,
        playerVY: this.playerVY,
        playerSpeed: this.playerSpeed,
        inVehicle: this.playerInVehicle,
      };
      const ig = this.interception?.goalFor(p, snap, dist) ?? null;
      let tx0 = ig ? ig.x : this.playerX;
      let ty0 = ig ? ig.y : this.playerY;
      if (p.stuckCount >= 2) {
        // 反复卡死（常因路边停放车堵住车道）：换一个方位的道路 tile 重新接近
        const alt = this.randomRoadTileNear(Math.floor(this.playerX / TILE), Math.floor(this.playerY / TILE), 2, 7);
        if (alt) {
          tx0 = alt.tx * TILE + TILE / 2;
          ty0 = alt.ty * TILE + TILE / 2;
        }
        p.stuckCount = 0;
      } else if (!ig && this.level >= 3) {
        // 3 星起多车按方位包围：在玩家周围对应方位的楔形区域选道路 tile，
        // 避免所有警车挤在同一条路线上（offset 点落在建筑上会被拉回玩家 tile）
        const ang = p.chaseSlot * (Math.PI / 2) + (this.level >= 4 ? Math.PI / 4 : 0);
        const pt = this.slotRoadTileNear(
          Math.floor(this.playerX / TILE),
          Math.floor(this.playerY / TILE),
          ang,
          3,
          8
        );
        if (pt) {
          tx0 = pt.tx * TILE + TILE / 2;
          ty0 = pt.ty * TILE + TILE / 2;
        }
      }
      const t = this.nearestRoadTile(Math.floor(tx0 / TILE), Math.floor(ty0 / TILE), 12);
      if (t) this.setPathTo(p, t.tx, t.ty);
      return;
    }
    if (p.state === 'ALERT') {
      // 2 星起前往无线电通报的最后已知位置，否则前往犯罪现场
      const src = this.level >= POLICE.radioLevel ? this.wanted.lastKnown : { x: p.alertX, y: p.alertY };
      const t = this.nearestRoadTile(Math.floor(src.x / TILE), Math.floor(src.y / TILE), 12);
      if (t) this.setPathTo(p, t.tx, t.ty);
      return;
    }
    if (p.state === 'SEARCH') {
      // 在最后目击位置附近街区游走搜索
      const t = this.randomRoadTileNear(
        Math.floor(p.lastSeenX / TILE),
        Math.floor(p.lastSeenY / TILE),
        1,
        6
      );
      if (t) this.setPathTo(p, t.tx, t.ty);
      return;
    }
    // PATROL：随机远处目标巡逻
    const pt = this.randomRoadTileNear(Math.floor(p.x / TILE), Math.floor(p.y / TILE), 14, 55);
    if (pt) this.setPathTo(p, pt.tx, pt.ty);
  }

  // ---------------- 主更新 ----------------

  update(delta: number, time: number, snap: PlayerSnap): void {
    this.playerX = snap.x;
    this.playerY = snap.y;
    this.playerInVehicle = snap.inVehicle;
    this.playerSpeed = snap.speed;
    this.playerVX = snap.vx;
    this.playerVY = snap.vy;
    this.level = snap.level;

    // 2 星起警用无线电通报【最后目击位置】（滞后情报，非实时坐标，不等于目击），全城警力响应
    this.radioCooldown -= delta;
    if (snap.level >= POLICE.radioLevel && this.radioCooldown <= 0) {
      this.radioCooldown = snap.level >= 5 ? 1600 : 3200;
      const lk = this.wanted.lastKnown;
      if (lk) {
        // 无线电通报半径随通缉等级扩大（3 星包围需要全城警力响应）
        const radioDist = 1100 + snap.level * 250;
        for (const p of this.polices) {
          if (p.state === 'PATROL' && Math.hypot(p.x - lk.x, p.y - lk.y) < radioDist) {
            p.investigate(lk.x, lk.y);
          }
        }
      }
    }

    // 步行警察撤回判定：玩家上车加速逃离 → 全部撤回
    if (snap.inVehicle && snap.speed > 90 && this.officers.length > 0) {
      for (const o of this.officers) if (o.state === 'PURSUE' || o.state === 'DEPLOY') o.state = 'RETURN';
    }

    // 每车视野检测（错开相位节流）+ AI 更新
    let seen = false;
    let chasing = false;
    for (let i = 0; i < this.polices.length; i++) {
      const p = this.polices[i];
      p.sightTimer -= delta;
      if (p.sightTimer <= 0) {
        p.sightTimer = POLICE.sightTick + i * 15;
        const range = p.sightRange(snap.level);
        const d = Math.hypot(snap.x - p.x, snap.y - p.y);
        p.seesPlayer = d < range && this.losClear(p.x, p.y, snap.x, snap.y);
      }

      const dist = Math.hypot(snap.x - p.x, snap.y - p.y);
      // Phase 3.1：步行玩家 + 本车贴近 + 已看清 → 停车放警察下车抓捕
      const hold =
        !snap.inVehicle &&
        p.state === 'CHASE' &&
        p.seesPlayer &&
        dist < ARREST.footDeployDist;
      if (
        hold &&
        p.actualMoveSpeed < ARREST.footDeploySpeed &&
        !p.officerDeployed &&
        this.officers.length < ARREST.officerMax
      ) {
        this.deployOfficer(p);
      }
      // 玩家跑远/上车逃走：撤回本车警察（警察独立走回，期间不影响本车恢复追击）
      if (p.officerDeployed && (snap.inVehicle || dist > ARREST.footDeployDist + 160)) {
        p.officerDeployed = false;
        for (const o of this.officers) if (o.state !== 'RETURN') o.state = 'RETURN';
      }

      const ctx: PoliceCtx = {
        playerX: snap.x,
        playerY: snap.y,
        playerInVehicle: snap.inVehicle,
        seesPlayer: p.seesPlayer,
        wantedLevel: snap.level,
        time,
        holdPosition: hold,
      };
      p.updateAI(delta, ctx, () => {
        this.wanted.markSeen(snap.x, snap.y, time);
      });

      if (p.seesPlayer) seen = true;
      if (p.chasing) {
        chasing = true;
        // 进入追捕时分配包围方位序号（0-3 循环）
        if (p.slotFresh) {
          p.chaseSlot = this.chaseSlotCounter % 4;
          this.chaseSlotCounter++;
          p.slotFresh = false;
        }
        // 追捕中警灯持续闪烁
        p.lightsOn();
      } else {
        p.lightsOff();
      }

      // 目标分配：需要新目标，或追捕中周期性重寻路（驻停中的车不再寻路）
      if ((p.needTarget || (p.state === 'CHASE' && p.repathTimer <= 0)) && !hold) {
        this.assignTarget(p);
      }
    }
    this.anySeen = seen;
    if (seen) this.wanted.markSeen(snap.x, snap.y, time);

    // 步行警察更新（追捕/撤回），超时未归队/到达警车的移除
    for (let i = this.officers.length - 1; i >= 0; i--) {
      const o = this.officers[i];
      o.update(delta, snap.x, snap.y);
      if (o.state === 'RETURN' && o.returnTimer > ARREST.officerReturnMs) {
        this.removeOfficer(i);
      }
    }

    // 追捕状态变化事件（HUD 提示）
    const prevChase = this.chaseActive;
    this.chaseActive = chasing;
    if (chasing && !prevChase) this.emit('chase-start');
    else if (!chasing && prevChase) this.emit('chase-end');

    // 警笛控制
    if (chasing) {
      if (!this.siren!.isPlaying) this.siren!.play();
    } else if (this.siren!.isPlaying) {
      this.siren!.stop();
    }

    // 增援 / 裁撤
    this.maintainFleet(delta);
  }

  // ---------------- 步行警察（下车抓捕） ----------------

  /** 从警车放出一个步行警察：在车周环带找可站立点（人行道优先，其次道路），不瞬移到玩家身边 */
  private deployOfficer(p: Police): void {
    let spawn: { x: number; y: number } | null = null;
    for (const dist of [30, 40, 52, 66]) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const x = p.x + Math.cos(ang) * dist;
        const y = p.y + Math.sin(ang) * dist;
        if (this.gen.isWalkablePx(x, y)) {
          spawn = { x, y }; // 人行道（优先）
          break;
        }
        if (!spawn) {
          const tx = Math.floor(x / TILE);
          const ty = Math.floor(y / TILE);
          const road = (this.gen.inH[ty] && this.gen.inH[ty][tx]) || (this.gen.inV[ty] && this.gen.inV[ty][tx]);
          if (road) spawn = { x, y }; // 道路也可（警察可走路面）
        }
      }
      if (spawn) break;
    }
    if (!spawn) return; // 车停在封闭区域则本次不下车
    const o = new Officer(this.scene, spawn.x, spawn.y, this.gen, p);
    this.officerGroup.add(o);
    // 到达警车旁（RETURN 结束）：从列表移除
    o.once('arrived-car', () => {
      const idx = this.officers.indexOf(o);
      if (idx >= 0) this.removeOfficer(idx);
    });
    this.officers.push(o);
    p.officerDeployed = true;
  }

  private removeOfficer(i: number): void {
    const o = this.officers[i];
    this.officers.splice(i, 1);
    o.destroy();
  }

  // ---------------- BUSTED 支持 ----------------

  /** 被捕瞬间：全部警车急停、警笛关闭（世界冻结由 GameScene 控制） */
  freezeAll(): void {
    for (const p of this.polices) {
      p.halt();
      p.lightsOff();
    }
    for (const o of this.officers) {
      (o.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
      o.anims.stop();
    }
    if (this.siren?.isPlaying) this.siren.stop();
  }

  /** RESPawn：全部警车回巡逻、警察全部撤回、状态清零 */
  resetToPatrol(): void {
    for (const p of this.polices) {
      if (p.state !== 'PATROL') p.enterState('PATROL');
      p.officerDeployed = false;
      p.lightsOff();
      p.needTarget = true;
    }
    while (this.officers.length > 0) this.removeOfficer(this.officers.length - 1);
  }
}
