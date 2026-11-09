# Overview acceptance runners

These runners exercise the real renderer and native components with sanitised
fixtures. They supplement the focused Vitest tests. Fixture project names,
messages and IDs are synthetic; do not copy real chat or roster data here.

- `renderer.cjs` bundles the real Three.js renderer and checks delayed loading,
  ownership roles, animal identities, explicit groups, selected ancestors,
  background framing, visibility restoration, bounded bubbles and disposal. It
  also observes real depth transforms, fixed centres, pulse continuity, ambient
  pixels and the low-rate idle scheduler, with pause/visibility/reduced-motion
  checks. Instrumentation stays in the fixture, outside the product bundle.
- `native-preview.cjs` renders the actual native graph and shared header through
  React Native Web at a phone viewport, with touch and a device pixel ratio of 2.
  It checks scope/count agreement, avatars, groups, 44-pixel collapse controls and
  initial primary-agent framing.
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
- `packaged.cjs` exercises the same immutable plugin on each exact supported host
  package, including additive streaming previews, actual element fullscreen,
  preserved selection/expansion, explicit exit and navigation cleanup. Fullscreen
  tests use a real user click and inspect `document.fullscreenElement`; controller
  mocks alone are not fullscreen acceptance.

Browser screenshots and JSON results go under `/out` in the container, or the
path selected by `OVERVIEW_ACCEPTANCE_OUTPUT`. Keep outputs outside Git. Chromium
uses software rendering for these checks, so its timings do not establish GPU
performance on a user's workstation. Native Web rendering and mocked component
checks do not substitute for an actual paired-phone check.

Use the existing pinned build environment. Set `OVERVIEW_FORK_CHECKOUT` to its
prepared Paseo source with installed build dependencies, `OVERVIEW_SOURCE` to this
checkout, and `OVERVIEW_BROWSER_CACHE` to its Playwright cache. Evidence goes in
`/tmp/overview-v05` in this example:

```bash
mkdir -p /tmp/overview-v05

docker run --rm --init --user 1000:1000 --network none --shm-size 2g \
  --mount "type=bind,src=$OVERVIEW_FORK_CHECKOUT,dst=/fork,readonly" \
  --mount "type=bind,src=$OVERVIEW_BROWSER_CACHE,dst=/cache/playwright,readonly" \
  --mount "type=bind,src=$OVERVIEW_SOURCE,dst=/plugin,readonly" \
  --mount type=bind,src=/tmp/overview-v05,dst=/out \
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

Use `required` for hosts with configurable chat previews, including `alex.10`
and neutral workstation releases. Use `not-applicable` only for a reviewed host
without the setting, such as `alex.9`. Missing or invalid inputs fail before the
daemon starts; a mismatching package hash or runtime version fails acceptance.
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
  --mount type=bind,src=/tmp/overview-v05,dst=/out \
  --mount type=bind,src=/usr/share/fonts,dst=/usr/share/fonts,readonly \
  --env XDG_CACHE_HOME=/tmp/cache \
  sha256:4af0a666444ca69a855eb0c7ff5ade27adb3dc6529644bc3a48ec588d153277c \
  bash /plugin-source/acceptance/package-container.sh
```

The script extracts the package into a temporary container directory and starts
an isolated daemon home with a fixture provider. It never reads or restarts the
workstation's running Paseo daemon. Before an artifact exists, omit the `/artifact`
mount to exercise the source checkout provisionally. Those results explicitly
say `provisionalHarnessOnly`; repeat with the final immutable artifact on every
host package declared in its compatibility lock.

A successful `required` run must include both `bounded Overview previews independent
of chat preferences` and `stock chat preview disable/enable and one-way expansion`
in `results.json`'s `checks`. The check turns the isolated browser setting off and
on, verifies full chat text and one-way expansion, and confirms Overview's own
preview remains bounded. Do not accept a provisional report as evidence for a
final artifact, or modify a completed artifact's lock to add a new host.
