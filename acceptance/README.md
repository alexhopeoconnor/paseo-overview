# Overview acceptance runners

These runners exercise the real renderer and native components with sanitised
fixtures. They supplement the focused Vitest tests. Fixture project names,
messages and IDs are synthetic; do not copy real chat or roster data here.

- `renderer.cjs` bundles the real Three.js renderer and checks delayed loading,
  ownership roles, animal identities, explicit groups, selected ancestors,
  background framing, visibility restoration, bounded bubbles and disposal. It
  also observes real depth transforms, fixed centres, pulse continuity, visible
  grid structure and actual rendered pixel movement, local illumination changes
  at a fixed animation phase, bounded field warp, unchanged GPU attributes on
  cached ambient-only frames and the shader-failure fallback,
  with pause/visibility/reduced-motion checks. New activity while paused must leave
  the field unchanged. Theme checks compare pixels after a rendered frame and
  verify the colours of already-running fibre journeys. Instrumentation stays in the
  fixture, outside the product bundle.
  A rendered phase-boundary comparison verifies that the bounded clock does not
  visibly jump when it wraps.
- `performance.cjs` connects to an explicitly supplied isolated hardware-browser
  CDP endpoint. It records frame intervals, browser main-thread/script work,
  resource counts and automated pointer-selection timing. It rejects software
  rendering; its timings are observations of the tested machine, not universal
  performance guarantees.
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
- `packaged.cjs` exercises the immutable plugin on the current exact host
  package, including screenshot-based grid structure, pixel movement, theme and
  pause checks, additive streaming previews, actual element fullscreen,
  preserved selection/expansion, explicit exit and navigation cleanup. Fullscreen
  tests use a real user click and inspect `document.fullscreenElement`; controller
  mocks alone are not fullscreen acceptance.
  Light-mode movement must change enough composited pixels with a meaningful
  contrast delta; merely changing a few pixel values is insufficient.

Browser screenshots and JSON results go under `/out` in the container, or the
path selected by `OVERVIEW_ACCEPTANCE_OUTPUT`. Keep outputs outside Git. Chromium
uses software rendering for these checks, so its timings do not establish GPU
performance on a user's workstation. Native Web rendering and mocked component
checks do not establish physical-device behaviour. Browser-only changes retain
these native regression checks; repeat paired-phone acceptance if native behaviour
changes or a native regression is found.

Inspect the saved full, selected, activity and dark-theme captures after a pass:
the grid must be noticeable at normal browser zoom while labels, ownership links,
bubbles and details remain readable. Use the normal workstation browser for
hardware frame-time, draw-call and pointer-response conclusions.

Use the existing pinned build environment. Set `OVERVIEW_FORK_CHECKOUT` to its
prepared Paseo source with installed build dependencies, `OVERVIEW_SOURCE` to this
checkout, and `OVERVIEW_BROWSER_CACHE` to its Playwright cache. Evidence goes in
`/tmp/overview-v06` in this example:

```bash
mkdir -p /tmp/overview-v06

docker run --rm --init --user 1000:1000 --network none --shm-size 2g \
  --mount "type=bind,src=$OVERVIEW_FORK_CHECKOUT,dst=/fork,readonly" \
  --mount "type=bind,src=$OVERVIEW_BROWSER_CACHE,dst=/cache/playwright,readonly" \
  --mount "type=bind,src=$OVERVIEW_SOURCE,dst=/plugin,readonly" \
  --mount type=bind,src=/tmp/overview-v06,dst=/out \
  --mount type=bind,src=/usr/share/fonts,dst=/usr/share/fonts,readonly \
  --env XDG_CACHE_HOME=/tmp/cache \
  sha256:4af0a666444ca69a855eb0c7ff5ade27adb3dc6529644bc3a48ec588d153277c \
  node /plugin/acceptance/renderer.cjs
```

Repeat with `native-preview.cjs`, `floating.cjs` and `native-interaction.cjs`. The native
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

The packaged-plugin acceptance remains separate: install the immutable artifact
on an isolated exact supported host, verify its navigation and RPC behavior, and
record those host and artifact identities with the release evidence.

