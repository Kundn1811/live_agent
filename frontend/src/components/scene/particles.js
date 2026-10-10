import * as THREE from 'three';

// A point system with per-particle size and alpha. pointsMaterial can't fade
// individual points, and additive blending would vanish on a light theme, so this
// uses a tiny shader with normal blending instead.

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(aSize * uScale / -mv.z, 0.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = pow(1.0 - d, 2.0);
    float core = smoothstep(0.45, 0.0, d);
    gl_FragColor = vec4(vColor, (glow * 0.7 + core * 0.5) * vAlpha);
    #include <colorspace_fragment>
  }
`;

/** Fixed-size point system. Write into the returned typed arrays, then flag `dirty()`. */
export function createParticleSystem(count) {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  const color = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(count), 1);
  const alpha = new THREE.BufferAttribute(new Float32Array(count), 1);
  [position, color, size, alpha].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('position', position);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aSize', size);
  geometry.setAttribute('aAlpha', alpha);

  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 400 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false; // positions move every frame; the bounding sphere is stale

  return {
    points,
    count,
    pos: position.array,
    col: color.array,
    size: size.array,
    alpha: alpha.array,
    dirty() {
      position.needsUpdate = true;
      color.needsUpdate = true;
      size.needsUpdate = true;
      alpha.needsUpdate = true;
    },
    setScale(v) {
      material.uniforms.uScale.value = v;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Ring-buffer particle pool.
 *  - mode 'out': flies away from the core into the room (Sparrow "throwing" sound).
 *  - mode 'in':  spirals in toward the core (Sparrow "taking in" the user's voice).
 */
export class ParticlePool {
  constructor(count, mode, coreRadius) {
    this.sys = createParticleSystem(count);
    this.mode = mode;
    this.coreRadius = coreRadius;
    this.n = count;
    this.zMax = Infinity; // 'out' particles die past this depth so none fly through the camera
    this.cursor = 0;
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count); // seconds remaining; <= 0 means dead
    this.maxLife = new Float32Array(count).fill(1);
    this.size0 = new Float32Array(count);
    this.sys.alpha.fill(0);
    this.sys.size.fill(0);
  }

  spawn(px, py, pz, vx, vy, vz, life, size, r, g, b) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    const s = this.sys;
    s.pos[i * 3] = px;
    s.pos[i * 3 + 1] = py;
    s.pos[i * 3 + 2] = pz;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    s.col[i * 3] = r;
    s.col[i * 3 + 1] = g;
    s.col[i * 3 + 2] = b;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size;
  }

  update(dt, tint) {
    const s = this.sys;
    const out = this.mode === 'out';
    const spin = dt * 1.1;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        s.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      s.pos[i3] += this.vel[i3] * dt;
      s.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      s.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      const t = Math.min(1, 1 - this.life[i] / this.maxLife[i]);
      if (out) {
        if (s.pos[i3 + 2] > this.zMax) this.life[i] = 0;
        const drag = 1 - 0.12 * dt;
        this.vel[i3] *= drag;
        this.vel[i3 + 1] *= drag;
        this.vel[i3 + 2] *= drag;
        s.alpha[i] = smoothstep(0, 0.08, t) * Math.pow(1 - t, 1.3) * tint;
        s.size[i] = this.size0[i] * (1 - 0.5 * t);
      } else {
        // Swirl around the vertical axis while closing in, so the stream curves in.
        const x = s.pos[i3];
        const z = s.pos[i3 + 2];
        s.pos[i3] = x * cs - z * sn;
        s.pos[i3 + 2] = x * sn + z * cs;
        const r = Math.hypot(s.pos[i3], s.pos[i3 + 1], s.pos[i3 + 2]);
        if (r < this.coreRadius) this.life[i] = 0;
        s.alpha[i] = smoothstep(0, 0.2, t) * (1 - smoothstep(0.85, 1, t)) * tint;
        s.size[i] = this.size0[i] * (0.5 + 0.5 * t);
      }
    }
    s.dirty();
  }
}
