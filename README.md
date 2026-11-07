# Paseo Overview

A read-only view of workspace and agent activity, contributed as a separate
**Overview** page in Paseo. The existing workspace, chat and editor surfaces keep
their normal behaviour.

The browser shows one graph per workspace, using its current project icon.
Managed agents and known provider-native subagents appear beneath their owners.
Cross-workspace delegation has a separate dashed link. Activity produces bounded
heartbeats, travelling pulses and short-lived text bubbles.

Click a workspace or agent to bring its graph forward. Escape or the empty
background returns to the full view. The graph has no wheel zoom or orbit
controls; browser zoom remains available. **Pause motion** and the operating
system's reduced-motion preference stop animated effects. The phone and WebGL
fallback use workspace cards with the same ownership and status information.

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
failure signal. Reconnection reconciles current state without replaying old
activity bubbles.

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

## Development and packaging

Three.js and D3 hierarchy are ordinary locked production dependencies. Paseo's
existing compiler bundles them; the host supplies React, React Native, Zod and
the plugin SDK. The browser renderer loads behind a platform guard. There is no
separate website, renderer build step or native companion.

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` in the reviewed
plugin Docker builder. The TypeScript configurations separately check the
cross-platform screen, browser-only scene and server handlers. The tests cover
ownership, passive host reads, snapshot races, icon revisions, activity bounds,
stable layout and cleanup behaviour.

Managed workstation packaging uses lock schema 5 and recipe 1: signed source,
pinned Docker inputs, normal production dependencies and exact host validation.
Build, deploy, status and rollback use the existing `paseo-plugin.sh --plugin
overview` workflow. The plugin has no required persisted settings or companion.
The machine repository owns deployment locks and recovery instructions; completed
artifacts are immutable.

## Source layout

- `index.client.tsx`, `client/screen.tsx`, `client/native.tsx`: contributed UI.
- `client/transport.ts`, `store.ts`, `rosters.ts`, `icons.ts`: passive observation.
- `client/normalize.ts`: ownership and display model.
- `client/layout.ts`, `activity.ts`, `bubbles.ts`: stable layout and bounded effects.
- `client/web.ts`, `client/scene/`: browser rendering and accessible overlays.
- `index.server.ts`, `server/api.ts`, `shared/rpc.ts`: read-only host bridge.

No project icons, chat history, provider credentials or generated client bundles
are checked into this repository.
