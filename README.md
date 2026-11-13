# Paseo Overview

> Developed and supported for the [workstation fork](https://github.com/alexhopeoconnor/paseo/tree/workstation).
> Build and install locally from reviewed source. Binary release assets are not published.

A read-only view of project, workspace and agent activity, contributed as a separate
**Overview** page in Paseo. The existing workspace, chat and editor surfaces keep
their normal behaviour.

Every project on the included hosts has its own graph, including empty
projects. **All hosts** and **All projects** are the defaults; use the toolbar
selectors to narrow the view. Hosts with unavailable data remain listed with
their connection state, and duplicate project names include their host. The project uses its current icon and name; its actual workspaces,
managed agents and known provider-native subagents branch beneath it. Project
membership is automatic and follows Paseo IDs, not directory nesting or a fixed
selection. Ownership routes avoid unrelated nodes and labels. Cross-workspace
delegation has a separate dashed route. Activity produces bounded heartbeats,
travelling pulses and short-lived text bubbles.

Click a project or workspace to bring its graph or branch forward. Each agent's
animal emoji is its node, assigned consistently from its host-qualified ID.
Workspace-level agents use rounded tiles; subordinate agents use smaller diamond
backings. Their identity stays the same when their title or status changes.
A delegated agent stays in its owning workspace and has a separate link.

Selecting an agent opens a compact floating details card without resizing the
graph. Its node, ancestors and ownership path receive a blue selection treatment,
separate from green working activity. Hover or keyboard focus previews the path;
arrow keys move between parents, children and siblings. Escape or a background
click closes details first; another returns to the full view. The graph has no
wheel zoom or orbit controls; browser zoom remains available.

**Fullscreen graph** expands the Overview container, including its header,
bubbles and details, while leaving the surrounding Paseo navigation outside it.
The existing graph stays mounted. **Exit fullscreen** or Escape restores the
normal view with selection, focus and expansion intact. While fullscreen is
active, Escape exits it first. The control is shown only on supported browsers.

Quiet subordinate branches appear as **N inactive**. Click the count to expand;
use **Collapse N** on the owner to fold them again. Preferences survive focus,
tab suspension and reopening Overview during the same plugin session. Working,
waiting, failed, unknown and attention-bearing agents remain visible, as do
selected nodes and delegation endpoints. Groups explain their finished, idle,
closed and canceled composition and preserve original membership and activity totals.

Fresh observed events produce bounded light trails along ownership connections.
Their arrival highlights each ancestor once. A quiet heartbeat also indicates
reported working state; it is not a claim that new output arrived. Events are
coalesced to keep bursts readable. Short nearby bubbles show bounded commands,
paths or message excerpts with explicit truncation. These limits are independent
of Paseo's long-response chat setting. Selection does not create activity.

Assistant text fragments are joined before formatting. Bubbles prefer complete
sentences, paragraphs or lines, with a paced word-boundary fallback for continuous
output. They show at most 240 graphemes and update about once a second; tiny
unfinished fragments do not replace readable text. Storage is bounded, final
excerpts accompany turn completion, and preview publication never adds activity.

The browser graph floats in front of a procedural room with a perspective floor
and back wall. Soft particle clouds drift behind the graphs, with their sparse
connecting lines following the same particles. Active clouds gently bend the
grid behind them. Small binary heads and fading light trails follow that same
surface, including the floor/wall seam. Fresh activity admits a bounded feed
to a grid junction behind its cloud; arrival briefly brightens the cloud. A few
decorative streams also cross the room without a cloud destination. These are
visual summaries and decoration, not byte counters. They never add activity
scores or replay missed events. Quiet and empty projects remain visible.

The graph and room share one resolved depth projection. Recent owned activity
brings a graph forward while quieter neighbours recede modestly. Packing reserves
space for growth; viewport edges, readable text and delegation corridors can
reduce its range. Centres stay fixed, and hover or inspection holds movement.
Project/workspace focus is explicit and still works when automatic depth is off.
Selection, ownership links, labels and attention badges stay in the foreground.

Use **Appearance** for quick theme/background choices, or open **Settings →
Plugins → Overview → Appearance** for the full controls:

- **Theme:** Follow Paseo, Light or Dark. The override affects Overview only;
  Follow Paseo uses the application's effective theme, including custom themes.
- **Background:** Animated, Static or Off. Turning it off leaves graph activity
  animations available.
- **Depth:** Off, Subtle, Balanced or Strong, always within safe geometric limits.
- **Response:** Relaxed, Balanced or Responsive activity-depth changes.
- **Background speed:** Slow, Normal or Fast without changing observed activity.

These appearance preferences are saved on the host where Overview is installed
and shared by its clients. Filtering to another host does not change the settings
owner. They update the existing view without losing focus, selection or group choices.
The phone graph uses the theme and compact controls; the spatial background and
its speed/depth settings apply to the browser graph.

The current Paseo host remounts screen contents when its application/system theme
changes. Overview restores presentation choices, but icons and subagent rosters
briefly reload with that new screen. Overview's own Light/Dark controls update the
existing renderer without that host-level remount.

**Pause motion** is a temporary master control: it freezes graph and background
animation while live status and readable previews continue. Reduced motion uses
a static background. Hidden tabs and a view with no connected hosts schedule no
background animation. A disconnected host retains its last coherent graph and
frozen cloud while other hosts continue; returning does not replay missed feeds. Theme, resize and explicit
navigation can still redraw. Background rendering shares the graph's WebGL
renderer and fails independently, leaving the graph usable if a shader fails.

Phones open a touch graph of collapsed project roots with live icons and activity
halos. Tap a project, then a workspace, to reveal its connected branches. The
header follows the current scope, with Back navigation and scoped counts. Agent
identity, selection and explicit inactive groups match desktop; details open in
the host modal. The native graph uses React Native views and animation, without
WebGL or speech bubbles. The same touch graph is available if browser graphics
are unavailable. **Pause motion**, backgrounding and reduced-motion preferences
stop animations while status remains readable.

## Observation and coverage

Overview borrows the application's existing APIs for the included configured
hosts and reads their projects, workspaces and public agents, including background
workspaces. It opens no additional host connections. Each host owns an independent
observation store and freshness state; one slow or offline host does not block the
others. Project references, native identities and events are host-qualified.
Cross-host delegation is shown only when explicit parent metadata and both
known endpoints are available; ownership and activity totals remain local. It observes current activity without fetching
chat history. It does not prompt, stop, archive, answer permissions, change
metadata or clear attention. **Open chat** deliberately navigates into the normal
Paseo chat screen on the agent's owning host, where that screen's usual behaviour applies.

Native subagent coverage is the daemon's known resident roster. An unloaded
parent is labelled unavailable, rather than shown as an empty known roster.
Overview never creates, resumes or loads a provider session to fill that gap.
Quiet working agents retain their reported status; elapsed silence is not a
failure signal. Suspension retains the last coherent children, icons, selection
and expansion. Resumption reconciles fresh passive snapshots without briefly
removing branches or replaying old activity. Pending reads say **Updating**;
failed reads retain **Last known** information. Confirmed empty/nonresident
snapshots and removals still replace the prior state truthfully.

## Host requirements

The plugin uses the public plugin SDK and two maintained host additions:

- `paseo.projects.getIcon(projectId)` returning the effective project icon.
- `paseo.agents.ref(id).providerSubagents.snapshot()` returning a passive roster,
  its availability and a generation/revision cursor.

The snapshot host advertises `providerSubagentSnapshots`. Descriptor updates
carry their cursor, and historical hydration updates carry `replayed: true`.
An older native client's parser may omit new optional fields; cursor-less
updates invalidate the snapshot instead of being treated as an ordered stream.

The broad manifest SDK requirement does not assert that an unmodified stock
host provides these additions. The managed deployment lock records exact tested
host distribution, source revision and package hash. Missing APIs remain visible
as coverage errors; there is no fallback to an operation that loads an agent.

## Installation

Follow the fork's
[pinned local installation instructions](https://github.com/alexhopeoconnor/paseo/tree/workstation#optional-workstation-plugins).
They select an exact source commit, install locked production dependencies in Docker
and register the prepared directory with `paseo plugin add /absolute/plugin/directory`.
A direct Git-source installation does not prepare those dependencies. Keep the
registered directory in place and use a separate directory for each reviewed update.
No private infrastructure repository or shared artifact registry is required.

## Development and packaging

Three.js, D3 hierarchy and Floating UI DOM are locked production dependencies. Paseo's
existing compiler bundles them; the host supplies React, React Native, Zod and
the plugin SDK. The browser renderer loads behind a platform guard. There is no
separate website, renderer build step or native companion.

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` in the reviewed
plugin Docker builder. The TypeScript configurations separately check the
cross-platform screen, browser-only scene and server handlers. The tests cover
ownership, passive host reads, snapshot races, icon revisions, activity bounds,
empty-to-populated loading, suspension, stable identity, explicit grouping,
branch layout, routed geometry, preview assembly, fullscreen ownership, bounded
depth, once-only pulse/feed arrivals, persisted appearance, multi-host isolation
and room projection. Activity and icon updates preserve packed positions.
Heartbeat-only frames reuse node presentation, routes and activity aggregation;
unchanged overlay properties are not rewritten. Cloud particle motion runs in
GPU shaders from cached offsets and per-project state. Background-only frames
reuse their field without layout or route work. Structural changes may expand an affected branch.

An optional managed workstation installation uses lock schema 5 and recipe 1: signed source,
pinned Docker inputs, normal production dependencies and exact host validation.
Build, deploy, status and rollback use the existing `paseo-plugin.sh --plugin
overview` workflow. The plugin has no required persisted settings or companion.
The machine repository owns deployment locks and recovery instructions; completed
artifacts are immutable.

Compatible rendering updates reload only this plugin on the existing host.
Retain the previous artifact for rollback and use the ordinary application backup
schedule. They do not require a host/Codium cutover or additional full backups.
Artifact integrity and visual acceptance are verified separately.

Reusable compiled browser, native-component and exact-package checks live in
[`acceptance/`](acceptance/README.md). Run them in the pinned build environment;
fixtures are sanitised and evidence stays outside Git. Native JavaScript and Hermes checks guard the browser/native boundary. Repeat
physical-phone acceptance when native behaviour changes or a native regression
is found; browser-only rendering changes do not add an unrelated device gate.

## Source layout

- `index.client.tsx`, `client/screen.tsx`, `client/native.tsx`: contributed UI.
- `client/header.tsx`, `agent-details.tsx`, `presentation.ts`: toolbar and shared interaction state.
- `client/native-layout.ts`, `native-node.tsx`, `native-motion.ts`: touch graph.
- `client/identity.ts`, `appearance.ts`, `collapse.ts`: shared visual policies.
- `client/hosts.ts`, `host-api.ts`, `transport.ts`, `store.ts`, `rosters.ts`, `icons.ts`: independent passive host observation.
- `shared/hosts.ts`, `shared/model.ts`: host-qualified composition and freshness contracts.
- `client/normalize.ts`: ownership and display model.
- `client/layout.ts`, `geometry.ts`, `routing.ts`: branch layout and validated paths.
- `client/activity.ts`, `assistant-preview.ts`, `event-preview.ts`, `bubbles.ts`, `status.ts`: activity and bounded previews.
- `client/web.ts`, `client/scene/`: browser rendering and accessible overlays.
- `index.server.ts`, `server/api.ts`, `shared/rpc.ts`: read-only host bridge.

No project icons, chat history, provider credentials or generated client bundles
are checked into this repository.