For that check, set `OVERVIEW_TEST_DEB` to the retained exact package file and
`OVERVIEW_TEST_ARTIFACT_DIR` to the verified artifact directory containing
`lock.json`, `release.json` and `payload/`. The harness verifies the package SHA256
against the artifact's declared compatible host and records both identities.
Every run, including provisional runs, also requires an explicit acceptance row:

- `OVERVIEW_EXPECT_RUNTIME_VERSION`: the exact runtime version.
- `OVERVIEW_EXPECT_PACKAGE_SHA256`: the retained package's SHA256.
- `OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS`: `required` or `not-applicable`.

The current target is `0.15.2-workstation.2`, package SHA256
`f2b8f3e298347d7678a251f078eb16d5baf0bf8e3256b5cf2d371fb3798a74e5`,
with `OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS=required`. Missing or invalid inputs
fail before the daemon starts; a mismatching package hash or runtime version
fails acceptance.
The report records the expectation and the checks actually performed. A new
version label does not automatically skip chat coverage.

For example, after selecting the tested package's version and hash:

```bash
docker run --rm --init --user 1000:1000 --network none --shm-size 2g \
  --mount "type=bind,src=$OVERVIEW_FORK_CHECKOUT,dst=/fork,readonly" \
  --mount "type=bind,src=$OVERVIEW_BROWSER_CACHE,dst=/cache/playwright,readonly" \
  --mount "type=bind,src=$OVERVIEW_SOURCE,dst=/plugin-source,readonly" \
  --mount "type=bind,src=$OVERVIEW_TEST_DEB,dst=/inputs/package.deb,readonly" \
  --mount "type=bind,src=$OVERVIEW_TEST_ARTIFACT_DIR,dst=/artifact,readonly" \
  --env "OVERVIEW_EXPECT_RUNTIME_VERSION=$OVERVIEW_EXPECT_RUNTIME_VERSION" \
  --env "OVERVIEW_EXPECT_PACKAGE_SHA256=$OVERVIEW_EXPECT_PACKAGE_SHA256" \
  --env OVERVIEW_EXPECT_CHAT_PREVIEW_SETTINGS=required \
  --mount type=bind,src=/tmp/overview-v06,dst=/out \
  --mount type=bind,src=/usr/share/fonts,dst=/usr/share/fonts,readonly \
  --env XDG_CACHE_HOME=/tmp/cache \
  sha256:4af0a666444ca69a855eb0c7ff5ade27adb3dc6529644bc3a48ec588d153277c \
  bash /plugin-source/acceptance/package-container.sh
```

The script extracts the package into a temporary container directory and starts
an isolated daemon home with a fixture provider. It never reads or restarts the
workstation's running Paseo daemon. Before an artifact exists, omit the `/artifact`
mount to exercise the source checkout provisionally. Those results explicitly
say `provisionalHarnessOnly`; repeat with the final immutable artifact on the
current exact host declared in its compatibility lock.

A successful `required` run must include both `bounded Overview previews independent
of chat preferences` and `stock chat preview disable/enable and one-way expansion`
in `results.json`'s `checks`. The check turns the isolated browser setting off and
on, verifies full chat text and one-way expansion, and confirms Overview's own
preview remains bounded. Do not accept a provisional report as evidence for a
final artifact, or modify a completed artifact's lock to add a new host.

Keep completion evidence explicit: source-fixture success, final-artifact success,
hardware measurements and live visual acceptance are separate results. A report
must identify the exact source/artifact and host under test; software-rendered
frame timings do not establish real-GPU performance. The fixture's
`?performance=1` mode retains frame timestamps while skipping expensive diagnostic
scene traversal. Its background toggle compares the incremental grid draw cost
under the same animation load, rather than pretending to remove scheduler cost.

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
The on/off/on comparison retains the same foreground and scheduler: it measures
incremental background drawing overhead, not the cost of removing background
scheduling altogether. Pointer measurements include Playwright and event-loop
latency. Inspect the hardware screenshots as well as `performance-results.json`;
keep live deployed acceptance separate from this sanitised fixture.
