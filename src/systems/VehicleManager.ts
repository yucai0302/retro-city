/**
 * 车辆管理：在路边车位 / 停车场生成停放车辆，统一接碰撞体。
 * 初期不做交通 AI，以停放车辆为主。
 */
import * as Phaser from 'phaser';
import { TILE, MAP_W, MAP_H } from '../config';
import { CityGenerator } from './CityGenerator';
import { T } from './TextureFactory';
import { Vehicle, VehicleKind } from '../entities/Vehicle';

const SEDAN_VARIANTS = 6;
const SPORTS_VARIANTS = 4;

export class VehicleManager {
  readonly group: Phaser.Physics.Arcade.Group;
  readonly vehicles: Vehicle[] = [];
  active: Vehicle | null = null;
  private scene: Phaser.Scene;
  private gen: CityGenerator;

  constructor(
    scene: Phaser.Scene,
    gen: CityGenerator,
    solids: Phaser.Physics.Arcade.StaticGroup,
    npcGroup: Phaser.Physics.Arcade.Group,
    onCrash: (impact: number) => void,
    onHitNpc?: (v: Vehicle, npc: Phaser.Physics.Arcade.Sprite) => void
  ) {
    this.scene = scene;
    this.gen = gen;
    this.group = scene.physics.add.group();

    this.spawnRoadside();
    this.spawnLots();
    this.ensureCarNearSpawn();

    // 与建筑 / 树木碰撞
    scene.physics.add.collider(this.group, solids, (obj) => {
      (obj as Vehicle).noteImpact(scene.time.now);
    });
    // 车辆之间碰撞（活动的车撞上停放的车）
    scene.physics.add.collider(this.group, this.group, (a, b) => {
      (a as Vehicle).noteImpact(scene.time.now);
      (b as Vehicle).noteImpact(scene.time.now);
    });
    // 车辆与行人碰撞（可以推开行人，不穿透）；玩家驾车撞 NPC 上报犯罪事件（携带 NPC 实体供击败/掉落结算）
    scene.physics.add.collider(this.group, npcGroup, (a, b) => {
      const v = a instanceof Vehicle ? a : b instanceof Vehicle ? b : null;
      const npc = (a instanceof Vehicle ? b : a) as Phaser.Physics.Arcade.Sprite;
      if (v && onHitNpc) onHitNpc(v, npc);
    });
    for (const v of this.vehicles) v.setCrashHandler(onCrash);
  }

  private pickKind(): VehicleKind {
    const r = Math.random();
    if (r < 0.45) return 'sedan';
    if (r < 0.65) return 'taxi';
    if (r < 0.82) return 'sports';
    return 'truck';
  }

  private addVehicle(kind: VehicleKind, x: number, y: number, rotation: number): Vehicle {
    // 多色变体贴图（不用 tint，车灯颜色不被染色）
    let texKey: string | undefined;
    if (kind === 'sedan') texKey = `car-sedan-${Phaser.Math.Between(0, SEDAN_VARIANTS - 1)}`;
    else if (kind === 'sports') texKey = `car-sports-${Phaser.Math.Between(0, SPORTS_VARIANTS - 1)}`;
    const v = new Vehicle(this.scene, x, y, kind, rotation, texKey);
    this.group.add(v);
    v.setParked(true); // group.add 会用 group 默认配置覆盖 immovable，这里重新锁定停放态
    this.vehicles.push(v);
    return v;
  }

  private isRoadTile(t: number): boolean {
    return t === T.ASPHALT || t === T.ROAD_H || t === T.ROAD_V;
  }

