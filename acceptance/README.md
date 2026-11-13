# Overview acceptance runners

These runners exercise the real renderer and native components with sanitised
fixtures. They supplement the focused Vitest tests. Fixture project names,
messages and IDs are synthetic; do not copy real chat or roster data here.

- `renderer.cjs` bundles the actual foreground and perspective-background passes.
  It checks cold loading, grouping, readable nodes, selection, stable depth
  centres and safe growth; matching graph/cloud projection; activity-admitted
  feeds and arrivals; rendered room/cloud structure in both themes; live
  appearance changes; pause/static/off/reduced-motion/visibility; shader
  isolation and disposal. Instrumentation stays in the fixture. Pixel evidence
  accompanies geometry assertions: nonzero attributes alone are not visual
  acceptance. An online empty room may show sparse decorative transit; these
  streams have no cloud destination and never create observed activity.
  Two-host fixtures verify duplicate local IDs, isolated disconnect cleanup,
  retained selection and unchanged overlay geometry during heartbeat-only frames.
- `performance.cjs` connects to an explicitly supplied isolated hardware-browser
  CDP endpoint. It records frame intervals, browser main-thread/script work,
  resource counts and automated pointer-selection timing. It rejects software
  rendering; its timings are observations of the tested machine, not universal
  performance guarantees. Matching no-event on/off runs remain comparable; a
  separate streaming scenario exercises event admission and bubbles. Counters
  distinguish layout, overlay positioning, transient placement, field rebuilds
  and uploads, committed project transforms and route synchronization. Compare
  both main-thread work per second and per rendered frame using the same fixture,
  viewport, pixel ratio, activity schedule and settings. Record a source baseline
  before edits; do not compare synthetic fixture totals directly with live-roster
  totals. Counters assert one field flush per render, unchanged-field reuse and
  retained geometry during heartbeat-only frames. Unit tests cover exact field
  equivalence and accumulated subpixel transform commits.
  Distinguish an Overview-local theme update from the current host's global
  appearance boundary: the latter remounts screen contents and reloads passive
  rosters/icons. Renderer identity preservation applies to local appearance
  changes and fullscreen, not an upstream screen remount.
- `native-preview.cjs` renders the actual native graph and shared header through
  React Native Web at a phone viewport, with touch and a device pixel ratio of 2.
  It checks scope/count agreement, avatars, groups, 44-pixel collapse controls and
  initial primary-agent framing.
  The native-only fixture includes a mixed finished/idle/closed/canceled group;
  both native runners check its accessibility summary and the expanded visible
  outcomes and member selection.
- `native-interaction.cjs` runs the same native components without a DOM or
  Three.js. Native primitives and animation scheduling are mocked so phase
  continuity, obsolete callbacks, visibility, AppState, reduced motion and
  cleanup can be checked deterministically.
- `floating.cjs` exercises the actual browser positioner with long scrollable
  cards, short viewports, corner anchors, CSS zoom, a bordered/scrolled offset
  parent, rapid updates and Escape. It asserts graph containment with a 12-pixel
  margin and confirms that opening the card does not change graph dimensions.
- `compile.mjs` uses the Paseo plugin compiler and checks the compiled native
  boundary, including Hermes where the pinned build environment provides it.
- `packaged.cjs` exercises the selected plugin directory on an exact host
  package, including screenshot-based room structure, theme and
  pause checks, host-persisted appearance controls, additive streaming previews, actual element fullscreen,
  preserved selection/expansion, explicit exit and navigation cleanup. Fullscreen
  tests use a real user click and inspect `document.fullscreenElement`; controller
  mocks alone are not fullscreen acceptance.
  Its `multi-host.cjs` helper starts a second isolated daemon from that same
  package, with no Overview installation, and checks borrowed remote reads,
  host/project menus, correct-host chat navigation and offline retention.
  Light-mode movement must change enough composited pixels with a meaningful
  contrast delta; merely changing a few pixel values is insufficient.

