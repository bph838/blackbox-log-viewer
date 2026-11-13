// The piro wobble plot: a top-down view of where the bottom of the heli's mast swings through the
// piro section (P key, see piro_wobble.js), on its own 2D canvas. grapher.js places it as the
// right half of the craft window, which it widens while the section is on screen.
//
// The plot is in the craft view's frame (right = the viewer's right, up = away from the viewer),
// matching the blue mast line on the 3D heli: the dot is where the bottom of that line has swung
// to, so it moves the opposite way to the rotor head's lean.

import {
  analysePiroTrim,
  attitudeToModelRotation,
  buildPiroTrace,
  mastLean,
  traceCountAt,
} from "./piro_wobble.js";

const MAX_DEGREES = 6; // Outer ring.
const RING_DEGREES = [2, 4, 6];
const CLAMP = 1.15; // Leans beyond the outer ring are pinned just outside it.
const TRAIL_RGB = "128, 177, 211";
const ARROW_COLOR = "#ffed6f";
const TRAIL_FADE_US = 4e6; // The trail fades over this long, down to TRAIL_MIN_ALPHA.
const TRAIL_MIN_ALPHA = 0.25;
const OPEN_SECTION_LOOKAHEAD_US = 5e6;

/**
 * The heli's current position on the plot: an arrow centred on (x, y) pointing where the nose
 * points. yaw is the model's yaw as shown (wrapper rotation.y, including the facing offset); at
 * 0 the model shows its tail to the viewer, so the nose points away - up on the plot - and a
 * positive yaw turns it to the left.
 */
export function headingOnPlot(yaw) {
  return { x: -Math.sin(yaw), y: -Math.cos(yaw) }; // canvas: +x right, +y down
}

