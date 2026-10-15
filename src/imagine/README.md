# Gyro – Imagine

Imagine shows what changing the Rotorflight gyro filter settings would do to a logged flight. It runs a JavaScript port of the firmware's gyro filter chain over the logged unfiltered gyro (`gyroRAW`). The result is overlaid on the spectrum together with the logged filtered gyro (`gyroADC`).

## Firmware reference

The filter maths is ported from [rotorflight-firmware](https://github.com/rotorflight/rotorflight-firmware), branch `RF-4.6.x` at commit `53fd0637`, which is release 4.6.0 plus one commit. On 2026-10-15 the filter sources on this branch were identical to `master`. Imagine compares the log header's firmware version against this reference and labels the result as follows.

| Log firmware | Label |
| --- | --- |
| Rotorflight 4.6.x | match |
| Any other Rotorflight | approximate |
| Not Rotorflight | unsupported |

| Firmware file | Port |
| --- | --- |
| `common/maths.c` (minimax sin/cos/tan) | `filters/fw_math.js` |
| `common/filter.c` (PT1-3, first order, biquad, notch Q) | `filters/filters.js` |
| `common/sdft.c`, `flight/dyn_notch_filter.c` | `filters/dyn_notch.js` |
| `flight/rpm_filter.c` | `filters/rpm_filter.js` |
| `sensors/gyro_init.c`, `gyro_filter_impl.c`, `gyro.c` (dynamic LPF) | `filters/gyro_chain.js` |

The firmware applies the filters in this order:

1. RPM notches
2. LPF2
3. LPF1
4. Notch 2
5. Notch 1
6. Dynamic notch

The dynamic LPF, the dynamic notch tracker and the RPM notch updates run once per PID loop, as in `fc/core.c`.

## How the simulation runs

1. The logged `gyroRAW` is the decimated gyro, which is exactly the input to the firmware filter chain.
2. The blackbox log rate is lower than the filter rate. A typical log runs at 500 Hz against a 2 kHz filter rate. The log is therefore upsampled to the filter rate with a windowed-sinc interpolator, in `filters/resample.js`.
3. The ported chain runs at the real filter rate with the real coefficients. The result is then point-sampled at the logged instants, as the blackbox recorder does.

The simulation code is in `simulate.js`. It runs in a web worker, through `sim.worker.js` and `sim_client.js`.

### Accuracy limits

- **Aliasing.** Vibration above the log's Nyquist frequency was folded into the log at a wrong, lower frequency. The firmware filtered it at its true frequency, but the simulation filters it at the folded one. This cannot be undone. The match is best below roughly 40% of the log Nyquist frequency.
- **Gear ratios and governor settings.** The log header does not contain gear ratios, the governor mode or `gov_headspeed`. They come from the craft config.
- **RPM notches.** Main rotor harmonics come straight from the logged headspeed. The main motor and tail notches need the gear ratios, or a logged `tailspeed`.
- **Governor state.** The governor state is not logged. The dynamic LPF treats a rotor below 10% of full headspeed as idle.
- **Gaps.** Gaps in the log are treated as continuous data.

## Getting the log into Imagine

The main window opens `/imagine/` in a new tab, from `openImagine` in `handoff.js`. Imagine posts `imagine:ready` to `window.opener`. The main window answers with:

- a copy of the raw log bytes
- the sub-log index
- the in/out markers
- a snapshot of the craft config

Both sides check that the message comes from the same origin. Imagine also works on its own: open or drop a `.bbl` file onto the page.

## Tests

```sh
npx vitest run src/imagine
```

The reproduce check runs a real log with its own settings and compares the result with the logged filtered gyro. It is skipped unless a log path is given:

```sh
IMAGINE_SAMPLE_LOG=path/to/log.bbl [IMAGINE_TAIL_RATIO=5.75] npx vitest run src/imagine/validation.test.js --reporter=verbose
```
