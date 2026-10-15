// Numbers behind the dynamic notch chart overlay.

/**
 * Lower cutoff of a notch with centre f0 and quality Q: the inverse of the firmware's
 * notchFilterGetQ(f0, f1) = f0*f1 / (f0^2 - f1^2). Lets dynamic notches be drawn with the same
 * triangle (cutoff, centre, mirrored cutoff) the Analyser uses for the static notches.
 */
export function notchLowerCutoff(f0, q) {
  if (!(f0 > 0) || !(q > 0)) return f0;
  return (f0 * (Math.sqrt(1 + 4 * q * q) - 1)) / (2 * q);
}

/**
 * Where the simulated dynamic notches sat on one axis over a sample range.
 * @param {Float32Array} centers  simulation dynNotchCenters, [sample][axis][notch]
 * @param {number} count notches per axis
 * @returns {{medians:number[], histogram:Float32Array, binHz:number, maxBin:number}}
 */
export function dynNotchStats(centers, count, axis, start, end, maxHz, binHz = 1) {
  const bins = Math.max(1, Math.ceil(maxHz / binHz));
  const histogram = new Float32Array(bins);
  const medians = [];
  if (!centers || !count || end <= start) return { medians, histogram, binHz, maxBin: 0 };

  for (let p = 0; p < count; p++) {
    const values = new Float32Array(end - start);
    for (let i = start; i < end; i++) {
      const f = centers[i * 3 * count + axis * count + p];
      values[i - start] = f;
      const b = Math.floor(f / binHz);
      if (b >= 0 && b < bins) histogram[b]++;
    }
    values.sort();
    medians.push(values[Math.floor(values.length / 2)]);
  }
  let maxBin = 0;
  for (let b = 0; b < bins; b++) if (histogram[b] > maxBin) maxBin = histogram[b];
  return { medians, histogram, binHz, maxBin };
}
