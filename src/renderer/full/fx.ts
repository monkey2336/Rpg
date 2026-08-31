/**
 * Combat effects and atmosphere.
 *
 * The brief is blunt that weapon impact is half of how a shooter feels, so this
 * is not decoration — muzzle flash, tracer, impact spark, hitstop and shake are
 * the feedback loop that makes a hit register. All of it is pooled into a small
 * fixed number of draw calls: one LineSegments for every tracer, one Points for
 * every spark, one Points for all the dust, and a single reused muzzle light.
 */
import * as THREE from '../vendor/three.module.js';

const MAX_TRACERS = 64;
const MAX_SPARKS = 400;
const DUST_COUNT = 1400;

export const DAMAGE_COLOR: Record<string, number> = {
  percussive: 0xd9c7a3,
  solar: 0xe8853a,
  caustic: 0x8fae4b,
  arc: 0x6fa9c9,
};

interface Tracer {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  life: number;
  maxLife: number;
  color: THREE.Color;
}

interface Spark {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
}

export interface FloatingNumber {
  x: number; y: number; z: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  scale: number;
}

export class Fx {
  private tracers: Tracer[] = [];
  private sparks: Spark[] = [];
  numbers: FloatingNumber[] = [];

  private tracerMesh: THREE.LineSegments;
  private tracerPos: Float32Array;
  private tracerCol: Float32Array;

  private sparkPoints: THREE.Points;
  private sparkPos: Float32Array;
  private sparkCol: Float32Array;
  private sparkSize: Float32Array;

  private dust: THREE.Points;
  private dustVel: Float32Array;

  private muzzleLight: THREE.PointLight;
  private muzzleLife = 0;