function drawHeadingArrow(ctx, x, y, yaw, length) {
  const { x: ux, y: uy } = headingOnPlot(yaw);
  const px = -uy, py = ux; // perpendicular
  const half = length / 2, wing = length * 0.38;
  ctx.save();
  // Tail: a short shaft back from the head's notch, outlined like the head.
  const tailFrom = half * 0.45, tailTo = half + length * 0.55;
  ctx.lineCap = "round";
  for (const [style, width] of [["black", Math.max(4, length * 0.22)], [ARROW_COLOR, Math.max(2, length * 0.13)]]) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x - ux * tailFrom, y - uy * tailFrom);
    ctx.lineTo(x - ux * tailTo, y - uy * tailTo);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.fillStyle = ARROW_COLOR;
  ctx.strokeStyle = "black";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + ux * half, y + uy * half); // tip
  ctx.lineTo(x - ux * half + px * wing, y - uy * half + py * wing);
  ctx.lineTo(x - ux * half * 0.45, y - uy * half * 0.45); // notch
  ctx.lineTo(x - ux * half - px * wing, y - uy * half - py * wing);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function PiroWobblePlot(flightLog, canvas) {
  const ctx = canvas.getContext("2d");
  const attitude = [0, 1, 2].map((i) => flightLog.getMainFieldIndexByName(`attitude[${i}]`));
  const hasAttitude = attitude.every((i) => typeof i === "number");

  let cssSize = 0;
  let trace = null, traceKey = null, traceEnd = 0;
  let trimKey = null, trimLines = [];

  this.hasData = () => hasAttitude;

  this.resize = function (size) {
    const dpr = window.devicePixelRatio || 1;
    cssSize = Math.max(1, Math.round(size));
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
  };

  function ensureTrace(section, time, facingOffset) {
    const open = section.end == null;
    const key = `${section.start}|${section.end}|${facingOffset}`;
    if (key !== traceKey || (open && time > traceEnd)) {
      traceEnd = open ? Math.max(time, section.start) + OPEN_SECTION_LOOKAHEAD_US : section.end;
      trace = buildPiroTrace(flightLog, section.start, traceEnd, facingOffset);
      traceKey = key;
    }
    return trace;
  }

  // The swash trim suggestion (see analysePiroTrim), as up to two lines of { text, warn }.
  function trimSuggestion(section) {
    if (section.end == null) return [{ text: "Press P to end the section" }];
    const key = `${section.start}|${section.end}`;
    if (key !== trimKey) {
      trimKey = key;
      const r = analysePiroTrim(flightLog, section.start, section.end);
      const pct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
      if (!r.ok) {
        trimLines = [{ text: `Trim: ${r.reason}`, warn: true }];
      } else {
        trimLines = [
          { text: `${r.revolutions.toFixed(1)} turns · add Roll trim ${pct(r.rollTrim)} · Pitch trim ${pct(r.pitchTrim)}` },
        ];
        if (r.stickWarning) {
          trimLines.push({
            text: `Cyclic stick moved (${r.stickDegS.toFixed(0)}°/s avg) - trims unreliable`,
            warn: true,
          });
        }
      }
    }
    return trimLines;
  }

  /**
   * @param {{start: number, end: number|null}} section
   * @param {number} time - the cursor's log time
   * @param {Array|null} frame - the frame at the cursor, for the current lean
   * @param {number} facingOffset - the craft view's facing offset (radians)
   */
  this.draw = function (section, time, frame, facingOffset) {
    const dpr = canvas.width / (cssSize || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssSize, h = cssSize;
    ctx.clearRect(0, 0, w, h);
    if (!hasAttitude) return;

    // Text grows with the plot up to a point, so the enlarged craft gets a bigger plot rather
    // than bigger writing.
    const font = Math.min(13, Math.max(9, Math.round(w / 30)));
    const headerH = font * 1.9;
    const trim = trimSuggestion(section);
    const footerH = font * (2.2 + 1.3 * trim.length);
    const cx = w / 2;
    const cy = headerH + (h - headerH - footerH) / 2;
    const radius = Math.max(10, Math.min(w / 2, (h - headerH - footerH) / 2) - font * 0.8);
    const k = radius / MAX_DEGREES;
    const toXY = (x, y) => {
      // x, y: the rotor head's lean; the mast's bottom swings the other way.
      const r = Math.hypot(x, y) * k;
      const s = r > radius * CLAMP ? (radius * CLAMP) / r : 1;
      return [cx - x * k * s, cy + y * k * s];
    };
    // Text drawn like the step response's labels: white Verdana with a black outline.
    const label = (text, x, y, align, scale = 1, color = null) => {
      ctx.save();
      ctx.font = `${Math.round(font * scale)}px Verdana, Arial, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.shadowColor = "black";
      ctx.shadowBlur = 3;
      ctx.strokeStyle = "black";
      ctx.lineWidth = 2;
      ctx.strokeText(text, x, y, w - x - font * 0.5);
      ctx.fillStyle = color || "rgba(255,255,255,0.9)";
      ctx.fillText(text, x, y, w - x - font * 0.5);
      ctx.restore();
    };

    // The backdrop is the craft window's, from CSS (#piroWobbleCanvas in main.css).

    label("Piro wobble", font * 0.5, headerH / 2, "left");

    // Rings and crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();
    for (const deg of RING_DEGREES) {
      const r = deg * k;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      label(`${deg}°`, cx + r * Math.SQRT1_2 + 2, cy + r * Math.SQRT1_2 + 2, "left", 0.8);
    }

    // Trail up to the cursor
    const t = ensureTrace(section, time, facingOffset);
    const count = traceCountAt(t.times, time);
    ctx.lineWidth = 1.5;
    let maxLean = 0;
    for (let i = 1; i < count; i++) {
      const age = time - t.times[i];
      const alpha = Math.max(TRAIL_MIN_ALPHA, 1 - age / TRAIL_FADE_US);
      const [x0, y0] = toXY(t.x[i - 1], t.y[i - 1]);
      const [x1, y1] = toXY(t.x[i], t.y[i]);
      ctx.strokeStyle = `rgba(${TRAIL_RGB}, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    for (let i = 0; i < count; i++) maxLean = Math.max(maxLean, Math.hypot(t.x[i], t.y[i]));

    // Current lean - only while the cursor is inside the section
    const inside = time >= section.start && (section.end == null || time <= section.end);
    let nowText = inside ? "" : time < section.start ? "Before the section" : "After the section";
    if (inside && frame) {
      const r = attitudeToModelRotation(frame[attitude[0]], frame[attitude[1]], frame[attitude[2]], facingOffset);
      const lean = mastLean(r.roll, r.pitch, r.yaw);
      const [dx, dy] = toXY(lean.x, lean.y);
      drawHeadingArrow(ctx, dx, dy, r.yaw, Math.max(12, font * 1.8));
      nowText = `Lean now ${lean.degrees.toFixed(1)}°`;
      maxLean = Math.max(maxLean, lean.degrees);
    }

    // Footer
    const footerTop = h - footerH;
    label(`${nowText}${nowText ? " · " : ""}max ${maxLean.toFixed(1)}°`, font * 0.5, footerTop + font, "left");
    trim.forEach((line, i) => {
      label(line.text, font * 0.5, footerTop + font * (2.3 + 1.3 * i), "left", 1, line.warn ? "orange" : null);
    });
  };
}
