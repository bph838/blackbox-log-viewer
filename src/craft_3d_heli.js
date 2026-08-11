// Renders the Rotorflight helicopter 3D model (a real GLTF asset, not a procedurally-built mesh
// like the multirotor Craft3D), driven by the log's directly-logged `attitude[0..2]` fields.
// Ported from https://github.com/rotorflight/rotorflight-blackbox (js/craft_3d.js).
//
// Uses the modern `three` npm package (ESM) rather than the vendored legacy three.min.js global,
// since that vendored build (r70) predates glTF 2.0 support and THREE.SRGBColorSpace.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MODEL_URL = "/resources/models/bell_cw.gltf";

// Extra yaw (in radians) added on top of the log's real-time yaw so the model's on-screen
// "zero yaw" pose matches the user's chosen initial facing direction.
const CRAFT_FACING_OFFSETS = {
  forward: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  backward: Math.PI,
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

  let model = null;
  let collectiveDisc = null;

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

  const loader = new GLTFLoader();
  loader.load(MODEL_URL, (gltf) => {
    model = gltf.scene;
    modelWrapper.add(model);

    if (typeof collectiveFieldIndex === "number") {
      collectiveDisc = model.getObjectByName(COLLECTIVE_DISC_NODE_NAME) || null;
    }

    modelWrapper.rotation.y = facingOffset;
    render();
  });

  const rotateTo = (x, y, z, collectiveRaw) => {
    if (!model) return;

    model.rotation.x = x;
    modelWrapper.rotation.y = y + facingOffset;
    model.rotation.z = z;

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

    render();
  };

  // Matches the Craft3D (multirotor) call signature so grapher.js doesn't need to special-case
  // this renderer at the call site.
  this.render = function (frame) {
    rotateTo(
      (-frame[attitudeFrameIndex.x] / 1800) * Math.PI,
      (-frame[attitudeFrameIndex.y] / 1800) * Math.PI,
      (-frame[attitudeFrameIndex.z] / 1800) * Math.PI,
      typeof collectiveFieldIndex === "number" ? frame[collectiveFieldIndex] : undefined,
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