Browser screenshots and JSON results go under `/out` in the container, or the
path selected by `OVERVIEW_ACCEPTANCE_OUTPUT`. Keep outputs outside Git. Chromium
uses software rendering for these checks, so its timings do not establish GPU
performance on a user's workstation. Native Web rendering and mocked component
checks do not establish physical-device behaviour. Choose checks for the changed
behaviour: browser-only presentation changes retain native compilation coverage;
repeat native interaction or paired-phone acceptance when native behaviour changes
or a native regression is found. Run focused unit tests while editing and let the
artifact builder perform its final declared checks. Repeat affected checks after
fixes rather than rerunning every runner after documentation or lock-only edits.

Inspect the saved full, selected, activity and dark-theme captures after a pass:
the floor/wall, feeds and faint clouds must be noticeable at normal browser zoom while labels, ownership links,
bubbles and details remain readable. Use the normal workstation browser for
hardware frame-time, draw-call and pointer-response conclusions.

Use the existing pinned build environment. Set `OVERVIEW_FORK_CHECKOUT` to its
prepared Paseo source with installed build dependencies, `OVERVIEW_SOURCE` to this
checkout, and `OVERVIEW_BROWSER_CACHE` to its Playwright cache. Evidence goes in
`/tmp/overview-091` in this example:

```bash
mkdir -p /tmp/overview-091
overview_check_image=$(jq -r .checkBuilderImage "$OVERVIEW_FORK_CHECKOUT/fork-release.json")

docker run --rm --init --user 1000:1000 --network none --shm-size 2g \
  --mount "type=bind,src=$OVERVIEW_FORK_CHECKOUT,dst=/fork,readonly" \
  --mount "type=bind,src=$OVERVIEW_BROWSER_CACHE,dst=/cache/playwright,readonly" \
  --mount "type=bind,src=$OVERVIEW_SOURCE,dst=/plugin,readonly" \
  --mount type=bind,src=/tmp/overview-091,dst=/out \
  --mount type=bind,src=/usr/share/fonts,dst=/usr/share/fonts,readonly \
  --env XDG_CACHE_HOME=/tmp/cache \
  "$overview_check_image" \
  node /plugin/acceptance/renderer.cjs
```

For changes to those components, select `native-preview.cjs`, `floating.cjs` or `native-interaction.cjs`. The native
interaction runner needs neither the browser cache nor the font mount. Read
`compile.mjs` for its exact output requirements before running it. With the same
`/fork`, `/plugin` and `/out` mounts, its successful compiler command is:

```bash
node --import /fork/node_modules/tsx/dist/loader.mjs /plugin/acceptance/compile.mjs
```

Mount the host's usable UI and emoji fonts for visual checks. The minimal build
image alone may render fallback boxes for emoji; that is an acceptance environment
problem rather than evidence that the graph's identity glyphs work. Inspect the
saved full, selected, activity and phone screenshots after the assertions pass.

The packaged-plugin acceptance remains separate: install a prepared plugin
directory into a daemon run from an exact package, then verify navigation and RPC
behavior. Set:

- `OVERVIEW_TEST_DEB`: retained exact package file.
- `OVERVIEW_TEST_PLUGIN_DIR`: prepared plugin directory containing
  `paseo-plugin.json`, `package.json`, the entry sources and any production
  `node_modules` the plugin imports.
- `OVERVIEW_EXPECT_RUNTIME_VERSION`: exact daemon version.
- `OVERVIEW_EXPECT_PACKAGE_SHA256`: retained package SHA256.
- `OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS`: `required` or `not-applicable`.

Every run requires the expectation values. The harness hashes the package before
starting the daemon and fails on mismatch, then reads the prepared directory's
ordinary plugin manifest identity. Missing or invalid inputs fail before the
daemon starts. Do not pass `OVERVIEW_TEST_ARTIFACT` or mount `/artifact`; those
inputs are rejected with a migration message.

Prepare the directory from the reviewed public checkout. Overview needs its locked
production dependencies (`three`, `d3-hierarchy` and `@floating-ui/dom`):

