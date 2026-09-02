/**
 * Actor meshes, built from primitives at runtime.
 *
 * There are no art assets in this project, and that is a deliberate direction
 * rather than a shortcut: the brief asks for a committed stylised look that
 * "reads as higher quality at a fraction of the cost", and silhouette-first
 * shapes under a hard sun do exactly that. Everything here is boxes, cylinders,
 * spheres and cones, assembled into things that read at a glance.
 *
 * Each builder returns a Group whose `userData.parts` holds the pieces that
 * animate. Walk cycles are driven by `gait` — ground distance travelled, which
 * the sim already accumulates — so legs stay in step with actual movement
 * instead of drifting against it.
 */
import * as THREE from '../vendor/three.module.js';

export interface ActorParts {
  legs: THREE.Object3D[];
  body?: THREE.Object3D;
  head?: THREE.Object3D;
  weapon?: THREE.Object3D;
  /** Emissive pieces that brighten when a weak point is exposed. */
  glows: THREE.Mesh[];
  /** Every mesh whose material tints on a hit flash. */
  skin: THREE.Mesh[];
}

export interface Actor extends THREE.Group {
  userData: {
    parts: ActorParts;
    defId: string;
    kind: string;
    baseColor: number;
  };
}

const DARK = 0x272019;
const PLATE = 0x342a20;
const BONE = 0xb8ab93;
const HOT = 0xff7a2a;

function mat(color: number, opts: { emissive?: number; emissiveIntensity?: number } = {}): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

function box(w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A tapered box: 4-sided cylinder, which is the workhorse shape of this world. */
function taper(rTop: number, rBottom: number, h: number, m: THREE.Material, sides = 4): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, sides), m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sphere(r: number, m: THREE.Material, seg = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A jointed leg: hip pivot, thigh, knee pivot, shin.
 *
 * Returned as the hip pivot so the animator can rotate one object and get a
 * whole leg. The knee is stored on `userData.knee` for the second joint.
 */
function leg(len: number, thickness: number, m: THREE.Material): THREE.Object3D {
  const hip = new THREE.Object3D();
  const thigh = box(thickness, len * 0.55, thickness, m);
  thigh.position.y = -len * 0.275;
  hip.add(thigh);

  const knee = new THREE.Object3D();
  knee.position.y = -len * 0.55;
  const shin = box(thickness * 0.8, len * 0.45, thickness * 0.8, m);
  shin.position.y = -len * 0.225;
  knee.add(shin);
  hip.add(knee);
  hip.userData.knee = knee;
  return hip;
}

/* -------------------------------- player ---------------------------------- */

export function buildPlayer(): Actor {
  const g = new THREE.Group() as Actor;
  const dark = mat(DARK);
  const cloth = mat(0x201a14);
  const skin: THREE.Mesh[] = [];
  const legs: THREE.Object3D[] = [];

  for (const side of [-1, 1]) {
    const l = leg(20, 4.4, dark);
    l.position.set(0, 21, side * 3.6);
    g.add(l);
    legs.push(l);
  }

  const torso = taper(5.2, 6.4, 15, dark, 6);
  torso.position.y = 29;
  g.add(torso);
  skin.push(torso);

  // The coat is the character: a heavy flared skirt that reads instantly as a
  // silhouette, and the only thing separating this from a generic box-person.
  const coat = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 11.5, 17, 8, 1, true), cloth);
  coat.position.y = 25;
  coat.castShadow = true;
  coat.material.side = THREE.DoubleSide;
  g.add(coat);
  skin.push(coat);

  // Bone-coloured yoke: one light element high on the figure, which is what
  // makes a backlit silhouette read as a person rather than a post.
  const shoulders = box(14, 3.6, 9, mat(0x6d6252));
  shoulders.position.y = 37;
  g.add(shoulders);
  skin.push(shoulders);

  const head = sphere(3.6, mat(0x3a3128));
  head.position.set(0, 41.5, 0);
  g.add(head);
  skin.push(head);

  // Rebreather and hood-ridge, so the head is not just a ball.
  const mask = box(3, 2.4, 4.6, mat(BONE));
  mask.position.set(2.4, 40.6, 0);
  g.add(mask);

  const pack = box(6, 9, 7.5, mat(PLATE));
  pack.position.set(-5.5, 32, 0);
  g.add(pack);
  skin.push(pack);

  // Weapon pivot: yaw comes from the body, pitch is applied to this node.
  const weapon = new THREE.Object3D();
  weapon.position.set(3, 34, 4.5);
  const barrel = box(26, 2.4, 2.4, mat(0x15110d));
  barrel.position.x = 13;
  weapon.add(barrel);
  const receiver = box(9, 4.4, 3.4, mat(0x4a3f31));
  receiver.position.x = 2;
  weapon.add(receiver);
  const sight = box(2, 2.4, 1.6, mat(0x6d6252));
  sight.position.set(6, 3.2, 0);
  weapon.add(sight);
  g.add(weapon);

  g.userData = { parts: { legs, body: torso, head, weapon, glows: [], skin }, defId: 'player', kind: 'player', baseColor: DARK };
  return g;
}

