# Paseo Overview

> Developed and supported for the [workstation fork](https://github.com/alexhopeoconnor/paseo/tree/workstation).
> Build and install locally from reviewed source. Binary release assets are not published.

A read-only view of project, workspace and agent activity, contributed as a separate
**Overview** page in Paseo. The existing workspace, chat and editor surfaces keep
their normal behaviour.

Every live project on the selected host has its own graph, including empty
projects. The project uses its current icon and name; its actual workspaces,
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

In the browser full view, one procedural cyberspace grid replaces the former
background washes. It follows Paseo's effective theme, including explicit app
overrides: dark surfaces use cool luminous lines; light surfaces use muted slate
lines and darker blue highlights. Thin, antialiased perspective lines and sparse
travelling segments remain visibly present without camera motion, flashes or a
moving tunnel. The grid is decorative: its highlights never create activity,
bubbles or ownership pulses.

Every displayed project, including an empty project, contributes a bounded local
field after its current depth and focus transforms are applied. Recent unique
owned work brightens and gently bends nearby pattern coordinates; quiet working
agents retain only a small baseline. Project and workspace focus strengthen the
displayed branch while calming surrounding interiors. Existing graph depth,
ownership links and fibre pulses remain the primary activity presentation. The
field does not repack graphs, alter routes, hit targets or camera controls.

**Pause motion** freezes the grid phase and field presentation while live status
and readable previews continue. Reduced motion uses a static restrained grid;
hidden tabs and disconnected sessions schedule no ambient animation. Resize,
fullscreen, focus and theme changes can still redraw the static field. The grid
uses only the browser Three.js renderer, reuses a bounded typed-array field and
falls away independently if its shader cannot compile, leaving the graph usable.

Phones open a touch graph of collapsed project roots with live icons and activity
halos. Tap a project, then a workspace, to reveal its connected branches. The
header follows the current scope, with Back navigation and scoped counts. Agent
identity, selection and explicit inactive groups match desktop; details open in
the host modal. The native graph uses React Native views and animation, without
WebGL or speech bubbles. The same touch graph is available if browser graphics
are unavailable. **Pause motion**, backgrounding and reduced-motion preferences
stop animations while status remains readable.

## Observation and coverage

Overview reads the selected host's projects, workspaces and public agents,
including background workspaces. It observes current activity without fetching
chat history. It does not prompt, stop, archive, answer permissions, change
metadata or clear attention. **Open chat** deliberately navigates into the normal
Paseo chat screen, where that screen's usual behaviour applies.

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
depth, once-only pulse arrivals and the browser grid field. Activity and icon
updates preserve packed positions; ambient-only frames reuse their field without
layout or route work. Structural changes may expand an affected branch.

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
- `client/header.tsx`, `agent-details.tsx`, `presentation.ts`: shared interaction state.
- `client/native-layout.ts`, `native-node.tsx`, `native-motion.ts`: touch graph.
- `client/identity.ts`, `appearance.ts`, `collapse.ts`: shared visual policies.
- `client/transport.ts`, `store.ts`, `rosters.ts`, `icons.ts`: passive observation.
- `client/normalize.ts`: ownership and display model.
- `client/layout.ts`, `geometry.ts`, `routing.ts`: branch layout and validated paths.
- `client/activity.ts`, `assistant-preview.ts`, `event-preview.ts`, `bubbles.ts`, `status.ts`: activity and bounded previews.
- `client/web.ts`, `client/scene/`: browser rendering and accessible overlays.
- `index.server.ts`, `server/api.ts`, `shared/rpc.ts`: read-only host bridge.

No project icons, chat history, provider credentials or generated client bundles
are checked into this repository.
