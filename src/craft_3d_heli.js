// Renders the Rotorflight helicopter 3D model (a real GLTF asset, not a procedurally-built mesh
// like the multirotor Craft3D), driven by the log's directly-logged `attitude[0..2]` fields.
// Ported from https://github.com/rotorflight/rotorflight-blackbox (js/craft_3d.js).
//
// Uses the modern `three` npm package (ESM) rather than the vendored legacy three.min.js global,
// since that vendored build (r70) predates glTF 2.0 support and THREE.SRGBColorSpace.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildPiroTrace, mastLean, traceCountAt } from "./piro_wobble.js";

const MODEL_URL = "/resources/models/bell_cw.gltf";

// Extra yaw (in radians) added on top of the log's real-time yaw so the model's on-screen
// "zero yaw" pose matches the user's chosen initial facing direction.
const CRAFT_FACING_OFFSETS = {
  forward: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  backward: Math.PI,
};

// The neutral pose for each axis the model can show on its own.
const ISOLATED_FACING_OFFSETS = {
  roll: CRAFT_FACING_OFFSETS.forward,
  pitch: CRAFT_FACING_OFFSETS.right,
  yaw: CRAFT_FACING_OFFSETS.forward,
};

// Collective color: blue for negative (descending) pitch, green for positive (climb) pitch.
// Opacity carries the magnitude, so the disc is fully transparent at zero collective and
// becomes more visible the further the stick is pushed away from center in either direction.
// Colors are pulled from GraphConfig.PALETTE (graph_config.js) rather than pure RGB primaries,
// since that palette is already tuned for legibility against the app's black graph background.
const COLLECTIVE_COLOR_NEGATIVE = new THREE.Color(0x80b1d3); // palette "Blue"
const COLLECTIVE_COLOR_POSITIVE = new THREE.Color(0xb3de69); // palette "Green"
const COLLECTIVE_DISC_MAX_OPACITY = 0.75;

// The model already includes a "Cone"-named mesh at the rotor head: a wide, nearly-flat disc
// (rendered near-black at 10% opacity in the source asset) meant to represent the spinning
// main rotor's blur. Rather than place a new mesh and guess at the rotor head's position, we
// recolor that existing disc directly to indicate collective pitch.
const COLLECTIVE_DISC_NODE_NAME = "Cone";

// Cyclic (roll/pitch) gradient: on top of the uniform collective color/opacity, the disc is
// faded in per-vertex so the side of the disc the swashplate is tilting towards stays at full
// strength while the opposite side fades out, showing at a glance where the blade force is
// pointing. rcCommand[0]/[1] (roll/pitch) aren't range-scaled per-craft like collective is, so
// a fixed +-500 stick-deflection range (the standard Betaflight/Rotorflight raw scale) is used.
// The "Cone" node has no rotation of its own relative to the model root, so its local X/Z axes
// line up with model.rotation's: rotation.x is driven by pitch and rotation.z by roll, so local
// X is the lateral (roll) axis and local Z is the longitudinal (pitch) axis of the disc.
const CYCLIC_COMMAND_RANGE = 500;
const CYCLIC_GRADIENT_STRENGTH = 1.5;
const CYCLIC_GRADIENT_MIN_ALPHA = 0.1;
// Negated relative to the raw rcCommand sign: confirmed against a real log that a positive
// (forward/right) cyclic command highlights the near side of the disc rather than the far side
// without this flip.
const CYCLIC_ROLL_SIGN = 1;
const CYCLIC_PITCH_SIGN = -1;

// Piro wobble overlay (see piro_wobble.js), in model units: the rotor head ("Cone" node) sits at
// y = 27 and the model spans roughly +-80 across, with the camera 200 away.
const PIRO_ROTOR_HEAD_Y = 27;
const PIRO_MAST_LENGTH = 110;
const PIRO_MAST_RADIUS = 1.2;
const PIRO_MAST_COLOR = 0x5aa9ff;
// The lean plot under the mast: the lean seen from above (right = right, up = away from the
// viewer), magnified so the outer ring is PIRO_PLOT_MAX_DEGREES of lean.
const PIRO_PLOT_RADIUS = 38;
const PIRO_PLOT_MAX_DEGREES = 6;
const PIRO_PLOT_RING_DEGREES = [2, 4, 6];
const PIRO_PLOT_CLAMP = 1.2; // Leans beyond the outer ring are pinned just outside it.
const PIRO_TRAIL_COLOR = new THREE.Color(0x80b1d3);
const PIRO_DOT_COLOR = 0xffed6f;
const PIRO_TRAIL_FADE_US = 4e6; // The trail fades over this long, down to PIRO_TRAIL_MIN_ALPHA.
const PIRO_TRAIL_MIN_ALPHA = 0.25;
const PIRO_OPEN_SECTION_LOOKAHEAD_US = 5e6;
const PIRO_RENDER_ORDER = 1000;