```bash
overview_plugin=$(mktemp -d /tmp/paseo-overview-plugin.XXXXXXXX)
overview_output=$(mktemp -d /tmp/paseo-overview-acceptance.XXXXXXXX)
overview_check_image=$(jq -r .checkBuilderImage "$OVERVIEW_FORK_CHECKOUT/fork-release.json")
git -C "$OVERVIEW_SOURCE" archive HEAD | tar -xf - -C "$overview_plugin"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$overview_plugin,dst=/work" --workdir /work \
  --env npm_config_cache=/tmp/npm "$overview_check_image" \
  npm ci --ignore-scripts --omit=dev
```

Then run, after selecting the tested package's version and hash:

```bash
docker run --rm --init --user "$(id -u):$(id -g)" --network none --shm-size 2g \
  --mount "type=bind,src=$OVERVIEW_FORK_CHECKOUT,dst=/fork,readonly" \
  --mount "type=bind,src=$OVERVIEW_BROWSER_CACHE,dst=/cache/playwright,readonly" \
  --mount "type=bind,src=$OVERVIEW_SOURCE,dst=/plugin-source,readonly" \
  --mount "type=bind,src=$OVERVIEW_TEST_DEB,dst=/inputs/package.deb,readonly" \
  --mount "type=bind,src=$overview_plugin,dst=/plugin-dir,readonly" \
  --env OVERVIEW_TEST_PLUGIN_DIR=/plugin-dir \
  --env "OVERVIEW_EXPECT_RUNTIME_VERSION=$OVERVIEW_EXPECT_RUNTIME_VERSION" \
  --env "OVERVIEW_EXPECT_PACKAGE_SHA256=$OVERVIEW_EXPECT_PACKAGE_SHA256" \
  --env OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS=required \
  --mount "type=bind,src=$overview_output,dst=/out" \
  --mount type=bind,src=/usr/share/fonts,dst=/usr/share/fonts,readonly \
  --env XDG_CACHE_HOME=/tmp/cache \
  "$overview_check_image" \
  bash /plugin-source/acceptance/package-container.sh
```

The script extracts the package into a temporary container directory and starts
an isolated daemon home with a fixture provider. It never reads or restarts the
workstation's running Paseo daemon. Omit the `/plugin-dir` mount and
`OVERVIEW_TEST_PLUGIN_DIR` to test the `/plugin-source` checkout instead. Results
report `origin` as `prepared-plugin-directory` or `source-checkout`; neither is an
approval record. Repeat prepared-directory acceptance on each package you select.

A successful `required` run must include both `bounded Overview previews independent
of chat preferences` and `stock chat preview disable/enable and one-way expansion`
in `results.json`'s `checks`. The check turns the isolated browser setting off and
on, verifies full chat text and one-way expansion, and confirms Overview's own
preview remains bounded. The report records the expectation and the checks
actually performed. A new version label does not automatically skip chat
coverage. Do not accept a source-checkout result as evidence for a prepared
directory, or modify the selected package.

Keep completion evidence explicit: source-checkout success, prepared-directory
success, hardware measurements and live visual acceptance are separate results. A
report must identify the exact plugin manifest identity, package hash and daemon
version under test; software-rendered frame timings do not establish real-GPU
performance. The fixture's `?performance=1` mode retains frame timestamps while
skipping expensive diagnostic scene traversal. Its background toggle compares the
background on/off cost under the same foreground load. Off also removes
background scheduling and field updates.

For hardware measurements, start an isolated browser with local remote debugging
and its normal GPU enabled. Use its endpoint in the prepared acceptance environment:

```bash
OVERVIEW_BROWSER_CDP=http://127.0.0.1:9222 \
  node /plugin/acceptance/performance.cjs
```

The browser must reach the fixture HTTP server started by this runner; a container
on the same workstation therefore needs host networking for this check instead of
`--network none`. Keep the normal read-only source/dependency mounts and `/out`
output mount. Never attach this runner to a user's existing browsing profile.
The on/off/on comparison retains the same foreground. Quiet-cloud and empty-room
samples distinguish background animation from an idle scene. Pointer measurements include Playwright and event-loop
latency. Inspect the hardware screenshots as well as `performance-results.json`;
keep live deployed acceptance separate from this sanitised fixture.
