import React, { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { analysers, readBands, BAND_COUNT } from '../../audioLevels.js';
import { DEFAULT_SCENE } from './palette.js';
import { droneColors, makeDotTexture, sphereCloud } from './pointCloud.js';
import { ParticlePool, createParticleSystem } from './particles.js';

/**
 * Sparrow's body: a drone-swarm sphere (same look as the portfolio hero) that reacts to voice.
 *
 *  - idle       slow spin, faint breathing
 *  - listening  "atom" — electrons orbit the core on tilted rings, speed and radius follow the
 *               mic spectrum, and sound motes spiral in toward the core
 *  - speaking   the core pumps (each latitude band of the swarm follows one frequency band of
 *               Sparrow's voice) and it throws particles out into the room; every transcript
 *               chunk (≈ a word) adds an extra kick
 */

const POINT_COUNT = 12000;
const CORE_RADIUS = 1.45;
const CAMERA_Z = 7.5;

// Tilted electron rings. `w` = angular speed (rad/s), sign = direction.
const RINGS = [
  { rx: 1.15, rz: 0.2, w: 1.0, r: 2.15 },
  { rx: -0.5, rz: 1.0, w: -0.8, r: 2.4 },
  { rx: 0.2, rz: -0.9, w: 1.3, r: 2.65 },
];
const ELECTRONS = 2;
const TAIL = 48;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const rand = (a, b) => a + Math.random() * (b - a);

function randomDir(flattenZ) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  const d = [Math.cos(a) * s, Math.sin(a) * s, z * flattenZ];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / len, d[1] / len, d[2] / len];
}