  /** 路边停车：沿道路带的外侧车道顺向停车，不进路口、不停双车道窄路 */
  private spawnRoadside(): void {
    let placed = 0;
    // 横向道路：顺路朝向 ±90°
    for (const b of this.gen.hBands) {
      if (b.size < 3 || placed >= 22) continue;
      const lane = Math.random() < 0.5 ? b.start : b.start + b.size - 1;
      let c = 4 + Phaser.Math.Between(0, 3);
      while (c < MAP_W - 5 && placed < 22) {
        if (!this.gen.inV[lane][c] && this.isRoadTile(this.gen.ground[lane][c]) && Phaser.Math.Between(0, 9) < 6) {
          const rot = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
          this.addVehicle(this.pickKind(), c * TILE + TILE / 2, lane * TILE + TILE / 2, rot);
          placed++;
          c += Phaser.Math.Between(6, 11);
        } else {
          c++;
        }
      }
    }
    // 纵向道路：顺路朝向 0°/180°
    for (const b of this.gen.vBands) {
      if (b.size < 3 || placed >= 40) continue;
      const lane = Math.random() < 0.5 ? b.start : b.start + b.size - 1;
      let r = 4 + Phaser.Math.Between(0, 3);
      while (r < MAP_H - 5 && placed < 40) {
        if (!this.gen.inH[r][lane] && this.isRoadTile(this.gen.ground[r][lane]) && Phaser.Math.Between(0, 9) < 6) {
          const rot = Math.random() < 0.5 ? 0 : Math.PI;
          this.addVehicle(this.pickKind(), lane * TILE + TILE / 2, r * TILE + TILE / 2, rot);
          placed++;
          r += Phaser.Math.Between(6, 11);
        } else {
          r++;
        }
      }
    }
  }

  /** 停车场：按车位线成排停车 */
  private spawnLots(): void {
    for (const lot of this.gen.parkingLots) {
      let count = 0;
      for (let ty = lot.y0; ty <= lot.y1 && count < 10; ty += 2) {
        for (let tx = lot.x0; tx <= lot.x1 && count < 10; tx += 2) {
          if (Phaser.Math.Between(0, 9) < 4) {
            this.addVehicle(this.pickKind(), tx * TILE + TILE / 2, ty * TILE + TILE / 2, 0);
            count++;
          }
        }
      }
    }
  }

  /** 保证出生点附近一定有一辆黄色出租车（核心体验闭环） */
  private ensureCarNearSpawn(): void {
    const ps = this.gen.playerStart;
    let best: { x: number; y: number; d: number } | null = null;
    // 横向道路：从出生点列向两侧扫描，跳过路口列
    for (const b of this.gen.hBands) {
      if (b.size < 3) continue;
      const lane = ps.ty < b.start + b.size / 2 ? b.start : b.start + b.size - 1;
      const laneDist = Math.abs(lane - ps.ty);
      let found: { x: number; y: number; d: number } | null = null;
      for (let off = 0; off <= 8 && !found; off++) {
        for (const c of off === 0 ? [ps.tx] : [ps.tx - off, ps.tx + off]) {
          if (c < 5 || c >= MAP_W - 5) continue;
          if (this.gen.inV[lane][c] || !this.isRoadTile(this.gen.ground[lane][c])) continue;
          found = { x: c * TILE + TILE / 2, y: lane * TILE + TILE / 2, d: laneDist + off };
          break;
        }
      }
      if (found && (!best || found.d < best.d)) best = found;
    }
    // 纵向道路：从出生点行向两侧扫描，跳过路口行
    for (const b of this.gen.vBands) {
      if (b.size < 3) continue;
      const lane = ps.tx < b.start + b.size / 2 ? b.start : b.start + b.size - 1;
      const laneDist = Math.abs(lane - ps.tx);
      let found: { x: number; y: number; d: number } | null = null;
      for (let off = 0; off <= 8 && !found; off++) {
        for (const r of off === 0 ? [ps.ty] : [ps.ty - off, ps.ty + off]) {
          if (r < 5 || r >= MAP_H - 5) continue;
          if (this.gen.inH[r][lane] || !this.isRoadTile(this.gen.ground[r][lane])) continue;
          found = { x: lane * TILE + TILE / 2, y: r * TILE + TILE / 2, d: laneDist + off };
          break;
        }
      }
      if (found && (!best || found.d < best.d)) best = found;
    }
    if (best) this.addVehicle('taxi', best.x, best.y, Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
  }

  findNearest(x: number, y: number, maxDist: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = maxDist * maxDist;
    for (const v of this.vehicles) {
      const dx = v.x - x;
      const dy = v.y - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** 扣押并移除一辆车（BUSTED 结算：被扣押车辆不再作为可驾驶车辆使用） */
  removeVehicle(v: Vehicle): void {
    const idx = this.vehicles.indexOf(v);
    if (idx < 0) return;
    this.vehicles.splice(idx, 1);
    if (this.active === v) this.active = null;
    v.destroy();
  }

  update(delta: number, input: { throttle: boolean; brake: boolean; steer: number; handbrake: boolean } | null): void {
    for (const v of this.vehicles) {
      if (v === this.active && input) {
        v.update(delta, input);
      } else {
        v.update(delta, null);
      }
    }
  }
}