/* ------------------------------- hostiles --------------------------------- */

function insectLegs(g: THREE.Group, count: number, ring: number, len: number, thickness: number, y: number, m: THREE.Material): THREE.Object3D[] {
  const legs: THREE.Object3D[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    const l = leg(len, thickness, m);
    l.position.set(Math.cos(a) * ring, y, Math.sin(a) * ring);
    l.rotation.z = Math.cos(a) * 0.5;
    l.rotation.x = -Math.sin(a) * 0.5;
    g.add(l);
    legs.push(l);
  }
  return legs;
}

export function buildHostile(defId: string): Actor {
  const g = new THREE.Group() as Actor;
  const shell = mat(0x2a221a);
  const plate = mat(PLATE);
  const skin: THREE.Mesh[] = [];
  const glows: THREE.Mesh[] = [];
  let legs: THREE.Object3D[] = [];

  switch (defId) {
    case 'shelf-tick': {
      const body = taper(5, 11, 11, shell, 6);
      body.position.y = 13;
      body.rotation.z = 0.2;
      g.add(body);
      skin.push(body);
      const carapace = sphere(8, shell, 8);
      carapace.scale.set(1.3, 0.55, 1);
      carapace.position.y = 16;
      g.add(carapace);
      skin.push(carapace);
      legs = insectLegs(g, 6, 9, 12, 1.5, 12, shell);
      break;
    }
    case 'vault-mite': {
      const body = taper(1, 9, 12, shell, 4);
      body.position.y = 12;
      g.add(body);
      skin.push(body);
      const eye = sphere(2.2, mat(0x120f0c, { emissive: 0x4a6f8a, emissiveIntensity: 1.6 }));
      eye.position.set(5, 13, 0);
      g.add(eye);
      glows.push(eye);
      legs = insectLegs(g, 6, 7, 10, 1.2, 11, shell);
      break;
    }
    case 'flint-skirmisher': {
      const body = taper(4.5, 7.5, 17, shell, 6);
      body.position.y = 26;
      g.add(body);
      skin.push(body);
      const head = taper(1.5, 4.5, 7, shell, 5);
      head.position.set(3, 35, 0);
      head.rotation.z = -1.1;
      g.add(head);
      skin.push(head);
      // Blade arms: the read is "this one closes and cuts".
      for (const side of [-1, 1]) {
        const blade = box(16, 1.6, 3.4, mat(0x1d1712));
        blade.position.set(5, 29, side * 7);
        blade.rotation.z = 0.3;
        g.add(blade);
        skin.push(blade);
      }
      legs = insectLegs(g, 2, 5, 18, 2.2, 18, shell);
      break;
    }
    case 'duster-artillery': {
      const drum = taper(9, 10.5, 15, plate, 8);
      drum.position.y = 22;
      g.add(drum);
      skin.push(drum);
      const barrel = taper(3.2, 4.2, 20, mat(0x0a0806), 6);
      barrel.position.set(6, 30, 0);
      barrel.rotation.z = -1.05;
      g.add(barrel);
      skin.push(barrel);
      const vent = sphere(2.4, mat(0x140f0b, { emissive: 0x6f8a3a, emissiveIntensity: 1.4 }));
      vent.position.set(-7, 26, 0);
      g.add(vent);
      glows.push(vent);
      legs = insectLegs(g, 4, 9, 15, 1.8, 15, plate);
      break;
    }
    case 'hollow-drone': {
      // Hovers: no legs, a hanging spine and a lit intake instead.
      const hull = sphere(9, plate, 12);
      hull.scale.set(1.25, 0.8, 1.05);
      hull.position.y = 21;
      g.add(hull);
      skin.push(hull);
      const intake = new THREE.Mesh(new THREE.TorusGeometry(6, 1.4, 6, 14), mat(0x140f0b, { emissive: 0xc4552a, emissiveIntensity: 1.5 }));
      intake.rotation.x = Math.PI / 2;
      intake.position.y = 21;
      g.add(intake);
      glows.push(intake);
      const spine = taper(0.8, 2.6, 12, shell, 5);
      spine.position.y = 10;
      g.add(spine);
      skin.push(spine);
      break;
    }
    case 'chalk-praetor': {
      const body = taper(9, 13, 34, plate, 6);
      body.position.y = 40;
      g.add(body);
      skin.push(body);
      const crest = taper(1, 7, 12, plate, 5);
      crest.position.y = 62;
      g.add(crest);
      skin.push(crest);
      // The slab it carries: a walking piece of cover, which is the whole
      // reason this thing is a difficulty spike.
      const slab = box(3.5, 34, 20, mat(0x2a2119));
      slab.position.set(6, 40, -16);
      g.add(slab);
      skin.push(slab);
      const eye = sphere(2.6, mat(0x120f0c, { emissive: 0x6fa9c9, emissiveIntensity: 1.8 }));
      eye.position.set(9, 56, 0);
      g.add(eye);
      glows.push(eye);
      legs = insectLegs(g, 4, 12, 26, 3, 26, plate);
      break;
    }
    case 'kiln-warden': {
      // A kiln that learned to walk. Held high on six legs so the player can
      // run under it, which is what phase two is about.
      const body = taper(54, 78, 78, plate, 6);
      body.position.y = 106;
      g.add(body);
      skin.push(body);

      // Panel breakup. Without it a body this large is one flat facet and the
      // sun has nothing to catch, which is what makes big things read as slabs.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const rib = box(10, 62, 16, mat(0x1d1710));
        rib.position.set(Math.cos(a) * 66, 106, Math.sin(a) * 66);
        rib.rotation.y = -a;
        g.add(rib);
        skin.push(rib);
      }

      // A brighter cap: the top plane is the only surface a low sun really hits,
      // so it is the one that gets to be light.
      const shoulder = taper(64, 56, 24, mat(0x5a4a37), 6);
      shoulder.position.y = 156;
      g.add(shoulder);
      skin.push(shoulder);

      const collar = new THREE.Mesh(new THREE.TorusGeometry(58, 6, 5, 6), mat(0x3d3226));
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 142;
      g.add(collar);
      skin.push(collar);

      // Three stacks, rooted into the cap rather than floating over it.
      for (let i = 0; i < 3; i++) {
        const h = 74 + i * 16;
        const stack = taper(10, 14, h, mat(0x2e2419), 6);
        stack.position.set(-22 + i * 22, 168 + h / 2, i === 1 ? 18 : -14);
        g.add(stack);
        skin.push(stack);
        const band = new THREE.Mesh(new THREE.TorusGeometry(12, 2.2, 4, 6), mat(0x120e0a));
        band.rotation.x = Math.PI / 2;
        band.position.set(stack.position.x, stack.position.y + h * 0.3, stack.position.z);
        g.add(band);
        const mouth = new THREE.Mesh(new THREE.CircleGeometry(9, 8), mat(0x0a0806, { emissive: HOT, emissiveIntensity: 0.5 }));
        mouth.rotation.x = -Math.PI / 2;
        mouth.position.set(stack.position.x, stack.position.y + h / 2 + 1, stack.position.z);
        g.add(mouth);
        glows.push(mouth);
      }

      // Flank vents — the phase-one weak point, dull until it vents.
      for (const side of [-1, 1]) {
        const vent = box(26, 22, 5, mat(0x120e0a, { emissive: HOT, emissiveIntensity: 0.25 }));
        vent.position.set(-6, 104, side * 74);
        g.add(vent);
        glows.push(vent);
      }
      // Core aperture on the chest, and the ganglion on its back.
      const core = new THREE.Mesh(new THREE.TorusGeometry(16, 4, 8, 18), mat(0x140f0b, { emissive: HOT, emissiveIntensity: 0.3 }));
      core.rotation.y = Math.PI / 2;
      core.position.set(58, 74, 0);
      g.add(core);
      glows.push(core);

      const ganglion = sphere(14, mat(0x171009, { emissive: 0x8fae4b, emissiveIntensity: 0.25 }), 10);
      ganglion.position.set(-78, 122, 0);
      g.add(ganglion);
      glows.push(ganglion);

      legs = insectLegs(g, 6, 64, 78, 13, 76, mat(0x241c14));
      break;
    }
    case 'shield-pylon': {
      // Anchored, lit, and obviously the thing to shoot: a tripod base with a
      // ward emitter that reads as a light source rather than a creature.
      const base = taper(5, 11, 12, plate, 3);
      base.position.y = 6;
      g.add(base);
      skin.push(base);
      const mast = taper(3, 4.5, 26, plate, 5);
      mast.position.y = 24;
      g.add(mast);
      skin.push(mast);
      const emitter = new THREE.Mesh(
        new THREE.OctahedronGeometry(7, 0),
        mat(0x131a20, { emissive: 0x6fa9c9, emissiveIntensity: 2.2 }),
      );
      emitter.position.y = 41;
      g.add(emitter);
      glows.push(emitter);
      const ward = new THREE.Mesh(new THREE.TorusGeometry(10, 1, 4, 16), mat(0x101418, { emissive: 0x6fa9c9, emissiveIntensity: 1.4 }));
      ward.rotation.x = Math.PI / 2;
      ward.position.y = 41;
      g.add(ward);
      glows.push(ward);
      break;
    }

    case 'the-bellows': {
      // A lung: a ribbed concertina barrel rooted into the floor, with a flared
      // throat aimed forward and up. It never walks in phase one, so the roots
      // do the work the legs would.
      const body = taper(46, 62, 130, plate, 8);
      body.position.y = 74;
      g.add(body);
      skin.push(body);

      // Concertina ribs — the read is "this thing expands and contracts".
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const r = 50 + Math.sin(t * Math.PI) * 16;
        const rib = new THREE.Mesh(new THREE.TorusGeometry(r, 6, 5, 10), mat(0x241c14));
        rib.rotation.x = Math.PI / 2;
        rib.position.y = 22 + i * 20;
        g.add(rib);
        skin.push(rib);
      }

      // The throat: a wide flare on the front, open toward the player. The
      // lining sits inside the flare and shares its tilt — a disc facing the
      // camera regardless of the cone it belongs to reads as a sticker.
      const THROAT_TILT = -1.15;
      const throat = new THREE.Mesh(new THREE.CylinderGeometry(34, 14, 56, 10, 1, true), mat(0x2c2118));
      throat.material.side = THREE.DoubleSide;
      throat.position.set(48, 148, 0);
      throat.rotation.z = THROAT_TILT;
      throat.castShadow = true;
      g.add(throat);
      skin.push(throat);

      const lining = new THREE.Mesh(new THREE.CircleGeometry(29, 14), mat(0x2a1109, { emissive: 0xa8431f, emissiveIntensity: 0.3 }));
      lining.position.set(62, 150, 0);
      lining.rotation.set(0, Math.PI / 2, -THROAT_TILT - Math.PI / 2);
      g.add(lining);
      glows.push(lining);
      // A lip around the flare so it has an edge to catch the sun.
      const lip = new THREE.Mesh(new THREE.TorusGeometry(33, 3.5, 5, 12), mat(0x1d1610));
      lip.position.set(60, 150, 0);
      lip.rotation.set(0, Math.PI / 2, -THROAT_TILT - Math.PI / 2);
      g.add(lip);
      skin.push(lip);

      // The crown sits on a neck rising out of the body, not in mid-air above it.
      const neck = taper(20, 34, 52, mat(0x241c14), 8);
      neck.position.y = 160;
      g.add(neck);
      skin.push(neck);
      const cap = new THREE.Mesh(new THREE.CircleGeometry(21, 12), mat(0x150f0a, { emissive: 0x7d9a3f, emissiveIntensity: 0.28 }));
      cap.rotation.x = -Math.PI / 2;
      cap.position.y = 186.5;
      g.add(cap);
      glows.push(cap);
      const crown = new THREE.Mesh(new THREE.TorusGeometry(21, 5, 6, 12), mat(0x1d1610));
      crown.rotation.x = Math.PI / 2;
      crown.position.y = 186;
      g.add(crown);
      skin.push(crown);

      const bulb = sphere(26, mat(0x1c1410, { emissive: 0x8fae4b, emissiveIntensity: 0.2 }), 10);
      bulb.position.set(-34, 28, 0);
      bulb.scale.set(1, 0.8, 1);
      g.add(bulb);
      glows.push(bulb);

      // Roots: it is gripping the floor, not standing on it. They double as
      // legs once it uproots, which is what phase two is.
      legs = insectLegs(g, 7, 52, 34, 9, 30, mat(0x1a130e));
      break;
    }

    case 'the-choir': {
      // A cargo gantry: a tall spine, a counterweight arm, and a sorting claw.
      // Industrial, not animal — nothing about it should look alive.
      const spine = taper(14, 22, 170, plate, 6);
      spine.position.y = 92;
      g.add(spine);
      skin.push(spine);

      const base = taper(30, 44, 22, mat(0x2a2119), 8);
      base.position.y = 11;
      g.add(base);
      skin.push(base);

      // Counterweight arm, offset so the silhouette is asymmetric and readable.
      const arm = box(112, 9, 12, mat(0x3d3226));
      arm.position.set(-14, 152, 0);
      g.add(arm);
      skin.push(arm);
      const weight = box(26, 30, 26, mat(0x241c15));
      weight.position.set(-48, 152, 0);
      g.add(weight);
      skin.push(weight);

      // The claw it sorts with.
      for (const side of [-1, 1]) {
        const finger = box(30, 5, 5, mat(0x2e2419));
        finger.position.set(36, 146, side * 9);
        finger.rotation.z = -0.35;
        g.add(finger);
        skin.push(finger);
      }

      const core = new THREE.Mesh(new THREE.TorusGeometry(20, 5, 8, 18), mat(0x101418, { emissive: 0x6fa9c9, emissiveIntensity: 0.35 }));
      core.rotation.y = Math.PI / 2;
      core.position.y = 94;
      g.add(core);
      glows.push(core);

      const lamp = sphere(9, mat(0x101418, { emissive: 0x6fa9c9, emissiveIntensity: 0.4 }), 10);
      lamp.position.set(-48, 152, 0);
      g.add(lamp);
      glows.push(lamp);
      break;
    }

    default: {
      const body = box(16, 24, 16, shell);
      body.position.y = 12;
      g.add(body);
      skin.push(body);
    }
  }

  g.userData = { parts: { legs, glows, skin }, defId, kind: defId, baseColor: 0x1a1410 };
  return g;
}

