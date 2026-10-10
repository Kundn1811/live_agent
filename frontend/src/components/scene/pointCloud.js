import * as THREE from 'three';

// Ported from the portfolio's scene/pointCloud.ts (sphere formation only). The
// look is a night-time drone show: thousands of units each carrying one small
// light, near-white through the theme accent. Keep `lights` narrow and weighted
// toward white.

const LIGHT = (() => {
  const v = [-0.35, 0.55, 0.75];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

const HALF = (() => {
  const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

const AMBIENT = 0.16;

/** One light colour per drone, fixed for the lifetime of the swarm. */
export function droneColors(count, palette) {
  const lights = palette.lights;
  const base = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const light = lights[(Math.random() * lights.length) | 0];
    const dim = 0.72 + Math.random() * 0.28;
    base[i * 3] = light[0] * dim;
    base[i * 3 + 1] = light[1] * dim;
    base[i * 3 + 2] = light[2] * dim;
  }
  return base;
}

/** Soft radial sprite: bright core plus a halo, so a point reads as a lamp. */
export function makeDotTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.22)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function shadeDrone(out, o, base, palette, nx, ny, nz) {
  const { shadow, rim: rimTint } = palette;
  const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const lit = AMBIENT + (1 - AMBIENT) * diffuse;
  const rim = Math.pow(1 - Math.abs(nz), 3) * 0.45;
  const spec = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 26) * 0.55;
  for (let c = 0; c < 3; c++) {
    const tinted = shadow[c] + (base[o + c] - shadow[c]) * lit;
    out[o + c] = tinted + rimTint[c] * rim + spec;
  }
}

/**
 * Evenly distributed sphere (Fibonacci lattice). Also returns what the orb needs
 * to animate each drone: its unit direction, which of `bandCount` frequency bands
 * it belongs to (latitude → pole-to-pole spectrum), and a random phase for shimmer.
 */
export function sphereCloud(count, radius, base, palette, bandCount) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const dirs = new Float32Array(count * 3);
  const band = new Uint8Array(count);
  const phase = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const nx = Math.cos(theta) * ring;
    const nz = Math.sin(theta) * ring;

    dirs[i * 3] = nx;
    dirs[i * 3 + 1] = y;
    dirs[i * 3 + 2] = nz;
    positions[i * 3] = nx * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = nz * radius;
    // Mirror the bands about the equator so bass sits at the poles, treble at the belt.
    band[i] = Math.min(bandCount - 1, Math.floor(Math.abs(y) * bandCount));
    phase[i] = Math.random() * Math.PI * 2;

    shadeDrone(colors, i * 3, base, palette, nx, y, nz);
  }
  return { positions, colors, dirs, band, phase };
}