function Scene({ palette, live, pulseRef }) {
  const drones = palette.drones;

  const base = useMemo(() => droneColors(POINT_COUNT, drones), [drones]);
  const cloud = useMemo(
    () => sphereCloud(POINT_COUNT, CORE_RADIUS, base, drones, BAND_COUNT),
    [base, drones],
  );
  const dotTexture = useMemo(() => makeDotTexture(), []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(Float32Array.from(cloud.positions), 3);
    const color = new THREE.BufferAttribute(Float32Array.from(cloud.colors), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', position);
    g.setAttribute('color', color);
    return g;
  }, [cloud]);

  const pools = useMemo(() => {
    const out = new ParticlePool(1800, 'out', CORE_RADIUS);
    out.zMax = CAMERA_Z - 2.2;
    return { out, inn: new ParticlePool(900, 'in', CORE_RADIUS) };
  }, []);

  // Electrons: ELECTRONS comet heads per ring, each trailing TAIL particles.
  const orbit = useMemo(() => createParticleSystem(RINGS.length * ELECTRONS * TAIL), []);
  const ringMatrices = useMemo(
    () => RINGS.map((r) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r.rx, 0, r.rz))),
    [],
  );
  const ringGuides = useMemo(() => {
    const group = new THREE.Group();
    const pts = [];
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    RINGS.forEach((r, k) => {
      const mat = new THREE.LineBasicMaterial({ color: palette.lines, transparent: true, opacity: 0 });
      const loop = new THREE.LineLoop(geo, mat);
      loop.applyMatrix4(ringMatrices[k]);
      loop.scale.setScalar(r.r);
      group.add(loop);
    });
    return group;
  }, [palette.lines, ringMatrices]);

  const stars = useMemo(() => {
    const arr = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i++) {
      const radius = 9 + Math.random() * 14;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = radius * Math.cos(phi) - 6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, []);

  const electronColors = useMemo(
    () => [palette.nodeA, palette.nodeB, palette.lines].map((c) => new THREE.Color(c)),
    [palette],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      dotTexture.dispose();
      stars.dispose();
      pools.out.sys.dispose();
      pools.inn.sys.dispose();
      orbit.dispose();
      ringGuides.children.forEach((l) => l.material.dispose());
      ringGuides.children[0]?.geometry.dispose();
    },
    [geometry, dotTexture, stars, pools, orbit, ringGuides],
  );

  const groupRef = useRef();
  const pointsRef = useRef();
  const shellRef = useRef();
  const orbitGroupRef = useRef();

  const audio = useRef({
    inRaw: new Float32Array(BAND_COUNT),
    outRaw: new Float32Array(BAND_COUNT),
    inS: new Float32Array(BAND_COUNT),
    outS: new Float32Array(BAND_COUNT),
  });
  const anim = useRef({
    speak: 0,
    listen: 0,
    kick: 0,
    lastPulse: 0,
    accOut: 0,
    accIn: 0,
    heads: RINGS.map(() => 0),
    spinX: 0,
    spinY: 0,
    hover: 0,
    cursor: false,
  });
  // Pointer is over the core (tracked by r3f events on the invisible hit sphere).
  const hovering = useRef(false);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const L = live.current;
    const a = audio.current;
    const s = anim.current;

    // ---- audio → smoothed band energy (fast attack, slower release) ----
    readBands(analysers.input, a.inRaw);
    readBands(analysers.output, a.outRaw);
    let levelIn = 0;
    let levelOut = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      a.inS[b] += (a.inRaw[b] - a.inS[b]) * (a.inRaw[b] > a.inS[b] ? 0.5 : 0.12);
      a.outS[b] += (a.outRaw[b] - a.outS[b]) * (a.outRaw[b] > a.outS[b] ? 0.55 : 0.14);
      levelIn += a.inS[b];
      levelOut += a.outS[b];
    }
    levelIn = L.muted ? 0 : levelIn / BAND_COUNT;
    levelOut /= BAND_COUNT;

    // Hover affordance: only while a tap would start a session.
    const wantHover = hovering.current && L.interactive;
    s.hover += ((wantHover ? 1 : 0) - s.hover) * (1 - Math.exp(-dt * 8));
    if (wantHover !== s.cursor) {
      s.cursor = wantHover;
      document.body.style.cursor = wantHover ? 'pointer' : '';
    }

    // ---- mode mixes ----
    s.speak += ((L.modelSpeaking ? 1 : 0) - s.speak) * (1 - Math.exp(-dt * 6));
    const mic = L.sessionActive && !L.muted ? Math.max(L.userSpeaking ? 0.85 : 0, clamp01(levelIn * 5)) : 0;
    const watching = L.sessionActive ? 0.22 : 0.06;
    const listenTarget = Math.max(watching, mic) * (1 - 0.65 * s.speak);
    s.listen += (listenTarget - s.listen) * (1 - Math.exp(-dt * 7));

    // Each transcript chunk (~a word) kicks the core and fires a burst.
    let burst = 0;
    if (pulseRef.current !== s.lastPulse) {
      s.lastPulse = pulseRef.current;
      s.kick = 1;
      burst = 22;
    }
    s.kick *= Math.exp(-dt * 5);

    // ---- core: pump per frequency band ----
    const pos = geometry.attributes.position.array;
    const { dirs, band, phase } = cloud;
    // Offline, the core breathes a little deeper and swells on hover: "tap me".
    const breathe = (0.012 + (L.interactive ? 0.018 : 0)) * Math.sin(t * 1.1);
    const common = 1 + breathe + s.kick * 0.07 - s.listen * 0.03 + s.hover * 0.045;
    for (let i = 0; i < POINT_COUNT; i++) {
      const b = band[i];
      const w = 0.8 + 0.2 * Math.sin(t * 7 + phase[i]);
      const r =
        CORE_RADIUS * (common + a.outS[b] * s.speak * 0.34 * w + a.inS[b] * s.listen * 0.07 * w);
      const i3 = i * 3;
      pos[i3] = dirs[i3] * r;
      pos[i3 + 1] = dirs[i3 + 1] * r;
      pos[i3 + 2] = dirs[i3 + 2] * r;
    }
    geometry.attributes.position.needsUpdate = true;

    s.spinY += dt * (0.18 + s.speak * 0.12);
    s.spinX += dt * 0.05;
    if (pointsRef.current) {
      pointsRef.current.rotation.set(s.spinX, s.spinY, 0);
      pointsRef.current.material.size =
        0.05 * (1 + levelOut * s.speak * 0.5 + s.kick * 0.3 + s.hover * 0.25);
    }
    if (shellRef.current) {
      shellRef.current.scale.setScalar(1.02 * (1 + levelOut * s.speak * 0.12 + s.kick * 0.05));
      shellRef.current.rotation.y = -s.spinY * 0.6;
    }
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(t * 0.9) * 0.08;
      groupRef.current.rotation.y += (state.pointer.x * 0.35 - groupRef.current.rotation.y) * 0.04;
      groupRef.current.rotation.x += (-state.pointer.y * 0.2 - groupRef.current.rotation.x) * 0.04;
    }

    // ---- shared point-size scale (world size → pixels) ----
    const scale =
      (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan((state.camera.fov * Math.PI) / 360));
    pools.out.sys.setScale(scale);
    pools.inn.sys.setScale(scale);
    orbit.setScale(scale);

    // ---- speaking: throw particles into the room ----
    const lights = drones.lights;
    const pick = () => lights[(Math.random() * lights.length) | 0];
    if (s.speak > 0.05 || burst) {
      s.accOut += (30 + 520 * levelOut) * s.speak * dt + burst;
      while (s.accOut >= 1) {
        s.accOut -= 1;
        const d = randomDir(0.55);
        const speed = (1.0 + 3.2 * levelOut + 1.2 * s.kick) * rand(0.6, 1.4);
        const swirl = rand(-0.4, 0.4);
        const c = pick();
        pools.out.spawn(
          d[0] * CORE_RADIUS * 1.08,
          d[1] * CORE_RADIUS * 1.08,
          d[2] * CORE_RADIUS * 1.08,
          d[0] * speed - d[1] * swirl,
          d[1] * speed + d[0] * swirl,
          d[2] * speed,
          rand(1.8, 3.6),
          rand(0.04, 0.1) + levelOut * 0.05,
          c[0],
          c[1],
          c[2],
        );
      }
    }
    pools.out.update(dt, 1);

    // ---- listening: sound motes spiral in toward the core ----
    if (mic > 0.1) {
      s.accIn += (14 + 260 * levelIn) * mic * dt;
      while (s.accIn >= 1) {
        s.accIn -= 1;
        const d = randomDir(0.6);
        const r0 = rand(3.2, 5.4);
        const life = rand(1.1, 2.0);
        const v = (r0 - CORE_RADIUS * 0.9) / life;
        const c = pick();
        pools.inn.spawn(
          d[0] * r0,
          d[1] * r0,
          d[2] * r0,
          -d[0] * v,
          -d[1] * v,
          -d[2] * v,
          life,
          rand(0.035, 0.085),
          c[0],
          c[1],
          c[2],
        );
      }
    }
    pools.inn.update(dt, 1);

    // ---- listening: atom rings ----
    const vis = 0.12 + 0.88 * clamp01(s.listen / 0.85);
    const speedUp = 0.6 + levelIn * 3.5 + (L.userSpeaking ? 0.5 : 0);
    let n = 0;
    for (let k = 0; k < RINGS.length; k++) {
      const ring = RINGS[k];
      s.heads[k] += dt * ring.w * speedUp;
      const col = electronColors[k];
      const guide = ringGuides.children[k];
      guide.material.opacity = 0.06 + 0.22 * vis;
      guide.scale.setScalar(ring.r * (1 + levelIn * 0.06));
      for (let e = 0; e < ELECTRONS; e++) {
        const head = s.heads[k] + e * Math.PI;
        const dir = Math.sign(ring.w);
        for (let j = 0; j < TAIL; j++) {
          const theta = head - dir * j * 0.055;
          const rr = ring.r + a.inS[(j >> 2) % BAND_COUNT] * 0.35 * vis;
          tmp.set(Math.cos(theta) * rr, 0, Math.sin(theta) * rr).applyMatrix4(ringMatrices[k]);
          const o3 = n * 3;
          orbit.pos[o3] = tmp.x;
          orbit.pos[o3 + 1] = tmp.y;
          orbit.pos[o3 + 2] = tmp.z;
          orbit.col[o3] = col.r;
          orbit.col[o3 + 1] = col.g;
          orbit.col[o3 + 2] = col.b;
          const f = 1 - j / TAIL;
          orbit.size[n] = (j === 0 ? 0.12 : 0.055 * f) * (0.8 + vis * 0.8);
          orbit.alpha[n] = f * (0.15 + 0.85 * vis);
          n++;
        }
      }
    }
    orbit.dirty();
    if (orbitGroupRef.current) orbitGroupRef.current.position.y = groupRef.current?.position.y ?? 0;
  });

  return (
    <>
      <points geometry={stars}>
        <pointsMaterial size={0.02} color={palette.stars} transparent opacity={0.5} sizeAttenuation />
      </points>

      <group ref={groupRef}>
        {/* Invisible hit sphere: the swarm is just points, which can't be picked. */}
        <mesh
          onClick={(e) => {
            if (!live.current.interactive) return;
            e.stopPropagation();
            live.current.onCoreTap?.();
          }}
          onPointerOver={() => {
            hovering.current = true;
          }}
          onPointerOut={() => {
            hovering.current = false;
          }}
        >
          <sphereGeometry args={[1.8, 16, 16]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        <points ref={pointsRef} geometry={geometry}>
          <pointsMaterial
            size={0.05}
            map={dotTexture}
            vertexColors
            transparent
            alphaTest={0.02}
            depthWrite={false}
            sizeAttenuation
          />
        </points>
        <mesh ref={shellRef}>
          <icosahedronGeometry args={[1.02, 2]} />
          <meshBasicMaterial color={palette.shell} wireframe transparent opacity={0.16} />
        </mesh>
      </group>

      <group ref={orbitGroupRef}>
        <primitive object={ringGuides} />
        <primitive object={orbit.points} />
      </group>

      <primitive object={pools.inn.sys.points} />
      <primitive object={pools.out.sys.points} />
    </>
  );
}

/**
 * @param {object} props
 * @param {object} [props.palette]   Same shape as the portfolio's `Theme['scene']`.
 * @param {boolean} props.sessionActive
 * @param {boolean} props.userSpeaking
 * @param {boolean} props.modelSpeaking
 * @param {boolean} props.muted
 * @param {{current:number}} props.pulseRef  Bump `.current` once per transcript chunk to kick the core.
 * @param {boolean} [props.interactive]  When true, hovering the core invites a tap and tapping calls `onCoreTap`.
 * @param {() => void} [props.onCoreTap]
 */
export default function VoiceOrb({
  palette = DEFAULT_SCENE,
  sessionActive,
  userSpeaking,
  modelSpeaking,
  muted,
  pulseRef,
  interactive = false,
  onCoreTap,
}) {
  // The scene reads this every frame; keeping it in a ref avoids re-rendering the canvas.
  const live = useRef({});
  live.current = { sessionActive, userSpeaking, modelSpeaking, muted, interactive, onCoreTap };

  return (
    <Canvas
      camera={{ position: [0, 0, CAMERA_Z], fov: 45 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true }}
    >
      <Scene palette={palette} live={live} pulseRef={pulseRef} />
    </Canvas>
  );
}