/* ------------------------------- animation -------------------------------- */

export interface ActorAnimState {
  gait: number;
  yaw: number;
  aimPitch?: number;
  grounded: boolean;
  flash: number;
  /** 0..1 — how lit the emissive parts should be. */
  glow: number;
  timeMs: number;
}

/**
 * Drives one actor from the snapshot.
 *
 * Legs are phased off `gait` rather than off wall-clock time, so a stationary
 * actor's legs are still and a fast one's are quick, with no extra state.
 */
export function animateActor(actor: Actor, s: ActorAnimState): void {
  const { parts } = actor.userData;
  actor.rotation.y = -s.yaw;

  const phase = s.gait * 0.16;
  const n = parts.legs.length;
  for (let i = 0; i < n; i++) {
    const l = parts.legs[i]!;
    // Alternate tripods for many-legged things; a simple opposition for two.
    const offset = n <= 2 ? i * Math.PI : (i % 2) * Math.PI + Math.floor(i / 2) * 0.5;
    const swing = Math.sin(phase + offset);
    l.rotation.x = swing * 0.5;
    const knee = l.userData.knee as THREE.Object3D | undefined;
    if (knee) knee.rotation.x = Math.max(0, -swing) * 0.7;
  }

  if (parts.body) {
    // A small vertical bob, and a lean into the direction of travel.
    parts.body.position.y = (parts.body.userData.baseY ??= parts.body.position.y) + Math.abs(Math.sin(phase)) * 0.9;
  }
  if (parts.weapon && s.aimPitch !== undefined) {
    parts.weapon.rotation.z = s.aimPitch;
  }

  const glowTarget = 0.25 + s.glow * 2.4 + Math.sin(s.timeMs * 0.004) * 0.06;
  for (const m of parts.glows) {
    const material = m.material as THREE.MeshLambertMaterial;
    material.emissiveIntensity += (glowTarget - material.emissiveIntensity) * 0.2;
  }

  // Hit flash: lift the whole skin toward bone for a couple of frames.
  const flash = Math.min(1, s.flash / 4);
  for (const m of parts.skin) {
    const material = m.material as THREE.MeshLambertMaterial;
    if (!material.userData.base) material.userData.base = material.color.getHex();
    material.color.setHex(material.userData.base as number);
    if (flash > 0) material.color.lerp(new THREE.Color(0xd8cbb2), flash * 0.85);
  }
}

export function disposeActor(actor: THREE.Object3D): void {
  actor.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mm of mats) mm.dispose();
  });
}
