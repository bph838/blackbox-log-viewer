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

## AI Filters

A chat panel, opened with the toolbar's AI Filters button, where Claude looks at a summary of the log and suggests filter settings. The code is in `ai/`.

- **Claude calls.** These go through `streamClaude` in `src/tuning_ai.js`, shared with the Tuning Log. It uses the same API key, model and effort settings, and streams with adaptive thinking. Server-side refusal fallback is on for the models that support it. The key stays in this browser and only goes to api.anthropic.com.
- **What is sent.** `filter_summary.js` builds about 5 KB, roughly 1,400 tokens: loop rates, rotor speeds and harmonics, the current settings as CLI lines, and for each axis the noise peaks with their likely source, the noise floor and the flown filters' deepest cuts. An applied config's Imagine result adds roughly 600–700 tokens. The panel's "Show data sent with this message" view shows exactly what will go.
- **Suggestions.** Claude suggests through the `propose_filter_config` tool in `filter_tool.js`. The tool uses a strict schema, Rotorflight CLI names and CLI units. Every value is checked against the firmware's CLI limits plus cross-checks; a failed check goes straight back to Claude to correct. Nothing changes until the user presses Apply.
- **Conversations.** `conversation.js` keeps the history append-only, because thinking and tool_use blocks have to go back unchanged. App context is wrapped in `<log_summary>`, `<imagine_result>` or `<current_settings>` tags. Conversations, with their saved configs, are stored per craft in the `rfImagineAiFilters` IndexedDB database.
- **System prompt.** It's in `system_prompt.js`, and its parameter table is generated from the parameter list in `filter_tool.js`.

## Filter search

The toolbar's Filter search button swaps the spectrum for a search view. The search looks for the filter setups with the least gyro noise for each amount of filter delay, on this flight. The code is in `search/`.

- **Noise and delay.** Gyro movement below a boundary, 20 Hz by default, is flight motion. Noise is the filtered gyro RMS from the boundary up to the log's Nyquist frequency, combined over the three axes. Delay is the chain's phase delay, averaged from 5 Hz to the boundary in 5 Hz steps and over the axes. Setups that cut the flight band by more than 3 dB are never recommended.
- **Noise model.** `noise_model.js` cuts the analysed range into one-second segments, keeps only those with the rotor turning, and groups them by headspeed into up to five buckets with averaged spectra.
- **Fast estimate.** `evaluate.js` scores a setup in the frequency domain. Each bucket's spectrum is multiplied by |H(f)|² of every stage, using the same ported filter objects as the simulation. The RPM notches are the exception. They follow the rotor and remove its tones completely, which a spectrum product can't reproduce, so the RPM stage alone runs through the time-domain simulation once per RPM setup. The dynamic notches are placed on the largest peaks left after the other filters. The estimate matches the full simulation within about 1% without a dynamic notch, and is optimistic with one, because the real tracker hops and lags.
- **Search.** `search.js` scores a few thousand random setups from `search_space.js`, then mutates the setups on the Pareto front until it stops improving. A spread of the front and the log's own settings then go through the full simulation. The verified results give each dynamic notch count a correction factor, the front is refined again with the corrected estimates, and more setups are verified. The chart's line and the recommendation use verified noise only.
- **What is searched.** LPF1 and LPF2 type and cutoff, both static notches at the largest spectrum peaks above the flight band with four Q values, the dynamic notch count and Q, and all RPM notch Qs scaled together. Every option stays inside the CLI limits, and each filter group can be locked to its logged value. The search runs in `search.worker.js`, which keeps the last search so "Check more near this noise" can verify more setups without searching again.
- **Limits.** The search is open-loop. It cannot show how less filtering changes the PID loop, and the result fits the noise of the flight it was run on.

The sample-log check in `validation.test.js` also runs a full search and prints its front.