function overlayMaterial(Material, params) {
  return new Material({ transparent: true, depthTest: false, depthWrite: false, ...params });
}

function makeLabel(text) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext("2d");
  ctx.font = "bold 22px sans-serif";
  ctx.fillStyle = "#cccccc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 16);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(overlayMaterial(THREE.SpriteMaterial, { map: texture }));
  sprite.scale.set(12, 6, 1);
  sprite.renderOrder = PIRO_RENDER_ORDER;
  return sprite;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Whether the given flight log has the attitude fields this model needs to be driven by.
 */
export function heliModelHasAttitude(flightLog) {
  return (
    typeof flightLog.getMainFieldIndexByName("attitude[0]") === "number" &&
    typeof flightLog.getMainFieldIndexByName("attitude[1]") === "number" &&
    typeof flightLog.getMainFieldIndexByName("attitude[2]") === "number"
  );
}

export function Craft3DHeli(flightLog, canvas, facing) {
  const facingOffset = CRAFT_FACING_OFFSETS[facing] || 0;
  const attitudeFrameIndex = {
    x: flightLog.getMainFieldIndexByName("attitude[1]"),
    y: flightLog.getMainFieldIndexByName("attitude[2]"),
    z: flightLog.getMainFieldIndexByName("attitude[0]"),
  };
  const collectiveFieldIndex = flightLog.getMainFieldIndexByName("rcCommand[3]");
  const [collectiveMin, collectiveMax] = flightLog.getSysConfig().collectiveRange ?? [-500, 500];
  const cyclicRollFieldIndex = flightLog.getMainFieldIndexByName("rcCommand[0]");
  const cyclicPitchFieldIndex = flightLog.getMainFieldIndexByName("rcCommand[1]");

  let model = null;
  let collectiveDisc = null;
  // Per-vertex RGBA attribute on the disc, used to fade opacity across it for the cyclic
  // gradient. discVertexXZ holds each vertex's (x, z) normalized to the disc's outer radius,
  // precomputed once so the per-frame update is just a couple of multiplies per vertex.
  let discColorAttr = null;
  let discVertexXZ = null;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    75,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    1000,
  );
  // Move the camera away from the model
  camera.position.z = 200;
  scene.add(camera);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.8);
  directionalLight.position.set(0, 600, 800);
  scene.add(directionalLight);

  // modelWrapper adds an extra axis of rotation to avoid gimbal lock with the euler angles
  const modelWrapper = new THREE.Object3D();
  scene.add(modelWrapper);

  const render = () => {
    renderer.render(scene, camera);
  };

  // --- Piro wobble overlay ---
  // The mast: from the rotor head straight down the model's own Y axis, so it leans with the heli.
  const piroMast = new THREE.Mesh(
    new THREE.CylinderGeometry(PIRO_MAST_RADIUS, PIRO_MAST_RADIUS, PIRO_MAST_LENGTH, 8),
    overlayMaterial(THREE.MeshBasicMaterial, { color: PIRO_MAST_COLOR, opacity: 0.95 }),
  );
  piroMast.position.y = PIRO_ROTOR_HEAD_Y - PIRO_MAST_LENGTH / 2;
  piroMast.renderOrder = PIRO_RENDER_ORDER + 1;
  piroMast.visible = false;

  // True vertical from the rotor head, to compare the mast against, and the lean plot at its foot.
  const piroWorld = new THREE.Group();
  piroWorld.visible = false;
  scene.add(piroWorld);
  const plotY = PIRO_ROTOR_HEAD_Y - PIRO_MAST_LENGTH;
  const unitsPerDegree = PIRO_PLOT_RADIUS / PIRO_PLOT_MAX_DEGREES;
  const greyLine = overlayMaterial(THREE.LineBasicMaterial, { color: 0xaaaaaa, opacity: 0.55 });

  piroWorld.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, PIRO_ROTOR_HEAD_Y, 0),
        new THREE.Vector3(0, plotY, 0),
      ]),
      greyLine,
    ),
  );
  const plot = new THREE.Group();
  plot.position.y = plotY;
  piroWorld.add(plot);
  const plotBackground = new THREE.Mesh(
    new THREE.CircleGeometry(PIRO_PLOT_RADIUS * 1.08, 48),
    overlayMaterial(THREE.MeshBasicMaterial, { color: 0x000000, opacity: 0.45 }),
  );
  plot.add(plotBackground);
  for (const degrees of PIRO_PLOT_RING_DEGREES) {
    const r = degrees * unitsPerDegree;
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 64 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
        }),
      ),
      greyLine,
    );
    plot.add(ring);
    const label = makeLabel(`${degrees}°`);
    label.position.set(r * Math.SQRT1_2 + 4, -r * Math.SQRT1_2 - 2, 0);
    plot.add(label);
  }
  plot.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-PIRO_PLOT_RADIUS, 0, 0),
        new THREE.Vector3(PIRO_PLOT_RADIUS, 0, 0),
        new THREE.Vector3(0, -PIRO_PLOT_RADIUS, 0),
        new THREE.Vector3(0, PIRO_PLOT_RADIUS, 0),
      ]),
      greyLine,
    ),
  );

  const trailGeometry = new THREE.BufferGeometry();
  const piroTrail = new THREE.Line(
    trailGeometry,
    overlayMaterial(THREE.LineBasicMaterial, { vertexColors: true }),
  );
  plot.add(piroTrail);
  const piroDot = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 20),
    overlayMaterial(THREE.MeshBasicMaterial, { color: PIRO_DOT_COLOR }),
  );
  plot.add(piroDot);
  plot.traverse((object) => {
    object.renderOrder = PIRO_RENDER_ORDER;
  });
  piroDot.renderOrder = PIRO_RENDER_ORDER + 2;

  const plotPoint = (x, y) => {
    const r = Math.hypot(x, y) * unitsPerDegree;
    const limit = PIRO_PLOT_RADIUS * PIRO_PLOT_CLAMP;
    const scale = r > limit ? limit / r : 1;
    return [x * unitsPerDegree * scale, y * unitsPerDegree * scale];
  };

  // The lean through the section, rebuilt when the section changes - or, while it's still open,
  // when playback runs past what's been built.
  let piroTrace = null;
  let piroTraceKey = null;
  let piroTraceEnd = 0;

  const updatePiroTrail = (piro, yawOffset) => {
    const open = piro.end == null;
    const key = `${piro.start}|${piro.end}|${yawOffset}`;
    if (key !== piroTraceKey || (open && piro.time > piroTraceEnd)) {
      piroTraceEnd = open ? piro.time + PIRO_OPEN_SECTION_LOOKAHEAD_US : piro.end;
      piroTrace = buildPiroTrace(flightLog, piro.start, piroTraceEnd, yawOffset);
      piroTraceKey = key;
      const n = piroTrace.times.length;
      const positions = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const [px, py] = plotPoint(piroTrace.x[i], piroTrace.y[i]);
        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
      }
      trailGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      trailGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    }

    const count = traceCountAt(piroTrace.times, piro.time);
    const colors = trailGeometry.getAttribute("color");
    if (colors) {
      for (let i = 0; i < count; i++) {
        const age = piro.time - piroTrace.times[i];
        const alpha = Math.max(PIRO_TRAIL_MIN_ALPHA, 1 - age / PIRO_TRAIL_FADE_US);
        colors.array[i * 4] = PIRO_TRAIL_COLOR.r;
        colors.array[i * 4 + 1] = PIRO_TRAIL_COLOR.g;
        colors.array[i * 4 + 2] = PIRO_TRAIL_COLOR.b;
        colors.array[i * 4 + 3] = alpha;
      }
      colors.needsUpdate = true;
    }
    trailGeometry.setDrawRange(0, count);
  };

  // roll/pitch/yaw are the model's rotations as shown (yaw including yawOffset, the facing).
  const updatePiro = (piro, roll, pitch, yaw, yawOffset) => {
    const show = !!piro;
    piroMast.visible = show;
    piroWorld.visible = show;
    if (!show) return;
    updatePiroTrail(piro, yawOffset);
    const lean = mastLean(roll, pitch, yaw);
    const [px, py] = plotPoint(lean.x, lean.y);
    piroDot.position.set(px, py, 0);
  };

  const loader = new GLTFLoader();
  loader.load(MODEL_URL, (gltf) => {
    model = gltf.scene;
    modelWrapper.add(model);
    model.add(piroMast);

    const hasCyclic =
      typeof cyclicRollFieldIndex === "number" || typeof cyclicPitchFieldIndex === "number";

    if (typeof collectiveFieldIndex === "number" || hasCyclic) {
      collectiveDisc = model.getObjectByName(COLLECTIVE_DISC_NODE_NAME) || null;
    }

    if (collectiveDisc && hasCyclic) {
      const geometry = collectiveDisc.geometry;
      const position = geometry.attributes.position;
      const vertexCount = position.count;

      let outerRadius = 0;
      discVertexXZ = new Float32Array(vertexCount * 2);
      for (let i = 0; i < vertexCount; i++) {
        const x = position.getX(i);
        const z = position.getZ(i);
        outerRadius = Math.max(outerRadius, Math.hypot(x, z));
      }
      outerRadius = outerRadius || 1;
      for (let i = 0; i < vertexCount; i++) {
        discVertexXZ[i * 2] = position.getX(i) / outerRadius;
        discVertexXZ[i * 2 + 1] = position.getZ(i) / outerRadius;
      }

      const colors = new Float32Array(vertexCount * 4).fill(1);
      discColorAttr = new THREE.BufferAttribute(colors, 4);
      geometry.setAttribute("color", discColorAttr);
      collectiveDisc.material.vertexColors = true;
      collectiveDisc.material.needsUpdate = true;
    }

    modelWrapper.rotation.y = facingOffset;
    render();
  });

  const rotateTo = (x, y, z, collectiveRaw, cyclicRollRaw, cyclicPitchRaw, yawOffset = facingOffset, piro = null) => {
    if (!model) return;

    model.rotation.x = x;
    modelWrapper.rotation.y = y + yawOffset;
    model.rotation.z = z;
    updatePiro(piro, z, x, y + yawOffset, yawOffset);
    
    if (collectiveDisc && typeof collectiveRaw === "number") {
      const isNegative = collectiveRaw < 0;
      const magnitude = Math.min(
        Math.abs(collectiveRaw) / (Math.abs(isNegative ? collectiveMin : collectiveMax) || 1),
        1,
      );

      collectiveDisc.material.color.copy(
        isNegative ? COLLECTIVE_COLOR_NEGATIVE : COLLECTIVE_COLOR_POSITIVE,
      );
      collectiveDisc.material.opacity = magnitude * COLLECTIVE_DISC_MAX_OPACITY;
    }

    if (discColorAttr && discVertexXZ) {
      const dx = CYCLIC_ROLL_SIGN * clamp((cyclicRollRaw || 0) / CYCLIC_COMMAND_RANGE, -1, 1);
      const dz = CYCLIC_PITCH_SIGN * clamp((cyclicPitchRaw || 0) / CYCLIC_COMMAND_RANGE, -1, 1);
      const colors = discColorAttr.array;
      const vertexCount = colors.length / 4;

      for (let i = 0; i < vertexCount; i++) {
        const alignment = discVertexXZ[i * 2] * dx + discVertexXZ[i * 2 + 1] * dz;
        colors[i * 4 + 3] = clamp(
          1 + CYCLIC_GRADIENT_STRENGTH * alignment,
          CYCLIC_GRADIENT_MIN_ALPHA,
          1,
        );
      }
      discColorAttr.needsUpdate = true;
    }

    render();
  };

  // Matches the Craft3D (multirotor) call signature so grapher.js doesn't need to special-case
  // this renderer at the call site. isolated: { axis, degrees } to show just one axis's turn since
  // it was picked (see craft_axis_motion.js) on a craft that starts level - side on for pitch, so the
  // nose visibly rises and falls, otherwise with its tail towards the viewer - whatever the facing
  // setting, or null to show the logged attitude. piro: { start, end, time } while playback is in a
  // piro section (see piro_wobble.js) to show the mast's lean, or null.
  this.render = function (frame, frameFieldIndexes, isolated = null, piro = null) {
    let x, y, z;
    if (isolated) {
      // Signs match the logged attitude's: it follows +gyro on roll and pitch, -gyro on yaw.
      const radians = (isolated.degrees * Math.PI) / 180;
      x = isolated.axis === "pitch" ? -radians : 0;
      y = isolated.axis === "yaw" ? radians : 0;
      z = isolated.axis === "roll" ? -radians : 0;
    } else {
      x = (-frame[attitudeFrameIndex.x] / 1800) * Math.PI;
      y = (-frame[attitudeFrameIndex.y] / 1800) * Math.PI;
      z = (-frame[attitudeFrameIndex.z] / 1800) * Math.PI;
    }

    rotateTo(
      x,
      y,
      z,
      typeof collectiveFieldIndex === "number" ? frame[collectiveFieldIndex] : undefined,
      typeof cyclicRollFieldIndex === "number" ? frame[cyclicRollFieldIndex] : undefined,
      typeof cyclicPitchFieldIndex === "number" ? frame[cyclicPitchFieldIndex] : undefined,
      isolated ? ISOLATED_FACING_OFFSETS[isolated.axis] : facingOffset,
      isolated ? null : piro,
    );
  };

  this.resize = function (width, height) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    }
  };
}
