# Overview

See where agents are working across your projects and workspaces.

Every live project is a root with its current icon, including empty projects.
Actual workspaces, agents and available subagents branch beneath it. Dashed
connections show delegation without changing ownership.

Click a project or workspace to focus its graph. Agents use stable animal emoji
nodes: rounded tiles for workspace-level agents and smaller diamond backings for
subagents. Select one for a floating details card and a highlighted ownership
path. **Open chat** deliberately returns to the normal Paseo chat. Escape or a
background click closes details first, then returns to the full view. Arrow keys
navigate relationships; browser zoom works and the graph has no wheel zoom.

**N inactive** represents quiet subordinate branches. Click to expand and use
the parent's collapse control to fold them again. The choice survives focus and
refreshes. Running agents, blockers, errors and unread results remain visible.
Counts include every represented agent.

Light trails follow fresh observed activity along ownership paths, with ancestor
responses on arrival. Quiet heartbeats also indicate reported working state.
Brief, nearby bubbles show bounded activity previews; long text has an ellipsis.
Use **Pause motion** when desired. Reduced motion preserves static status.

Phones start with collapsed project roots. Tap into projects and workspaces,
use Back to return, and tap an agent for details. The header follows the current
scope. Animal identities, parent highlighting and group controls match desktop;
the phone graph omits speech bubbles.

Overview is read-only and never wakes a provider to discover native children.
Unavailable native rosters differ from known empty ones. Refresh retains the
last coherent graph while marking pending or stale information, then reconciles
authoritative updates. Returning to a tab does not replay historical activity.
Project names and icons update automatically.

Requires a compatible host with passive subagent and public project-icon APIs.
