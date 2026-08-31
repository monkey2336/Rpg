/**
 * The 3D game view.
 *
 * Presentation only. It reads an `ArenaSnapshot` and draws it; it cannot reach
 * the sim, and the only state it keeps between frames is visual — camera
 * easing, shake, effect pools, and a map of live actor meshes.
 *
 * The art direction does most of the work here and it is all lighting rather
 * than assets: one hard, low sun with a shadow map, a warm bounce from the
 * ground and a cold one from the sky, and exponential dust fog that turns
 * distance into aerial perspective for free. Everything in the scene is
 * untextured primitives; the sun is what makes them read.
 */
import * as THREE from '../vendor/three.module.js';
import type { ArenaSnapshot } from '../../sim/snapshot.js';
import { animateActor, buildHostile, buildPlayer, disposeActor, type Actor } from './actors.js';
import { DAMAGE_COLOR, Fx } from './fx.js';

const SHADOW_SIZE = 2048;
/** Low in the sky. Everything the direction promises comes from this angle. */
const SUN_DIR = new THREE.Vector3(-0.58, 0.235, -0.78).normalize();
/** A cool, dim, shadowless counter-key so silhouettes separate from the ground. */
const RIM_DIR = new THREE.Vector3(0.68, 0.34, 0.65).normalize();

/** Camera rig constants: an over-the-shoulder third person, pulled back for bosses. */
const CAM_DIST = 132;
const CAM_HEIGHT = 62;
const CAM_SHOULDER = 26;
const CAM_BOSS_DIST = 430;
const CAM_BOSS_HEIGHT = 205;

export interface CameraInput {
  yaw: number;
  pitch: number;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private sun: THREE.DirectionalLight;
  private camFill: THREE.DirectionalLight;
  private fx: Fx;

  private actors = new Map<number, Actor>();
  private telegraphs = new Map<number, THREE.Mesh>();
  private telegraphPool: THREE.Mesh[] = [];
  private projectiles: THREE.Mesh[] = [];
  private depositMeshes: THREE.Object3D[] = [];
  private scanMeshes: THREE.Object3D[] = [];
  private beam: THREE.Mesh;

