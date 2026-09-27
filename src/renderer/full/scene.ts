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
import { INTERACT_RANGE } from '../../sim/arena.js';
import { aimAngles, convergeDistance, solveRig, type RigTarget } from './rig.js';
import { DAMAGE_COLOR, Fx } from './fx.js';

/** Mirrors `RARITY` in `src/sim/content/items.ts`. Colour is the whole point. */
const RARITY_HEX: Record<string, number> = {
  common: 0x8d8577,
  refined: 0xc9b98f,
  marked: 0xc98f4a,
  relic: 0x9c5f7a,
  sovereign: 0xd8d2c4,
};

const SHADOW_SIZE = 2048;
/** Low in the sky. Everything the direction promises comes from this angle. */
const SUN_DIR = new THREE.Vector3(-0.58, 0.235, -0.78).normalize();
/** A cool, dim, shadowless counter-key so silhouettes separate from the ground. */
const RIM_DIR = new THREE.Vector3(0.68, 0.34, 0.65).normalize();

/** Camera rig constants: an over-the-shoulder third person, pulled back for bosses. */
const CAM_DIST = 108;
/**
 * Lift and shoulder step the camera off the aim ray for framing. They cost
 * toe-in — the angle between the view and the barrel — and nothing else,
 * because the shot converges on whatever the crosshair covers; at these
 * values the toe-in is 2.2 degrees, which is invisible.
 *
 * The lift is what buys headroom. The muzzle sits 24 units off the sand, so
 * a boom that drops as you look up runs out of floor almost immediately: at
 * a 14-unit lift, a 20-degree up-look collapsed a 132-unit boom to 58 and the
 * framing lurched every time the player raised the gun. Lifting the pivot
 * flattens that — the boom now holds to within 5% out to 20 degrees.
 */
