/* Strand landing — hero scene. A braid of git strands: a main line in the
 * accent hue with agent branches forking off, carrying commits, and merging
 * back. Pulses travel each branch (the agent writing) and light commits as
 * they pass; reaching the merge flashes the merge node on main.
 *
 * Loaded lazily by script.js after `load` on wide viewports only. Renders a
 * single frame under prefers-reduced-motion, pauses off-screen and on hidden
 * tabs, and follows the page's --accent-h so the accent dots retint main. */
import * as THREE from './vendor/three.module.min.js';

const BRANCH_HUES = [220, 150, 320, 95, 270, 190];
const NODE_SIZE = 0.15;
const MERGE_SIZE = 0.26;
const PULSE_SIZE = 0.3;

/* OKLCH → linear sRGB (the same math the CSS tokens rely on). Returns a
 * THREE.Color; the renderer converts to display sRGB on output. */
function oklch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return new THREE.Color().setRGB(
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    THREE.LinearSRGBColorSpace,
  );
}

function accentHue() {
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--accent-h'));
  return Number.isFinite(h) ? h : 55;
}

/* Deterministic layout — the braid should look the same on every visit. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function glowTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function trunkPoint(x) {
  return new THREE.Vector3(x, 0.18 * Math.sin(x * 0.45), 0.12 * Math.cos(x * 0.3));
}

function buildStrands() {
  const rand = rng(0x5747);
  const strands = [];

  const trunkPts = [];
  for (let x = -9; x <= 9.001; x += 0.75) trunkPts.push(trunkPoint(x));
  strands.push({
    curve: new THREE.CatmullRomCurve3(trunkPts, false, 'centripetal', 0.5),
    hue: null, // accent
    trunk: true,
    commitCount: 13,
    period: 16,
    phase: rand(),
    opacity: 0.62,
    radius: 0.02,
  });

  const forks = [-5.4, -4.2, -3.1, -1.9, -0.8, 0.4, 1.5, 2.7, 3.9, 5.0];
  forks.forEach((xa, i) => {
    const span = 2.6 + rand() * 2.6;
    const xb = Math.min(xa + span, 8.6);
    const angle = i * 2.399 + (rand() - 0.5) * 0.5; // golden angle wraps the braid around main
    const r = 0.32 + rand() * 0.5;
    const dy = Math.sin(angle) * r;
    const dz = Math.cos(angle) * r;
    const pts = [];
    const steps = 14;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = xa + (xb - xa) * t;
      const env = Math.sin(Math.PI * t) ** 0.85;
      const p = trunkPoint(x);
      p.y += dy * env;
      p.z += dz * env;
      pts.push(p);
    }
    strands.push({
      curve: new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5),
      hue: BRANCH_HUES[i % BRANCH_HUES.length],
      trunk: false,
      commitCount: 2 + Math.floor(rand() * 3),
      period: 7 + rand() * 6,
      phase: rand(),
      opacity: 0.5,
      radius: 0.013,
    });
  });
  return strands;
}

export function mount(canvas) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x000000, 4.5, 13.5);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
  camera.position.set(0.4, 0.55, 7.6);
  camera.lookAt(0.9, -0.15, 0);

  const group = new THREE.Group();
  group.rotation.set(0.08, -0.34, -0.1);
  group.position.y = -0.7; // keep the bundle clear of the headline, in the empty lower right
  scene.add(group);

  const strands = buildStrands();
  const glow = glowTexture();

  /* Tubes */
  for (const s of strands) {
    const geo = new THREE.TubeGeometry(s.curve, s.trunk ? 160 : 90, s.radius, 6, false);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: s.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    s.material = mat;
    group.add(new THREE.Mesh(geo, mat));
  }

  /* Commit nodes: one Points cloud, colors rewritten per frame. */
  const nodes = [];
  for (const s of strands) {
    const n = s.commitCount;
    for (let k = 1; k <= n; k++) {
      const u = s.trunk ? (k - 0.5) / n : k / (n + 1);
      nodes.push({ strand: s, u, merge: false, lit: 0 });
    }
    if (!s.trunk) nodes.push({ strand: s, u: 1, merge: true, lit: 0 });
  }
  const nodePos = new Float32Array(nodes.length * 3);
  const nodeCol = new Float32Array(nodes.length * 3);
  const nodeSize = new Float32Array(nodes.length);
  nodes.forEach((node, i) => {
    const p = node.strand.curve.getPointAt(node.u);
    nodePos.set([p.x, p.y, p.z], i * 3);
    nodeSize[i] = node.merge ? MERGE_SIZE : NODE_SIZE;
  });
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(nodeCol, 3));
  nodeGeo.setAttribute('size', new THREE.BufferAttribute(nodeSize, 1));
  const nodeMat = pointMaterial(glow);
  group.add(new THREE.Points(nodeGeo, nodeMat));

  /* Pulses: one per strand. */
  const pulsePos = new Float32Array(strands.length * 3);
  const pulseCol = new Float32Array(strands.length * 3);
  const pulseSize = new Float32Array(strands.length).fill(PULSE_SIZE);
  const pulseGeo = new THREE.BufferGeometry();
  pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
  pulseGeo.setAttribute('color', new THREE.BufferAttribute(pulseCol, 3));
  pulseGeo.setAttribute('size', new THREE.BufferAttribute(pulseSize, 1));
  const pulseMat = pointMaterial(glow);
  group.add(new THREE.Points(pulseGeo, pulseMat));

  /* Colors — main follows the page accent. */
  const white = new THREE.Color(1, 1, 1);
  let accent;
  function applyColors() {
    accent = oklch(0.74, 0.165, accentHue());
    for (const s of strands) {
      s.color = s.trunk ? accent : oklch(0.68, 0.11, s.hue);
      s.material.color.copy(s.color);
    }
    strands.forEach((s, i) => {
      const c = s.color.clone().lerp(white, 0.55);
      pulseCol.set([c.r, c.g, c.b], i * 3);
    });
    pulseGeo.attributes.color.needsUpdate = true;
  }
  applyColors();
  const accentWatch = new MutationObserver(() => {
    applyColors();
    if (reduceMotion) frame(0);
  });
  accentWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  /* Parallax */
  const pointer = { x: 0, y: 0 };
  const eased = { x: 0, y: 0 };
  if (!reduceMotion) {
    addEventListener('pointermove', (e) => {
      pointer.x = e.clientX / innerWidth - 0.5;
      pointer.y = e.clientY / innerHeight - 0.5;
    }, { passive: true });
  }

  const tmp = new THREE.Color();
  const p = new THREE.Vector3();
  let elapsed = 0;

  /* Sizing (calls frame() under reduced motion, so per-frame scratch state
   * must already exist) */
  const host = canvas.parentElement;
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // world-unit point sizes → pixels: drawing-buffer height over the fov tangent
    const scale = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    nodeMat.uniforms.scale.value = scale;
    pulseMat.uniforms.scale.value = scale;
    if (reduceMotion) frame(0);
  }
  new ResizeObserver(resize).observe(host);
  resize();

  function frame(dt) {
    elapsed += dt;

    for (const node of nodes) node.lit = Math.max(0, node.lit - dt * 0.9);

    strands.forEach((s, i) => {
      const cycle = ((elapsed / s.period) + s.phase) % 1;
      const travel = s.trunk ? 1 : 0.78; // branches rest between runs
      const t = Math.min(cycle / travel, 1);
      const visible = cycle < travel;
      const prev = s.prevT ?? t;
      s.prevT = t;
      s.curve.getPointAt(t, p);
      if (visible) {
        pulsePos.set([p.x, p.y, p.z], i * 3);
        pulseSize[i] = PULSE_SIZE * (0.85 + 0.15 * Math.sin(elapsed * 9 + i));
      } else {
        pulseSize[i] = 0;
      }
      if (t > prev) {
        for (const node of nodes) {
          if (node.strand === s && node.u > prev && node.u <= t) node.lit = 1;
        }
      }
    });
    pulseGeo.attributes.position.needsUpdate = true;
    pulseGeo.attributes.size.needsUpdate = true;

    nodes.forEach((node, i) => {
      const base = node.merge ? accent : node.strand.color;
      const rest = node.strand.trunk ? 0.48 : 0.34;
      tmp.copy(base).lerp(white, node.lit * 0.6).multiplyScalar(rest + node.lit * 1.3);
      nodeCol.set([tmp.r, tmp.g, tmp.b], i * 3);
      nodeSize[i] = (node.merge ? MERGE_SIZE : NODE_SIZE) * (1 + node.lit * 0.7);
    });
    nodeGeo.attributes.color.needsUpdate = true;
    nodeGeo.attributes.size.needsUpdate = true;

    eased.x += (pointer.x - eased.x) * Math.min(1, dt * 3);
    eased.y += (pointer.y - eased.y) * Math.min(1, dt * 3);
    group.rotation.y = -0.34 + eased.x * 0.09 + Math.sin(elapsed * 0.11) * 0.03;
    group.rotation.x = 0.08 + eased.y * 0.06 + Math.cos(elapsed * 0.09) * 0.02;

    renderer.render(scene, camera);
  }

  if (reduceMotion) {
    frame(0);
    return;
  }

  /* Only animate while the hero is on screen and the tab is visible. */
  let onScreen = true;
  let rafId = 0;
  let last = 0;
  function loop(now) {
    rafId = 0;
    if (!onScreen || document.hidden) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    frame(dt);
    rafId = requestAnimationFrame(loop);
  }
  function wake() {
    if (!rafId && onScreen && !document.hidden) {
      last = 0;
      rafId = requestAnimationFrame(loop);
    }
  }
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    wake();
  }).observe(host);
  document.addEventListener('visibilitychange', wake);
  wake();
}

/* Additive glow points with per-vertex size. */
function pointMaterial(map) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, scale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float size;
      varying vec3 vColor;
      varying float vFog;
      uniform float scale;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = -mv.z;
        vFog = clamp((13.5 - depth) / (13.5 - 4.5), 0.0, 1.0);
        gl_PointSize = size * scale / depth;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec3 vColor;
      varying float vFog;
      void main() {
        float a = texture2D(map, gl_PointCoord).a;
        gl_FragColor = vec4(vColor * a * vFog, a * vFog);
      }`,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