  constructor(private scene: THREE.Scene) {
    // --- tracers: one draw call for all of them ---
    this.tracerPos = new Float32Array(MAX_TRACERS * 2 * 3);
    this.tracerCol = new Float32Array(MAX_TRACERS * 2 * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    tg.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3));
    this.tracerMesh = new THREE.LineSegments(
      tg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.tracerMesh.frustumCulled = false;
    scene.add(this.tracerMesh);

    // --- sparks ---
    this.sparkPos = new Float32Array(MAX_SPARKS * 3);
    this.sparkCol = new Float32Array(MAX_SPARKS * 3);
    this.sparkSize = new Float32Array(MAX_SPARKS);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    this.sparkPoints = new THREE.Points(
      sg,
      new THREE.PointsMaterial({
        size: 2.4,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.sparkPoints.frustumCulled = false;
    scene.add(this.sparkPoints);

    // --- dust: in every frame, per the art direction ---
    const dp = new Float32Array(DUST_COUNT * 3);
    this.dustVel = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 1600;
      dp[i * 3 + 1] = Math.random() * 260;
      dp[i * 3 + 2] = (Math.random() - 0.5) * 1600;
      this.dustVel[i * 3] = 3 + Math.random() * 7;
      this.dustVel[i * 3 + 1] = (Math.random() - 0.4) * 1.2;
      this.dustVel[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dust = new THREE.Points(
      dg,
      new THREE.PointsMaterial({
        size: 1.5,
        color: 0xd8c4a2,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.dust.frustumCulled = false;
    scene.add(this.dust);

    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 300, 2);
    scene.add(this.muzzleLight);
  }

  /** A shot leaving the muzzle: light, and a tracer toward wherever it went. */
  muzzle(x: number, y: number, z: number, type: string): void {
    this.muzzleLight.position.set(x, y, z);
    this.muzzleLight.color.setHex(DAMAGE_COLOR[type] ?? 0xffb060);
    this.muzzleLife = 3;
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, type: string, ticks = 5): void {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    this.tracers.push({
      ax, ay, az, bx, by, bz,
      life: ticks,
      maxLife: ticks,
      color: new THREE.Color(DAMAGE_COLOR[type] ?? 0xd9c7a3),
    });
  }

  /** Impact spray. Crits throw more, and further. */
  impact(x: number, y: number, z: number, type: string, crit: boolean, weak: boolean): void {
    const count = weak ? 22 : crit ? 16 : 8;
    const speed = weak ? 3.4 : crit ? 2.6 : 1.7;
    const color = new THREE.Color(DAMAGE_COLOR[type] ?? 0xd9c7a3);
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= MAX_SPARKS) this.sparks.shift();
      const a = Math.random() * Math.PI * 2;
      const b = Math.random() * Math.PI - Math.PI / 2;
      const s = speed * (0.4 + Math.random());
      this.sparks.push({
        x, y, z,
        vx: Math.cos(a) * Math.cos(b) * s,
        vy: Math.abs(Math.sin(b)) * s * 1.4,
        vz: Math.sin(a) * Math.cos(b) * s,
        life: 14 + Math.random() * 16,
        maxLife: 30,
        size: weak ? 3.4 : 2.2,
        color,
      });
    }
  }

  number(x: number, y: number, z: number, text: string, color: string, scale = 1): void {
    if (this.numbers.length > 40) this.numbers.shift();
    this.numbers.push({ x, y, z, vy: 0.55, life: 46, maxLife: 46, text, color, scale });
  }

  /** `dt` is in ticks (1 = one 40Hz step), so effects run at sim pace. */
  update(dt: number, focusX: number, focusZ: number): void {
    // --- tracers ---
    let ti = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!;
      t.life -= dt;
      if (t.life <= 0) {
        this.tracers.splice(i, 1);
        continue;
      }
      const k = t.life / t.maxLife;
      const o = ti * 6;
      this.tracerPos[o] = t.ax; this.tracerPos[o + 1] = t.ay; this.tracerPos[o + 2] = t.az;
      this.tracerPos[o + 3] = t.bx; this.tracerPos[o + 4] = t.by; this.tracerPos[o + 5] = t.bz;
      for (const j of [0, 3]) {
        this.tracerCol[o + j] = t.color.r * k;
        this.tracerCol[o + j + 1] = t.color.g * k;
        this.tracerCol[o + j + 2] = t.color.b * k;
      }
      ti++;
      if (ti >= MAX_TRACERS) break;
    }
    this.tracerMesh.geometry.setDrawRange(0, ti * 2);
    this.tracerMesh.geometry.attributes.position!.needsUpdate = true;
    this.tracerMesh.geometry.attributes.color!.needsUpdate = true;

    // --- sparks ---
    let si = 0;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.vy -= 0.16 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      if (s.y < 0) {
        s.y = 0;
        s.vy *= -0.3;
        s.vx *= 0.6;
        s.vz *= 0.6;
      }
      const k = s.life / s.maxLife;
      this.sparkPos[si * 3] = s.x;
      this.sparkPos[si * 3 + 1] = s.y;
      this.sparkPos[si * 3 + 2] = s.z;
      this.sparkCol[si * 3] = s.color.r * k;
      this.sparkCol[si * 3 + 1] = s.color.g * k;
      this.sparkCol[si * 3 + 2] = s.color.b * k;
      this.sparkSize[si] = s.size;
      si++;
      if (si >= MAX_SPARKS) break;
    }
    this.sparkPoints.geometry.setDrawRange(0, si);
    this.sparkPoints.geometry.attributes.position!.needsUpdate = true;
    this.sparkPoints.geometry.attributes.color!.needsUpdate = true;

    // --- numbers ---
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      n.life -= dt;
      n.y += n.vy * dt;
      n.vy *= 0.97;
      if (n.life <= 0) this.numbers.splice(i, 1);
    }

    // --- dust, wrapped around whatever the camera is looking at ---
    const pos = this.dust.geometry.attributes.position!.array as Float32Array;
    const half = 800;
    for (let i = 0; i < DUST_COUNT; i++) {
      const o = i * 3;
      pos[o] = pos[o]! + this.dustVel[o]! * dt * 0.1;
      pos[o + 1] = pos[o + 1]! + this.dustVel[o + 1]! * dt * 0.1;
      pos[o + 2] = pos[o + 2]! + this.dustVel[o + 2]! * dt * 0.1;
      if (pos[o]! - focusX > half) pos[o] = focusX - half;
      if (pos[o]! - focusX < -half) pos[o] = focusX + half;
      if (pos[o + 2]! - focusZ > half) pos[o + 2] = focusZ - half;
      if (pos[o + 2]! - focusZ < -half) pos[o + 2] = focusZ + half;
      if (pos[o + 1]! > 300) pos[o + 1] = 0;
      if (pos[o + 1]! < 0) pos[o + 1] = 300;
    }
    this.dust.geometry.attributes.position!.needsUpdate = true;

    // --- muzzle light ---
    if (this.muzzleLife > 0) {
      this.muzzleLife -= dt;
      this.muzzleLight.intensity = Math.max(0, this.muzzleLife) * 900;
    } else {
      this.muzzleLight.intensity = 0;
    }
  }

  dispose(): void {
    for (const o of [this.tracerMesh, this.sparkPoints, this.dust]) {
      this.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.scene.remove(this.muzzleLight);
  }
}
