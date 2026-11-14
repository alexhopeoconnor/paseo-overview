# Overview

See where agents are working across your hosts, projects and workspaces.

Choose **All hosts** or one host, then use **Projects** to filter the graph.
Search and check multiple projects, then **Apply** to fit the selected set.
**Cancel**, Escape or dismissing the menu leaves the graph unchanged. **Show all**
includes projects discovered later. Apply with nothing checked to show no projects.
The menus open over the graph without reducing its available space.

Hidden projects stay in the picker and keep receiving status updates; showing
them again does not replay old bubbles or pulses. Empty projects and per-host
Unassigned areas can be selected. Duplicate names include their host. Offline
projects retain their last known state, and unavailable selections stay explicit
until removed. Changing hosts resets the project filter to All projects.
Filter and expansion choices stay in this client's plugin session.

Every selected project is a root with its current icon, including empty projects.
Actual workspaces, agents and available subagents branch beneath it. Dashed
connections show delegation without changing ownership.

Click a project or workspace to focus its graph. Agents use stable animal emoji
nodes: rounded tiles for workspace-level agents and smaller diamond backings for
subagents. Select one for a floating details card and a highlighted ownership
path. **Open chat** opens the normal Paseo chat on that agent's owning host. Escape or a
background click closes details first, then returns to the filtered overview. Arrow keys
navigate relationships; browser zoom works and the graph has no wheel zoom.

**Fullscreen graph** fills the display with Overview and its controls. Escape
exits fullscreen first, preserving graph focus, selection and expanded groups.
The button is available on supported browsers.

**N inactive** represents quiet subordinate branches, with finished, idle, closed
and canceled counts kept distinct. Click to expand and use
**Collapse N** on the parent to fold them again. The choice survives focus and
refreshes. Running agents, blockers, errors and unread results remain visible.
Counts include every represented agent.

Light trails follow fresh observed activity along ownership paths, with ancestor
responses on arrival. Quiet heartbeats also indicate reported working state.
Brief, nearby bubbles show bounded activity previews; long text has an ellipsis.
Streaming text is assembled into readable sentences or chunks, updated about once
a second, rather than displaying each token. Preview updates do not create work.

Unfocused projects rise proportionally with recent owned activity while quiet
neighbours recede modestly. Centres stay fixed, geometry limits growth and
inspection holds the graph steady. A perspective floor and back wall provide a
stable room behind the graphs. Soft geometric clouds drift behind active graphs
and gently bend the nearby grid. Small binary heads with longer light trails
follow grid lines across both surfaces. Activity feeds brighten their cloud on
arrival; a few decorative streams simply cross the grid. These effects never
create additional work or replay missed events.

**Appearance** offers Follow Paseo, Light or Dark for Overview, plus Animated,
Static or Off for the browser background. The full Appearance settings under
**Settings → Plugins → Overview** also control depth strength, activity response
and background speed. Preferences are saved on the Overview installation's host and shared across
clients; selecting another host does not change their owner.
A local theme choice does not change the rest of Paseo. Turning the background
off keeps graph animations available; turning depth off still permits focus.

**Pause motion** freezes all graph and background animation while status and
readable previews continue. Reduced motion uses a static background. Hidden tabs
and a view with no connected hosts stop background animation. If background rendering fails, it is
removed independently and the graph remains usable.

Phones use the same checkbox filter and start with the selected project roots. Tap into projects and workspaces,
use Back to return, and tap an agent for details. The header follows the current
scope. Animal identities, parent highlighting and group controls match desktop;
the phone graph omits speech bubbles.

Overview is read-only and never wakes a provider to discover native children.
Unavailable native rosters differ from known empty ones. Refresh retains the
last coherent graph while marking pending or stale information, then reconciles
authoritative updates. Returning to a tab does not replay historical activity.
Project names and icons update automatically.

Requires a compatible host with passive subagent and public project-icon APIs.
