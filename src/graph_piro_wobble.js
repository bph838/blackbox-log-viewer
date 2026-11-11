// The piro wobble window: a top-down plot of where the bottom of the heli's mast swings through
// the piro section (P key, see piro_wobble.js), drawn on its own 2D canvas like the analyser and
// step response windows. grapher.js shows it while the section is on screen.
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
const DOT_COLOR = "#ffed6f";
const SECTION_COLOR = "rgba(80, 160, 255, 0.95)";
const TRAIL_FADE_US = 4e6; // The trail fades over this long, down to TRAIL_MIN_ALPHA.
const TRAIL_MIN_ALPHA = 0.25;
const OPEN_SECTION_LOOKAHEAD_US = 5e6;

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

    const font = Math.max(9, Math.round(w / 26));
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

    // Background
    ctx.fillStyle = "rgba(20, 24, 30, 0.82)";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(80, 160, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Header
    ctx.font = `bold ${font}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = SECTION_COLOR;
    ctx.fillText("Piro wobble", font * 0.7, headerH / 2);
    ctx.font = `${Math.round(font * 0.8)}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillStyle = "#999";
    ctx.fillText("mast bottom, seen from above", w - font * 0.7, headerH / 2);

    // Rings and crosshair
    ctx.strokeStyle = "rgba(170, 170, 170, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();
    ctx.font = `${Math.round(font * 0.8)}px sans-serif`;
    ctx.fillStyle = "#aaa";
    ctx.textAlign = "left";
    for (const deg of RING_DEGREES) {
      const r = deg * k;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${deg}°`, cx + r * Math.SQRT1_2 + 2, cy + r * Math.SQRT1_2 + 2);
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
      ctx.fillStyle = DOT_COLOR;
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(3, font * 0.35), 0, Math.PI * 2);
      ctx.fill();
      nowText = `Lean now ${lean.degrees.toFixed(1)}°`;
      maxLean = Math.max(maxLean, lean.degrees);
    }

    // Footer
    ctx.textAlign = "left";
    ctx.font = `${Math.round(font * 0.85)}px sans-serif`;
    ctx.fillStyle = "#ddd";
    const footerTop = h - footerH;
    ctx.fillText(
      `${nowText}${nowText ? " · " : ""}max ${maxLean.toFixed(1)}°`,
      font * 0.7,
      footerTop + font * 1.0,
    );
    trim.forEach((line, i) => {
      ctx.fillStyle = line.warn ? "#f0a050" : SECTION_COLOR;
      ctx.fillText(line.text, font * 0.7, footerTop + font * (2.3 + 1.3 * i), w - font * 1.4);
    });
  };
}