const CAM_LIFT = 34;
const CAM_SHOULDER = 18;
const CAM_BOSS_DIST = 430;
const CAM_BOSS_LIFT = 120;
/** Must match the simulation's muzzle height, `y + height * 0.72`. */
const MUZZLE_HEIGHT = 0.72;
/** The boom length over which the player fades out as the camera closes in. */
const FADE_NEAR = 26;
const FADE_FAR = 62;

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
  private hazardMeshes: THREE.Mesh[] = [];
  private dropMeshes: THREE.Object3D[] = [];
  private depositMeshes: THREE.Object3D[] = [];
  private scanMeshes: THREE.Object3D[] = [];
  private beam: THREE.Mesh;

  private camDist = CAM_DIST;
  private camLift = CAM_LIFT;
  /** How far down the centre ray the shot converges; see `rig.ts`. */
  private converge = 600;
  /** Reused each frame so the aim cast allocates nothing. */
  private readonly aimTargets: RigTarget[] = [];
  private playerActor: Actor | null = null;
  private playerOpacity = 1;
  /**
   * World aim implied by the rig — what the crosshair is actually covering.
   *
   * `main.ts` reads this and sends it to the simulation rather than sending
   * the raw camera angles: the camera does not sit on the gun, so the two are
   * not the same shot.
   */
  readonly aim = { yaw: 0, pitch: 0 };
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
    const orbital = snap.kind === 'orbital';

    // A derelict in low orbit is not a desert with different paint. It gets a
    // deck instead of dunes, hull ribs instead of kilns, a starfield instead of
    // a sky, and thin air instead of dust — the brief asks for one of these per
    // planet precisely so it reads as a change of place.
    this.scene.fog = orbital
      ? new THREE.FogExp2(0x1c232e, 0.00016)
      : new THREE.FogExp2(0x9c6236, 0.00028);
    this.sun.intensity = orbital ? 5.2 : 4.4;
    this.sun.color.setHex(orbital ? 0xf2f6ff : 0xfff0cf);

    // --- ground: a wide displaced plane, so the horizon is not a hard edge ---
    const groundGeo = new THREE.PlaneGeometry(6400, 6400, 96, 96);
    groundGeo.rotateX(-Math.PI / 2);
    const gp = groundGeo.attributes.position!;
    const colors = new Float32Array(gp.count * 3);
    const sand = new THREE.Color(orbital ? 0x4a5360 : 0x9a6b3e);
    const dark = new THREE.Color(orbital ? 0x1e242c : 0x4a2f1a);
    for (let i = 0; i < gp.count; i++) {
      const x = gp.getX(i);
      const z = gp.getZ(i);
      const d = Math.sqrt(x * x + z * z);
      // Flat inside the arena so the fight is fair; dunes beyond it.
      const outside = Math.max(0, d - snap.arenaRadius) / 900;
      // A deck is flat and falls away into nothing; a shelf has dunes beyond it.
      const h = orbital
        ? -Math.min(1, Math.max(0, d - snap.arenaRadius - 260) / 500) * 420
        : Math.sin(x * 0.004) * Math.cos(z * 0.0035) * 34 * Math.min(1, outside) +
          Math.sin(x * 0.014 + z * 0.011) * 5 * Math.min(1, outside);
      gp.setY(i, h);
      // Deck plating reads as a grid; sand reads as two frequencies of drift.
      const t = orbital
        ? (Math.abs((x % 160) - 80) < 7 || Math.abs((z % 160) - 80) < 7 ? 0.1 : 0.85)
        : 0.5 + 0.5 * Math.sin(x * 0.02 + z * 0.017);
      const t2 = orbital ? 0.2 : 0.5 + 0.5 * Math.sin(x * 0.0037 - z * 0.0051);
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
      new THREE.MeshLambertMaterial({ color: orbital ? 0x2c343e : 0x4a3320 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 2;
    rim.receiveShadow = true;
    rim.castShadow = true;
    env.add(rim);

    if (orbital) {
      // Hull ribs: the derelict's own structure, arcing over the deck. They do
      // the job the kilns do — they are the reason the player reads as small.
      const hullMat = new THREE.MeshLambertMaterial({ color: 0x39424e });
      const strutMat = new THREE.MeshLambertMaterial({ color: 0x232a33 });
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * Math.PI * 2 + rnd() * 0.2;
        const dist = snap.arenaRadius + 120 + rnd() * 260;
        const h = 420 + rnd() * 520;
        const rib = new THREE.Group();
        const spine = new THREE.Mesh(new THREE.BoxGeometry(36, h, 36), hullMat);
        spine.position.y = h / 2;
        spine.castShadow = true;
        spine.receiveShadow = true;
        rib.add(spine);
        // A cantilevered arm, so the silhouette is a gantry and not a pillar.
        const arm = new THREE.Mesh(new THREE.BoxGeometry(240, 22, 22), strutMat);
        arm.position.set(-90, h * 0.86, 0);
        arm.castShadow = true;
        rib.add(arm);
        rib.position.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
        rib.rotation.y = -ang;
        env.add(rib);
      }
      // Cargo stacks left on the deck.
      for (let i = 0; i < 26; i++) {
        const ang = rnd() * Math.PI * 2;
        const dist = snap.arenaRadius * (0.3 + rnd() * 0.62);
        const w = 26 + rnd() * 46;
        const crate = new THREE.Mesh(new THREE.BoxGeometry(w, w * (0.6 + rnd()), w), strutMat);
        crate.position.set(Math.cos(ang) * dist, w * 0.3, Math.sin(ang) * dist);
        crate.rotation.y = rnd() * Math.PI;
        crate.castShadow = true;
        crate.receiveShadow = true;
        env.add(crate);
      }
    } else {
      // --- kilns: enormous, static, and the entire sense of scale -----------
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

      // --- far mesas, fog-bound, purely for the horizon line ----------------
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
    }

    // --- sky: a gradient dome plus a hard sun disc --------------------------
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(3400, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(orbital ? 0x05070c : 0x1b2436) },
          mid: { value: new THREE.Color(orbital ? 0x0b1018 : 0x7a4526) },
          horizon: { value: new THREE.Color(orbital ? 0x18232f : 0xe8b07a) },
          accent: { value: new THREE.Color(snap.accent) },
          stars: { value: orbital ? 1 : 0 },
        },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 accent;
          uniform float stars;
          // Cheap hash, only used for the starfield.
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          void main(){
            vec3 n = normalize(vP);
            float h = clamp(n.y * 1.25 + 0.10, 0.0, 1.0);
            vec3 c = mix(horizon, mid, smoothstep(0.0, 0.22, h));
            c = mix(c, top, smoothstep(0.18, 0.85, h));
            // A wide warm glow around the sun, so the light has a source.
            float sd = max(0.0, dot(n, normalize(vec3(-0.58, 0.235, -0.78))));
            c += accent * pow(sd, 14.0) * 0.85;
            // The wide scatter halo is atmosphere. There is none in orbit, so
            // out there the accent stays on the planet limb and the star stays
            // a hard point.
            c += accent * pow(sd, 3.0) * 0.14 * (1.0 - stars);
            if (stars > 0.5) {
              // Vacuum: a sparse starfield, and a dim planet limb low down.
              vec2 g = floor(n.xy * 260.0);
              float s = step(0.9965, h21(g)) * smoothstep(-0.05, 0.35, n.y);
              c += vec3(s) * 0.9;
              float limb = smoothstep(0.06, -0.30, n.y) * smoothstep(-0.55, -0.05, n.y);
              c += accent * limb * 0.16;
            }
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    sky.name = 'sky';
    env.add(sky);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(orbital ? 42 : 90, 32),
      new THREE.MeshBasicMaterial({ color: orbital ? 0xffffff : 0xfff0d4, fog: false, depthWrite: false }),
    );
    disc.position.copy(SUN_DIR).multiplyScalar(3100);
    disc.lookAt(0, disc.position.y, 0);
    env.add(disc);

    this.scene.add(env);

    // Deposits and scan sites are per-arena, so they are rebuilt with the zone.
    this.depositMeshes = [];
    this.scanMeshes = [];
    for (const d of snap.deposits) {
      // A near-black rock on dark sand is scenery. A deposit is a place the
      // player has been told to go, so it has to be findable once the marker
      // has pointed at it: a seam of ore in the material's own colour.
      const node = new THREE.Group();
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(13, 0),
        new THREE.MeshLambertMaterial({ color: 0x2e2016 }),
      );
      rock.rotation.set(rnd(), rnd(), rnd());
      rock.scale.set(1, 0.7, 1.1);
      rock.castShadow = true;
      rock.receiveShadow = true;
      rock.position.y = 5;
      node.add(rock);
      const seam = new THREE.Mesh(
        new THREE.OctahedronGeometry(5.5, 0),
        new THREE.MeshLambertMaterial({ color: 0x3a2a18, emissive: this.accent, emissiveIntensity: 1.3 }),
      );
      seam.position.set(0, 11, 0);
      seam.scale.set(1, 0.7, 1);
      node.add(seam);
      node.position.set(d.x, 0, d.z);
      this.scene.add(node);
      this.depositMeshes.push(node);
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
    this.syncHazards(snap);
    this.syncDrops(snap, timeMs);
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

  /**
   * Where the camera is actually pointing, in world terms.
   *
   * Exists for the shell smoke test. The bug this exposes — a view that
   * disagrees with the shot — is invisible to every other probe the harness
   * has, because the simulation's aim was *correct* in the build that shipped
   * inverted. Only the rendered camera was wrong, and nothing outside this
   * class could see it.
   */
  forward(): { x: number; y: number; z: number } {
    const v = new THREE.Vector3();
    this.camera.getWorldDirection(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Camera placement and how visible the player is, for the same harness. */
  probe(): { cam: { x: number; y: number; z: number }; camY: number; playerOpacity: number } {
    const c = this.camera.position;
    return { cam: { x: c.x, y: c.y, z: c.z }, camY: c.y, playerOpacity: this.playerOpacity };
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
      if (e.kind === 'player') this.playerActor = actor;
      actor.position.set(e.x, e.y, e.z);
      // A submerged burrower sinks rather than vanishing, so its return reads.
      if (e.defId === 'hollow-drone') actor.position.y = e.y + 4 + Math.sin(timeMs * 0.004 + e.id) * 2.5;
      if (e.iframes > 40) actor.position.y = e.y - e.height * 0.9;
      actor.visible = true;

      animateActor(actor, {
        gait: e.gait,
        yaw: e.yaw,
        // World pitch, positive up — the barrel tilts the way the shot goes.
        aimPitch: e.kind === 'player' ? snap.player.aimPitch : undefined,
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

  /** Burning ground: an additive decal that shrinks as the patch burns out. */
  private syncHazards(snap: ArenaSnapshot): void {
    while (this.hazardMeshes.length < snap.hazards.length) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(1, 24),
        new THREE.MeshBasicMaterial({
          color: 0xff8a3a,
          transparent: true,
          opacity: 0.3,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      this.scene.add(m);
      this.hazardMeshes.push(m);
    }
    for (let i = 0; i < this.hazardMeshes.length; i++) {
      const m = this.hazardMeshes[i]!;
      const h = snap.hazards[i];
      if (!h) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(h.x, 1.6, h.z);
      m.scale.setScalar(h.radius * (0.6 + h.life * 0.4));
      (m.material as THREE.MeshBasicMaterial).color.setHex(DAMAGE_COLOR[h.type] ?? 0xff8a3a);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.12 + h.life * 0.26;
    }
  }

  /**
   * Loot on the sand.
   *
   * A weapon that appears as a line of text in a list is a spreadsheet entry.
   * One that is thrown off the body, glints on the ground and flies at you
   * when you walk near is a reward. Same item, same roll, same instant it
   * became yours — the difference is entirely here.
   *
   * A shard plus a column of light, because at 130 units the shard alone is
   * four pixels and a colour you cannot read. The column is what you see from
   * across the terrace; the shard is what you see when you arrive.
   */
  private syncDrops(snap: ArenaSnapshot, timeMs: number): void {
    while (this.dropMeshes.length < snap.drops.length) {
      const g = new THREE.Object3D();

      // A ring on the sand. This is the part that actually finds the loot:
      // it sits on the ground plane, so it reads against the ground at any
      // distance and from any angle, which a thin vertical shape does not.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(9, 15, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, fog: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 1.5;
      g.add(ring);

      const shard = new THREE.Mesh(
        new THREE.OctahedronGeometry(8),
        new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.1 }),
      );
      g.add(shard);

      // A shaft of light above it, for spotting one across the terrace.
      // Normal blending, not additive: additive light over bright sand is
      // arithmetic that cancels out, and the beacon disappears exactly where
      // every piece of loot in the game lies.
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 6, 165, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      );
      beam.position.y = 82;
      g.add(beam);

      g.userData = { ring, shard, beam };
      this.scene.add(g);
      this.dropMeshes.push(g);
    }

    for (let i = 0; i < this.dropMeshes.length; i++) {
      const g = this.dropMeshes[i]!;
      const d = snap.drops[i];
      if (!d) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      g.position.set(d.x, 0, d.z);
      const { ring, shard, beam } = g.userData as { ring: THREE.Mesh; shard: THREE.Mesh; beam: THREE.Mesh };

      shard.position.y = d.y + Math.sin(timeMs * 0.003 + i) * 2.4;
      shard.rotation.y = timeMs * 0.0022 + i;
      shard.rotation.x = Math.sin(timeMs * 0.0016 + i) * 0.35;

      const hex = RARITY_HEX[d.rarity] ?? 0xc9b98f;
      (shard.material as THREE.MeshLambertMaterial).color.setHex(hex);
      (shard.material as THREE.MeshLambertMaterial).emissive.setHex(hex);
      (ring.material as THREE.MeshBasicMaterial).color.setHex(hex);
      (beam.material as THREE.MeshBasicMaterial).color.setHex(hex);

      // Brightest as it lands, so a new drop announces itself, then settles
      // to a marker still findable two minutes later.
      const fresh = Math.max(0, 1 - d.age / 90);
      const pulse = 0.82 + Math.sin(timeMs * 0.005 + i) * 0.18;
      (ring.material as THREE.MeshBasicMaterial).opacity = (0.5 + fresh * 0.4) * pulse;
      (beam.material as THREE.MeshBasicMaterial).opacity = (0.16 + fresh * 0.26) * pulse;
      (shard.material as THREE.MeshLambertMaterial).emissiveIntensity = 0.9 + fresh * 1.5;
      ring.scale.setScalar(1 + fresh * 0.45);
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
   * Third-person rig.
   *
   * The boom lies *along* the aim ray — not on a separate orbit — so the
   * camera and the gun cannot point in different directions. Lift and
   * shoulder step the camera off that ray for framing; the shot then
   * converges on whatever the centre ray actually meets, so what the
   * crosshair covers is what the bullet hits. `rig.ts` holds the arithmetic
   * and `test/rig.test.ts` holds it to that promise.
   *
   * With a boss on the field it pulls back to frame both fighters — a
   * set-piece the player cannot see all of is not a set-piece. It pulls back
   * *along the ray* and no longer biases where the camera points: a rig that
   * looks somewhere other than where the gun is aimed lies to the reticle,
   * and a boss fight is the worst moment to start lying. Distance and lift
   * both ease, so the pull-back still reads as a beat.
   */
  private updateCamera(
    player: ArenaSnapshot['entities'][number],
    boss: ArenaSnapshot['entities'][number] | undefined,
    cam: CameraInput,
    snap: ArenaSnapshot,
    dt: number,
  ): void {
    let wantDist = CAM_DIST;
    let wantLift = CAM_LIFT;

    if (boss) {
      const gap = Math.hypot(boss.x - player.x, boss.z - player.z);
      // The Warden is 150 units tall before its stacks and stands close.
      wantDist = Math.min(CAM_BOSS_DIST, CAM_DIST + gap * 0.55 + boss.height * 1.15);
      wantLift = CAM_BOSS_LIFT;
    }

    const ease = Math.min(1, 0.055 * dt);
    this.camDist += (wantDist - this.camDist) * ease;
    this.camLift += (wantLift - this.camLift) * ease;

    const rig = solveRig({
      yaw: cam.yaw,
      pitch: cam.pitch,
      dist: this.camDist,
      lift: this.camLift,
      // A long boom already frames the fight; a wide shoulder on top of it is
      // just parallax you pay for at every range.
      shoulder: CAM_SHOULDER * (boss ? 0.45 : 1),
      muzzle: { x: player.x, y: player.y + player.height * MUZZLE_HEIGHT, z: player.z },
    });

    this.aimTargets.length = 0;
    for (const e of snap.entities) {
      if (e.kind === 'player') continue;
      this.aimTargets.push({ x: e.x, y: e.y, z: e.z, radius: e.radius, height: e.height });
    }
    this.converge = convergeDistance(rig, this.aimTargets, snap.arenaRadius);
    const aim = aimAngles(rig, this.converge);
    this.aim.yaw = aim.yaw;
    this.aim.pitch = aim.pitch;

    // The look target sits on the centre ray, so `lookAt` reproduces the
    // rig's forward vector exactly — the one `convergeDistance` cast along.
    this.camTarget.set(
      rig.pos.x + rig.forward.x * this.converge,
      rig.pos.y + rig.forward.y * this.converge,
      rig.pos.z + rig.forward.z * this.converge,
    );
    this.camera.position.set(rig.pos.x, rig.pos.y, rig.pos.z);

    // Shake translates the whole rig rather than rotating it, so a hit that
    // rattles the camera never rattles the aim.
    this.shake += (snap.shake - this.shake) * 0.4;
    const sh = this.shake;
    if (sh > 0.05) {
      const jx = (Math.random() - 0.5) * sh * 1.6;
      const jy = (Math.random() - 0.5) * sh * 1.2;
      const jz = (Math.random() - 0.5) * sh * 1.6;
      this.camera.position.x += jx;
      this.camera.position.y += jy;
      this.camera.position.z += jz;
      this.camTarget.x += jx;
      this.camTarget.y += jy;
      this.camTarget.z += jz;
    }

    // The rig already keeps the camera clear of the sand by shortening the
    // boom, which is the only way to do it without tilting the view off the
    // shot. This is a floor under the *shake*, nothing more.
    this.camera.position.y = Math.max(4, this.camera.position.y);
    this.camera.lookAt(this.camTarget);

    // Looking steeply up pulls the boom in to keep the camera out of the
    // sand, and a boom that short puts the player's own shoulder across the
    // crosshair. Fade them out rather than let them block the shot; a
    // silhouette you cannot see past is worse than no silhouette.
    const boom = Math.hypot(
      this.camera.position.x - rig.muzzle.x,
      this.camera.position.y - rig.muzzle.y,
      this.camera.position.z - rig.muzzle.z,
    );
    this.setPlayerOpacity(Math.min(1, Math.max(0, (boom - FADE_NEAR) / (FADE_FAR - FADE_NEAR))));
  }

  /** Dissolves the player actor as the camera closes on it. */
  private setPlayerOpacity(opacity: number): void {
    if (!this.playerActor || opacity === this.playerOpacity) return;
    this.playerOpacity = opacity;
    this.playerActor.visible = opacity > 0.02;
    this.playerActor.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const mat = m as THREE.Material;
        mat.transparent = opacity < 0.999;
        mat.opacity = opacity;
        mat.depthWrite = opacity > 0.9;
      }
    });
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
        case 'chain':
          // The arc is drawn between the two bodies it jumped, so a chain is
          // something the player sees happen rather than a damage number that
          // appears somewhere they were not looking.
          this.fx.tracer(ev.x, ev.y, ev.z, ev.x, ev.y, ev.z, 'arc', 7);
          this.fx.impact(ev.x, ev.y, ev.z, 'arc', false, false);
          break;
        case 'warded':
          // Deflection, not damage: a cold spark and no number, so the player
          // reads "that did nothing" rather than "that did a small amount".
          this.fx.impact(ev.x, ev.y, ev.z, 'arc', false, false);
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

    if (snap.outcome === 'running') this.drawObjectives(ctx, snap, W, H, dpr);

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

  /**
   * Markers over the deposits and scan sites.
   *
   * The gate asks for three mined and two scanned. The sites were six dark
   * rocks and five short posts scattered at random bearings across a disc
   * twelve hundred units wide, with nothing on screen pointing at any of
   * them and no prompt when you were finally standing on one. The reasonable
   * conclusion from inside the game was that mining did not work, and that
   * is exactly what got reported.
   *
   * So: a marker on every live site, clamped to the screen edge with an
   * arrow when it is behind you or out of frame, carrying its distance. In
   * range it says what key to hold — and it says *hold*, because the channel
   * is four seconds and a tap does nothing visible.
   */
  private drawObjectives(
    ctx: CanvasRenderingContext2D,
    snap: ArenaSnapshot,
    W: number,
    H: number,
    dpr: number,
  ): void {
    const px = snap.player.x;
    const pz = snap.player.z;
    // Asymmetric, because the chrome is: the stat bar across the top, and the
    // defence bars and weapon readout along the bottom corners. A marker
    // clamped to a symmetric ring slides under all three.
    const mx = 52 * dpr;
    const mTop = 64 * dpr;
    const mBottom = 104 * dpr;
    const v = new THREE.Vector3();
    const cam = new THREE.Vector3();

    interface Target { x: number; z: number; label: string; progress: number; needed: boolean }

    /**
     * The nearest sites you still need, and one spare.
     *
     * Marking all eleven pinned a row of labels along the top edge that
     * overlapped each other and said nothing useful — a map of the whole
     * terrace when the question is "where do I go next". The spare is there
     * so the nearest one being across the arena is not an instruction.
     * Once a requirement is met its markers go entirely; the sites are still
     * lit in the world for anyone who wants the extra materials.
     */
    const pick = (
      sites: readonly { x: number; z: number; progress: number }[],
      have: number,
      need: number,
      label: string,
    ): Target[] => {
      const remaining = need - have;
      if (remaining <= 0) return [];
      return sites
        .map((sc) => ({ sc, d: Math.hypot(sc.x - px, sc.z - pz) }))
        .sort((l, r) => l.d - r.d)
        .slice(0, remaining + 1)
        .map(({ sc }) => ({ x: sc.x, z: sc.z, label, progress: sc.progress, needed: true }));
    };

    const targets: Target[] = [
      ...pick(
        snap.deposits.filter((d) => !d.depleted),
        snap.gate.deposits,
        snap.gate.depositsNeeded,
        'MINE',
      ),
      ...pick(
        snap.scans.filter((sc) => !sc.done),
        snap.gate.scans,
        snap.gate.scansNeeded,
        'SCAN',
      ),
    ];
    if (targets.length === 0) return;

    ctx.textAlign = 'center';
    ctx.lineWidth = Math.max(1, dpr);

    for (const t of targets) {
      const dist = Math.hypot(t.x - px, t.z - pz);
      const inRange = dist < INTERACT_RANGE;

      v.set(t.x, 30, t.z);
      cam.copy(v).applyMatrix4(this.camera.matrixWorldInverse);
      const behind = cam.z > -1;
      v.project(this.camera);
      let sx = (v.x * 0.5 + 0.5) * W;
      let sy = (-v.y * 0.5 + 0.5) * H;
      // Behind the camera the projection folds through the origin, so the
      // marker would swing to the wrong side. Mirror it before clamping.
      if (behind) {
        sx = W - sx;
        sy = H - sy;
      }
      const clamped =
        behind || sx < mx || sx > W - mx || sy < mTop || sy > H - mBottom;
      sx = Math.max(mx, Math.min(W - mx, sx));
      sy = Math.max(mTop, Math.min(H - mBottom, sy));

      // Anything already satisfied stays on screen but stops competing for
      // attention: the materials are still worth taking, the gate is not.
      const alpha = t.needed ? (inRange ? 1 : 0.8) : 0.3;
      const color = inRange ? '#f0a860' : t.needed ? '#e9decb' : '#8d8577';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      const r = (clamped ? 9 : 7) * dpr;
      ctx.beginPath();
      if (clamped) {
        // A triangle aimed out of the frame, toward the thing.
        const ang = Math.atan2(sy - H / 2, sx - W / 2);
        for (let i = 0; i < 3; i++) {
          const a = ang + (i * 2 * Math.PI) / 3;
          const fx = sx + Math.cos(a) * r;
          const fy = sy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(fx, fy);
          else ctx.lineTo(fx, fy);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        // A diamond, so it never reads as part of the world.
        ctx.moveTo(sx, sy - r);
        ctx.lineTo(sx + r, sy);
        ctx.lineTo(sx, sy + r);
        ctx.lineTo(sx - r, sy);
        ctx.closePath();
        ctx.stroke();
      }

      // Channelling progress, as a ring closing around the marker.
      if (t.progress > 0 && t.progress < 1) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 5 * dpr, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
        ctx.lineWidth = 2.5 * dpr;
        ctx.stroke();
        ctx.lineWidth = Math.max(1, dpr);
      }

      ctx.font = `500 ${Math.round(10 * dpr)}px Inter, "Segoe UI", system-ui, sans-serif`;
      const text = inRange ? `HOLD E — ${t.label}` : `${t.label} ${Math.round(dist)}m`;
      const ty = sy + r + 14 * dpr;
      // A centred label on a marker pinned to the left edge runs off the
      // screen. Turn the text inward instead of letting it fall off.
      const near = 90 * dpr;
      ctx.textAlign = sx < near ? 'left' : sx > W - near ? 'right' : 'center';
      const tx = sx < near ? sx - r : sx > W - near ? sx + r : sx;
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(8,6,5,0.85)';
      ctx.strokeText(text, tx, ty);
      ctx.fillStyle = color;
      ctx.fillText(text, tx, ty);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.textAlign = 'center';
    }
    ctx.globalAlpha = 1;
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
