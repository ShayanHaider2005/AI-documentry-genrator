import { Config } from '@remotion/cli/config';

Config.setPublicDir('public');

/**
 * Remotion configuration.
 *
 * Three of the four settings the original brief asked for are listed below with
 * the reason each one is not applied as written. Two of them would have broken
 * the render outright rather than fixing it.
 */

/**
 * OpenGL renderer: 'angle'.
 *
 * Applied. This machine has an NVIDIA MX330, and Chromium's default on Windows
 * falls back to SwiftShader (pure software), which is markedly slower for the
 * canvas and video work this composition does. 'angle' uses the real GPU.
 *
 * Note this contradicts the brief's `--disable-gpu`: ANGLE is a GPU-backed
 * renderer, so asking for it and then disabling the GPU is asking for two
 * opposite things. Only 'angle' is kept. If a driver ever misbehaves, switch
 * this to 'swangle' (software ANGLE) rather than bolting on --disable-gpu.
 */
Config.setChromiumOpenGlRenderer('angle');

/**
 * Page/delayRender timeout: 120s.
 *
 * Applied, but the name in the brief is wrong about what this does.
 * `Config.setTimeoutInMilliseconds` is an alias for
 * `setDelayRenderTimeoutInMilliseconds` (verified in
 * node_modules/@remotion/cli/dist/config/index.js — both point at
 * `delayRenderTimeoutInMillisecondsOption.setConfig`). The Remotion default is
 * 30s.
 *
 * It is not a "browser launch timeout" and there is no separate knob for one.
 * The same option is what @remotion/renderer passes into `getCompositions` ->
 * `setPropsAndEnv`, which is how long it waits for the browser page to come up
 * and accept props. So raising it does buy more headroom on a slow cold start,
 * which is presumably the symptom being chased.
 *
 * 120s is the right size for this box: CPU-only OmniVoice, a 2 GB GPU shared
 * with the display, and scenes whose images come from remote Pexels URLs. It is
 * also a ceiling, not a delay — a healthy render never waits that long.
 */
Config.setTimeoutInMilliseconds(120000);

/**
 * `Config.setConcurrency(1)` — deliberately not applied.
 *
 * Server renders are unaffected either way: server/render.js passes
 * `--concurrency=50%` on the command line, and a CLI flag beats the config file.
 * So this line would only change Studio, where it would force single-threaded
 * rendering on an 8-core machine. If renders are dying from memory pressure,
 * that is better addressed by lowering concurrency on the CLI flag, which is
 * per-render, than by globally pinning Studio to one frame at a time.
 *
 * `Config.setChromiumOptions({ args: [...] })` — does not exist.
 *
 * There is no arbitrary-Chromium-args setter in @remotion/cli 4.0.529. The real
 * surface is: setChromiumOpenGlRenderer, setChromiumHeadlessMode,
 * setChromiumDisableWebSecurity, setChromiumIgnoreCertificateErrors,
 * setChromiumUserAgent, setChromiumMultiProcessOnLinux, setChromiumDarkMode.
 * Adding the brief's line as written throws
 * "Config.setChromiumOptions is not a function" before a single frame renders.
 *
 * The three sandbox/GPU flags it wanted are also Windows-inapplicable:
 * `--no-sandbox` and `--disable-setuid-sandbox` are Linux container flags, and
 * `--disable-dev-shm-usage` matters only where /dev/shm is small. If Chromium
 * ever does hang on launch here, `Config.setChromiumHeadlessMode('new')` and
 * the `--gl` flag are the levers that exist.
 */