  private camDist = CAM_DIST;
  private camHeight = CAM_HEIGHT;
  private camTarget = new THREE.Vector3();
  private shake = 0;
  private builtZone = '';
  private accent = new THREE.Color(0xe8853a);

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 1, 5000);

    // Thin enough that the kilns stay solid shapes rather than ghosts, thick
    // enough that distance still washes out. Dense fog reads as haze; this
    // reads as air.
    this.scene.fog = new THREE.FogExp2(0x9c6236, 0.00028);
    this.scene.background = new THREE.Color(0x2a1a10);

    // --- light ---------------------------------------------------------
    // One sun, low and hard. Everything the direction promises — long shadows,
    // raking light, brutalist mass — comes from this light and its shadow map.
    this.sun = new THREE.DirectionalLight(0xfff0cf, 4.4);
    this.sun.position.copy(SUN_DIR).multiplyScalar(900);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    const cam = this.sun.shadow.camera;
    cam.left = -700;
    cam.right = 700;
    cam.top = 700;
    cam.bottom = -700;
    cam.near = 100;
    cam.far = 2200;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 1.4;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Cold fill from the sky, warm bounce off the sand. Kept low: the shadow
    // side wants to be dark, or the hard sun stops meaning anything.
    this.scene.add(new THREE.HemisphereLight(0x4d6a8c, 0x7a4a22, 0.42));
    this.scene.add(new THREE.AmbientLight(0x2e2216, 0.32));

    // Shadowless counter-key. Without it every actor is a black hole against
    // the sand; with it they read as objects that are simply in shadow.
    const rim = new THREE.DirectionalLight(0x93b4d6, 1.15);
    rim.position.copy(RIM_DIR).multiplyScalar(800);
    this.scene.add(rim);

    // A dim fill riding with the camera. With a low sun behind the action,
    // everything the player looks at is facing its own shadow side; without
    // this the whole cast reads as black cut-outs. Kept weak enough that the
    // sun still owns the image.
    this.camFill = new THREE.DirectionalLight(0xbfc9d8, 0.85);
    this.scene.add(this.camFill);
    this.scene.add(this.camFill.target);

    this.fx = new Fx(this.scene);

    // Sustained beam, shown only while the solar lance is firing.
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 2.6, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffb066,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.beam.visible = false;
    this.scene.add(this.beam);

    this.overlayCtx = overlay.getContext('2d');
  }

  private overlayCtx: CanvasRenderingContext2D | null;

  /* ------------------------------ environment ---------------------------- */

  /**
   * Builds the terrace and everything static on it.
   *
   * Rebuilt only when the zone changes. Geometry is generated from a hash of
   * the zone id, so a given zone looks the same every time you land on it
   * without any of it being stored.
   */
  private buildEnvironment(snap: ArenaSnapshot): void {
    if (this.builtZone === snap.zoneId) return;
    this.builtZone = snap.zoneId;
    this.accent = new THREE.Color(snap.accent);

    for (const name of ['env']) {
      const old = this.scene.getObjectByName(name);
      if (old) {
        this.scene.remove(old);
        disposeActor(old);
      }
    }
    const env = new THREE.Group();
    env.name = 'env';

    let seed = 0;
    for (let i = 0; i < snap.zoneId.length; i++) seed = (Math.imul(seed, 31) + snap.zoneId.charCodeAt(i)) >>> 0;
    const rnd = mulberry(seed);

    // --- ground: a wide displaced plane, so the horizon is not a hard edge ---
    const groundGeo = new THREE.PlaneGeometry(6400, 6400, 96, 96);
    groundGeo.rotateX(-Math.PI / 2);
    const gp = groundGeo.attributes.position!;
    const colors = new Float32Array(gp.count * 3);
    const sand = new THREE.Color(0x9a6b3e);
    const dark = new THREE.Color(0x4a2f1a);
    for (let i = 0; i < gp.count; i++) {
      const x = gp.getX(i);
      const z = gp.getZ(i);
      const d = Math.sqrt(x * x + z * z);
      // Flat inside the arena so the fight is fair; dunes beyond it.
      const outside = Math.max(0, d - snap.arenaRadius) / 900;
      const h = Math.sin(x * 0.004) * Math.cos(z * 0.0035) * 34 * Math.min(1, outside) +
        Math.sin(x * 0.014 + z * 0.011) * 5 * Math.min(1, outside);
      gp.setY(i, h);
      // Two frequencies of drift, so the ground has grain instead of a gradient.
      const t = 0.5 + 0.5 * Math.sin(x * 0.02 + z * 0.017);
      const t2 = 0.5 + 0.5 * Math.sin(x * 0.0037 - z * 0.0051);
      const c = sand.clone().lerp(dark, t * 0.35 + t2 * 0.45);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    ground.receiveShadow = true;
    env.add(ground);

    // --- the terrace rim: reads the play space without walling it in --------
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(snap.arenaRadius, 7, 5, 96),
      new THREE.MeshLambertMaterial({ color: 0x4a3320 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 2;
    rim.receiveShadow = true;
    rim.castShadow = true;
    env.add(rim);

    // --- kilns: enormous, static, and the entire sense of scale -------------
    const kilnMat = new THREE.MeshLambertMaterial({ color: 0x3d2a1a });
    const kilnDark = new THREE.MeshLambertMaterial({ color: 0x2a1c11 });
    const count = 16;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + rnd() * 0.3;
      const dist = snap.arenaRadius + 220 + rnd() * 900;
      const h = 260 + rnd() * 620;
      const w = 70 + rnd() * 130;
      const kiln = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.62, w, h, 6), kilnMat);
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      kiln.add(body);
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.16, w * 0.2, h * 0.35, 6), kilnDark);
      stack.position.y = h * 1.16;
      stack.castShadow = true;
      kiln.add(stack);
      kiln.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
      kiln.rotation.y = rnd() * Math.PI;
      env.add(kiln);
    }

    // --- far mesas, fog-bound, purely for the horizon line ------------------
    const mesaMat = new THREE.MeshLambertMaterial({ color: 0x4e3722 });
    for (let i = 0; i < 22; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = 1900 + rnd() * 900;
      const h = 180 + rnd() * 520;
      const mesa = new THREE.Mesh(new THREE.CylinderGeometry(180 + rnd() * 260, 320 + rnd() * 300, h, 5), mesaMat);
      mesa.position.set(Math.cos(ang) * dist, h / 2 - 40, Math.sin(ang) * dist);
      mesa.rotation.y = rnd() * Math.PI;
      env.add(mesa);
    }

    // --- sky: a gradient dome plus a hard sun disc --------------------------
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(3400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x1b2436) },
          mid: { value: new THREE.Color(0x7a4526) },
          horizon: { value: new THREE.Color(0xe8b07a) },
          accent: { value: new THREE.Color(snap.accent) },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 accent;
          void main(){
            vec3 n = normalize(vP);
            float h = clamp(n.y * 1.25 + 0.10, 0.0, 1.0);
            vec3 c = mix(horizon, mid, smoothstep(0.0, 0.22, h));
            c = mix(c, top, smoothstep(0.18, 0.85, h));
            // A wide warm glow around the sun, so the light has a source.
            float sd = max(0.0, dot(n, normalize(vec3(-0.58, 0.235, -0.78))));
            c += accent * pow(sd, 14.0) * 0.85;
            c += accent * pow(sd, 3.0) * 0.14;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.name = 'sky';
    env.add(sky);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(90, 32),
      new THREE.MeshBasicMaterial({ color: 0xfff0d4, fog: false, depthWrite: false }),
    );
    disc.position.copy(SUN_DIR).multiplyScalar(3100);
    disc.lookAt(0, disc.position.y, 0);
    env.add(disc);

    this.scene.add(env);

    // Deposits and scan sites are per-arena, so they are rebuilt with the zone.
    this.depositMeshes = [];
    this.scanMeshes = [];
    for (const d of snap.deposits) {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(13, 0),
        new THREE.MeshLambertMaterial({ color: 0x2e2016 }),
      );
      rock.position.set(d.x, 5, d.z);
      rock.rotation.set(rnd(), rnd(), rnd());
      rock.scale.set(1, 0.7, 1.1);
      rock.castShadow = true;
      rock.receiveShadow = true;
      this.scene.add(rock);
      this.depositMeshes.push(rock);
    }
    for (const s of snap.scans) {
      const post = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 1.6, 34, 5),
        new THREE.MeshLambertMaterial({ color: 0x241a12 }),
      );
      pole.position.y = 17;
      pole.castShadow = true;
      post.add(pole);
      const lamp = new THREE.Mesh(
        new THREE.OctahedronGeometry(5, 0),
        new THREE.MeshLambertMaterial({ color: 0x1a1410, emissive: this.accent, emissiveIntensity: 1.6 }),
      );
      lamp.position.y = 37;
      post.add(lamp);
      post.position.set(s.x, 0, s.z);
      this.scene.add(post);
      this.scanMeshes.push(post);
    }
  }

  /* -------------------------------- update ------------------------------- */

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.overlay.width !== Math.floor(w * dpr)) {
      this.overlay.width = Math.floor(w * dpr);
      this.overlay.height = Math.floor(h * dpr);
    }
  }

  /** Syncs the scene graph to a snapshot and renders one frame. */
  render(snap: ArenaSnapshot | null, cam: CameraInput, dtTicks: number, timeMs: number): void {
    this.resize();
    if (!snap) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.buildEnvironment(snap);

    const player = snap.entities.find((e) => e.kind === 'player');
    const boss = snap.entities.find((e) => e.kind === 'boss');

    this.syncActors(snap, timeMs);
    this.syncTelegraphs(snap);
    this.syncProjectiles(snap);
    this.syncPickups(snap);
    this.syncBeam(snap, player);

    if (player) this.updateCamera(player, boss, cam, snap, dtTicks);
    this.fx.update(dtTicks, player?.x ?? 0, player?.z ?? 0);

    this.sun.position.copy(SUN_DIR).multiplyScalar(900).add(new THREE.Vector3(player?.x ?? 0, 0, player?.z ?? 0));
    this.sun.target.position.set(player?.x ?? 0, 0, player?.z ?? 0);
    this.sun.target.updateMatrixWorld();

    const sky = this.scene.getObjectByName('sky');
    if (sky && player) sky.position.set(player.x, 0, player.z);

    // Fill rides the camera, aimed at whatever the camera is aimed at.
    this.camFill.position.copy(this.camera.position);
    this.camFill.target.position.copy(this.camTarget);
    this.camFill.target.updateMatrixWorld();

    this.renderer.render(this.scene, this.camera);
    this.drawOverlay(snap);
  }

  /* -------------------------------- actors ------------------------------- */

  private syncActors(snap: ArenaSnapshot, timeMs: number): void {
    const seen = new Set<number>();
    for (const e of snap.entities) {
      seen.add(e.id);
      let actor = this.actors.get(e.id);
      if (!actor) {
        actor = e.kind === 'player' ? buildPlayer() : buildHostile(e.defId);
        this.scene.add(actor);
        this.actors.set(e.id, actor);
      }
      actor.position.set(e.x, e.y, e.z);
      // A submerged burrower sinks rather than vanishing, so its return reads.
      if (e.defId === 'hollow-drone') actor.position.y = e.y + 4 + Math.sin(timeMs * 0.004 + e.id) * 2.5;
      if (e.iframes > 40) actor.position.y = e.y - e.height * 0.9;
      actor.visible = true;

      animateActor(actor, {
        gait: e.gait,
        yaw: e.yaw,
        aimPitch: e.kind === 'player' ? -snap.player.aimPitch : undefined,
        grounded: e.grounded,
        flash: e.flash,
        glow: e.weakPoints.length > 0 ? 1 : e.kind === 'boss' ? 0.15 : 0.1,
        timeMs,
      });
    }

    for (const [id, actor] of this.actors) {
      if (seen.has(id)) continue;
      this.scene.remove(actor);
      disposeActor(actor);
      this.actors.delete(id);
    }
  }

  /* ------------------------------ telegraphs ----------------------------- */

  /**
   * Telegraphs are ground decals: flat, additive, and lying on the sand.
   *
   * The five shapes are the game's whole warning vocabulary, so they are drawn
   * as literally as possible — a ring is a ring on the floor, a cone is a wedge
   * pointing where it will hit. Fill rises with the wind-up so the deadline is
   * readable without a countdown.
   */
  private syncTelegraphs(snap: ArenaSnapshot): void {
    const seen = new Set<number>();
    for (let i = 0; i < snap.telegraphs.length; i++) {
      const t = snap.telegraphs[i]!;
      const key = i;
      seen.add(key);
      let mesh = this.telegraphs.get(key);
      if (!mesh) {
        mesh = this.telegraphPool.pop() ?? this.makeDecal();
        this.scene.add(mesh);
        this.telegraphs.set(key, mesh);
      }
      const color = DAMAGE_COLOR[t.type] ?? 0xe8853a;
      const m = mesh.material as THREE.MeshBasicMaterial;
      m.color.setHex(color);
      m.opacity = 0.16 + t.progress * 0.5;

      mesh.geometry.dispose();
      mesh.geometry = this.decalGeometry(t);
      mesh.position.set(t.x, 1.2, t.z);
      mesh.rotation.set(-Math.PI / 2, 0, -t.yaw);
      mesh.visible = true;
    }
    for (const [key, mesh] of this.telegraphs) {
      if (seen.has(key)) continue;
      this.scene.remove(mesh);
      mesh.visible = false;
      this.telegraphPool.push(mesh);
      this.telegraphs.delete(key);
    }
  }

  private makeDecal(): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.CircleGeometry(1, 8),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
  }

  private decalGeometry(t: ArenaSnapshot['telegraphs'][number]): THREE.BufferGeometry {
    switch (t.shape) {
      case 'ring':
      case 'column':
        return new THREE.CircleGeometry(t.r, 48);
      case 'pulse': {
        // Safe in the middle, caught in the expanding band — so the decal is a
        // band, not a disc. Reading it wrong is the point of the mechanic.
        const r = t.r * 0.7;
        return new THREE.RingGeometry(Math.max(1, r - 70), r + 70, 48);
      }
      case 'line': {
        const g = new THREE.PlaneGeometry(900, t.r * 2);
        g.translate(450, 0, 0);
        return g;
      }
      case 'cone':
        return new THREE.CircleGeometry(t.r, 32, -0.55, 1.1);
      default:
        return new THREE.CircleGeometry(t.r, 24);
    }
  }

  /* ------------------------------ projectiles ---------------------------- */

  private syncProjectiles(snap: ArenaSnapshot): void {
    while (this.projectiles.length < snap.projectiles.length) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      );
      this.scene.add(m);
      this.projectiles.push(m);
    }
    for (let i = 0; i < this.projectiles.length; i++) {
      const m = this.projectiles[i]!;
      const p = snap.projectiles[i];
      if (!p) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(p.x, p.y, p.z);
      m.scale.setScalar(p.r * 0.9);
      (m.material as THREE.MeshBasicMaterial).color.setHex(
        p.hostile ? 0xd0673f : DAMAGE_COLOR[p.type] ?? 0xd9cdb8,
      );
    }
  }

  private syncPickups(snap: ArenaSnapshot): void {
    for (let i = 0; i < this.depositMeshes.length; i++) {
      const d = snap.deposits[i];
      const m = this.depositMeshes[i]!;
      if (!d) continue;
      m.visible = !d.depleted;
      m.rotation.y += d.progress > 0 && d.progress < 1 ? 0.03 : 0;
    }
    for (let i = 0; i < this.scanMeshes.length; i++) {
      const s = snap.scans[i];
      const m = this.scanMeshes[i]!;
      if (!s) continue;
      const lamp = m.children[1] as THREE.Mesh | undefined;
      if (lamp) {
        const mat = lamp.material as THREE.MeshLambertMaterial;
        mat.emissiveIntensity = s.done ? 0.05 : 0.9 + Math.sin(performance.now() * 0.006) * 0.5;
        lamp.rotation.y += 0.02;
      }
    }
  }

  /** The solar lance draws an actual beam; every other weapon draws tracers. */
  private syncBeam(snap: ArenaSnapshot, player: ArenaSnapshot['entities'][number] | undefined): void {
    this.beam.visible = false;
    if (!player || !snap.player.firing || snap.player.beamRamp <= 0) return;
    const oy = player.y + player.height * 0.72;
    const len = 460;
    const cp = Math.cos(snap.player.aimPitch);
    const dir = new THREE.Vector3(cp * Math.cos(snap.player.aimYaw), Math.sin(snap.player.aimPitch), cp * Math.sin(snap.player.aimYaw));
    const start = new THREE.Vector3(player.x, oy, player.z);
    const end = start.clone().addScaledVector(dir, len);
    this.beam.position.copy(start).lerp(end, 0.5);
    this.beam.scale.set(1 + snap.player.beamRamp, len, 1 + snap.player.beamRamp);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.45 + snap.player.beamRamp * 0.4;
    this.beam.visible = true;
  }

  /* -------------------------------- camera ------------------------------- */

  /**
   * Third-person rig with an over-the-shoulder offset.
   *
   * With a boss on the field it pulls back and rises to frame both fighters —
   * a set-piece the player cannot see all of is not a set-piece. Both the
   * distance and the height ease, so the pull-back reads as a beat.
   */
  private updateCamera(
    player: ArenaSnapshot['entities'][number],
    boss: ArenaSnapshot['entities'][number] | undefined,
    cam: CameraInput,
    snap: ArenaSnapshot,
    dt: number,
  ): void {
    let wantDist = CAM_DIST;
    let wantHeight = CAM_HEIGHT;
    const focus = new THREE.Vector3(player.x, player.y + player.height * 0.8, player.z);

    if (boss) {
      const gap = Math.hypot(boss.x - player.x, boss.z - player.z);
      // The Warden is 150 units tall before its stacks and stands close. The
      // rig has to back off hard or the set-piece is just a wall of plate.
      wantDist = Math.min(CAM_BOSS_DIST, CAM_DIST + gap * 0.55 + boss.height * 1.15);
      wantHeight = CAM_BOSS_HEIGHT;
      // Bias the framing toward the boss without losing the player.
      focus.x += (boss.x - player.x) * 0.3;
      focus.z += (boss.z - player.z) * 0.3;
      focus.y += boss.height * 0.4;
    }

    const ease = Math.min(1, 0.055 * dt);
    this.camDist += (wantDist - this.camDist) * ease;
    this.camHeight += (wantHeight - this.camHeight) * ease;
    this.camTarget.lerp(focus, Math.min(1, 0.22 * dt));

    const cp = Math.cos(cam.pitch);
    const offset = new THREE.Vector3(
      -Math.cos(cam.yaw) * cp * this.camDist,
      this.camHeight + Math.sin(-cam.pitch) * this.camDist,
      -Math.sin(cam.yaw) * cp * this.camDist,
    );
    // Shoulder offset, perpendicular to the view.
    const right = new THREE.Vector3(-Math.sin(cam.yaw), 0, Math.cos(cam.yaw));
    offset.addScaledVector(right, CAM_SHOULDER * (boss ? 0.2 : 1));

    this.shake += (snap.shake - this.shake) * 0.4;
    const s = this.shake;
    this.camera.position.copy(this.camTarget).add(offset);
    if (s > 0.05) {
      this.camera.position.x += (Math.random() - 0.5) * s * 1.6;
      this.camera.position.y += (Math.random() - 0.5) * s * 1.2;
      this.camera.position.z += (Math.random() - 0.5) * s * 1.6;
    }
    // Never let the camera go under the sand.
    this.camera.position.y = Math.max(14, this.camera.position.y);
    this.camera.lookAt(this.camTarget);
  }

  /* -------------------------------- events ------------------------------- */

  /**
   * Turns one tick's sim events into effects.
   *
   * The sim emits what happened; everything about how it *feels* — the flash,
   * the tracer, the spray, the number that floats off a crit — is decided here.
   */
  consumeEvents(events: { type: string; x: number; y: number; z: number; amount: number; damageType: string; crit: boolean; text: string }[], snap: ArenaSnapshot | null): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'shot': {
          this.fx.muzzle(ev.x, ev.y, ev.z, ev.damageType);
          if (snap) {
            const cp = Math.cos(snap.player.aimPitch);
            const len = 900;
            this.fx.tracer(
              ev.x, ev.y, ev.z,
              ev.x + cp * Math.cos(snap.player.aimYaw) * len,
              ev.y + Math.sin(snap.player.aimPitch) * len,
              ev.z + cp * Math.sin(snap.player.aimYaw) * len,
              ev.damageType,
            );
          }
          break;
        }
        case 'hit':
          this.fx.impact(ev.x, ev.y, ev.z, ev.damageType, ev.crit, false);
          if (ev.amount >= 1) {
            this.fx.number(ev.x, ev.y, ev.z, String(Math.round(ev.amount)), ev.crit ? '#ffd9a0' : '#d9cdb8', ev.crit ? 1.35 : 1);
          }
          break;
        case 'weak':
          this.fx.impact(ev.x, ev.y, ev.z, ev.damageType, true, true);
          this.fx.number(ev.x, ev.y, ev.z, String(Math.round(ev.amount)), '#ff9a3c', 1.6);
          break;
        case 'player-hit':
          this.shake = Math.max(this.shake, 5);
          break;
        case 'kill':
          this.fx.impact(ev.x, ev.y + 12, ev.z, 'percussive', false, false);
          break;
        case 'boss-down':
          this.shake = 26;
          for (let i = 0; i < 6; i++) {
            this.fx.impact(ev.x + (Math.random() - 0.5) * 80, ev.y + Math.random() * 120, ev.z + (Math.random() - 0.5) * 80, 'solar', true, true);
          }
          break;
        case 'resolve':
          this.shake = Math.max(this.shake, 7);
          break;
        default:
          break;
      }
    }
  }

  /* ------------------------------- overlay ------------------------------- */

  /** Damage numbers, drawn on a 2D layer so they stay crisp at any distance. */
  private drawOverlay(snap: ArenaSnapshot): void {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    const W = this.overlay.width;
    const H = this.overlay.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const dpr = W / Math.max(1, this.overlay.clientWidth);

    const v = new THREE.Vector3();
    for (const n of this.fx.numbers) {
      v.set(n.x, n.y, n.z).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * W;
      const sy = (-v.y * 0.5 + 0.5) * H;
      const k = n.life / n.maxLife;
      ctx.globalAlpha = Math.min(1, k * 1.8);
      ctx.font = `300 ${Math.round(15 * n.scale * dpr)}px Inter, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(8,6,5,0.85)';
      ctx.strokeText(n.text, sx, sy);
      ctx.fillStyle = n.color;
      ctx.fillText(n.text, sx, sy);
    }
    ctx.globalAlpha = 1;

    // A hairline reticle, dead centre, that opens with recoil.
    if (snap.outcome === 'running') {
      const cx = W / 2;
      const cy = H / 2;
      const gap = (7 + snap.player.recoil * 90) * dpr;
      const len = 7 * dpr;
      ctx.strokeStyle = 'rgba(233,222,203,0.75)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        ctx.moveTo(cx + dx * gap, cy + dy * gap);
        ctx.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
      }
      ctx.stroke();
    }
  }

  dispose(): void {
    this.fx.dispose();
    this.renderer.dispose();
  }
}

/** Small deterministic PRNG for environment layout. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
