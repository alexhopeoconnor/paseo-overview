import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { OverviewHostState, OverviewHostSummary, OverviewModel } from "../shared/model";
import { unassignedScopeId, type OverviewPresentation, type OverviewScope } from "../shared/presentation";
import type { OverviewTheme } from "../shared/renderer";
import type { OverviewAppearance } from "../shared/settings";
import { hasError, needsInput } from "./status";
import { scopedNodes } from "./presentation";
import { buildOwnershipIndex } from "./normalize";

export interface OverviewHeaderProps {
  model: OverviewModel;
  presentation: OverviewPresentation;
  /** Complete configured-host list from useHosts; the model itself is filtered. */
  hostChoices: readonly OverviewHostSummary[];
  theme: OverviewTheme;
  compact: boolean;
  onHostFilter(hostId: string | null): void;
  onProject(scope: OverviewScope): void;
  onBack(): void;
  onMotion(): void;
  fullscreen?: { active: boolean; toggle(): void };
  /** Optional so existing fixture consumers keep their header without quick appearance. */
  appearance?: OverviewAppearance;
  appearanceDisabled?: boolean;
  appearanceError?: string;
  onAppearanceTheme?(theme: OverviewAppearance["theme"]): void;
  onAppearanceBackground?(background: OverviewAppearance["background"]): void;
  onOpenAppearanceSettings?(): void;
  onReloadAppearance?(): void;
}

const themeOptions: readonly { label: string; value: OverviewAppearance["theme"] }[] = [
  { label: "Follow Paseo", value: "paseo" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const backgroundOptions: readonly { label: string; value: OverviewAppearance["background"] }[] = [
  { label: "Animated", value: "animated" },
  { label: "Static", value: "static" },
  { label: "Off", value: "off" },
];

type OpenMenu = "host" | "project" | "appearance" | null;
type WebNode = {
  focus?(): void;
  contains?(node: unknown): boolean;
  querySelectorAll?(selector: string): ArrayLike<WebNode>;
  click?(): void;
};
type WebDocument = {
  activeElement?: unknown;
  addEventListener(type: string, listener: (event: WebEvent) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: WebEvent) => void, capture?: boolean): void;
};
type WebEvent = {
  key?: string;
  target?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
};
const asWebNode = (value: unknown): WebNode | null => value ? value as WebNode : null;
const menuItems = (menu: WebNode | null): WebNode[] => {
  const found = menu?.querySelectorAll?.('[role="menuitem"],[role="menuitemradio"],[role="radio"]');
  const items: WebNode[] = [];
  if (found) for (let index = 0; index < found.length; index++) items.push(found[index]!);
  return items;
};
const hostStatus = (host: OverviewHostState, choice?: OverviewHostSummary): string => {
  if (host.error) return "error";
  if (host.connection === "disconnected") return "offline";
  if (host.connection === "connecting" || choice?.status === "connecting") return "connecting";
  if (host.freshness === "stale") return "last known";
  if (host.freshness === "refreshing" || !Object.values(host.readiness).every(Boolean)) return "updating";
  return choice?.status === "online" ? "online" : "";
};

interface ToolbarButtonProps {
  theme: OverviewTheme; compact: boolean; testID: string; label: string; icon: string;
  text?: string; textTestID?: string; trailingIcon?: string; active?: boolean; disabled?: boolean;
  maxWidth?: number; onPress(): void;
}
const ToolbarButton = forwardRef<View, ToolbarButtonProps>(function ToolbarButton({
  theme, compact, testID, label, icon, text, textTestID, trailingIcon, active, disabled, maxWidth, onPress,
}, ref) {
  const [hover, setHover] = useState(false), [focused, setFocused] = useState(false), [pressed, setPressed] = useState(false);
  const emphasis = theme.selection ?? "#6264dc";
  return <Pressable ref={ref} testID={testID} tabIndex={0} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress}
    onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={[styles.toolbarControl, {
      minHeight: compact ? 44 : 36, minWidth: compact ? 44 : undefined, maxWidth,
      backgroundColor: pressed ? theme.background : hover ? theme.surface : "transparent",
      borderColor: focused ? emphasis : active ? theme.border : "transparent",
      opacity: disabled ? 0.5 : 1,
    }, pressed ? styles.controlPressed : null]}>
    <Icon name={icon} size={compact ? 19 : 16} color={theme.foreground} />
    {text ? <Text testID={textTestID} numberOfLines={1} ellipsizeMode="tail" style={[styles.toolbarText, { color: theme.foreground }]}>{text}</Text> : null}
    {trailingIcon ? <Icon name={trailingIcon} size={compact ? 16 : 14} color={theme.muted} /> : null}
  </Pressable>;
});

interface MenuChoiceProps {
  theme: OverviewTheme; compact: boolean; testID: string; label: string; detail?: string;
  selected?: boolean; checked?: boolean; role?: "menuitem" | "radio"; onPress(): void;
}
function MenuChoice({ theme, compact, testID, label, detail, selected, checked, role = "menuitem", onPress }: MenuChoiceProps) {
  const [hover, setHover] = useState(false), [pressed, setPressed] = useState(false);
  const emphasis = theme.selection ?? "#6264dc";
  return <Pressable testID={testID} tabIndex={0} accessibilityRole={role} accessibilityLabel={detail ? `${label}. ${detail}` : label}
    accessibilityState={role === "radio" ? { checked: !!checked } : { selected: !!selected }}
    aria-checked={role === "radio" ? !!checked : undefined} onPress={onPress}
    onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
    style={[styles.menuChoice, {
      minHeight: compact ? 44 : 36, backgroundColor: pressed || hover ? theme.background : "transparent",
    }]}>
    <View style={styles.menuChoiceText}>
      <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: theme.foreground, fontSize: 13 }}>{label}</Text>
      {detail ? <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: theme.muted, fontSize: 11 }}>{detail}</Text> : null}
    </View>
    {selected || checked ? <Icon name="Check" size={16} color={emphasis} /> : null}
  </Pressable>;
}

export function OverviewHeader({
  model, presentation, hostChoices, theme, compact, onHostFilter, onProject, onBack, onMotion, fullscreen,
  appearance, appearanceDisabled, appearanceError, onAppearanceTheme, onAppearanceBackground, onOpenAppearanceSettings, onReloadAppearance,
}: OverviewHeaderProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const hostTrigger = useRef<View | null>(null), projectTrigger = useRef<View | null>(null);
  const appearanceTrigger = useRef<View | null>(null), menu = useRef<View | null>(null);
  const { scope, motion } = presentation;
  const nodes = scopedNodes(model, scope);
  const current = nodes.filter(node => !node.freshness || node.freshness === "current");
  const working = current.filter(node => node.state === "working" && !hasError(node) && !needsInput(node)).length;
  const waiting = current.filter(node => !hasError(node) && needsInput(node)).length;
  const errors = current.filter(hasError).length;
  const unread = current.filter(node => node.attentionReason === "finished" && node.attention && node.state !== "working" && !hasError(node) && !needsInput(node)).length;
  const managed = nodes.filter(node => node.kind === "agent").length;
  const native = nodes.length - managed;
  const ownership = useMemo(() => buildOwnershipIndex(model), [model]);
  const workspace = scope?.kind === "workspace" ? model.workspaces.find(item => item.id === scope.id) : undefined;
  const project = scope?.kind === "project" ? model.projects.find(item => item.id === scope.id)
    : scope?.kind === "workspace" ? model.projects.find(item => item.id === workspace?.projectDisplayId) : undefined;
  const labelForHost = (hostId: string) => hostChoices.find(host => host.id === hostId)?.label
    ?? model.hosts.find(host => host.id === hostId)?.label ?? hostId;
  const projectLabel = scope?.kind === "unassigned" ? "Unassigned"
    : workspace ? `${project?.name ?? workspace.projectName} › ${workspace.name}`
      : project?.name ?? "All projects";
  const hostTriggerLabel = presentation.hostFilter ? labelForHost(presentation.hostFilter) : "All hosts";
  const workspaceCount = scope?.kind === "project" ? model.projects.find(item => item.id === scope.id)?.workspaceIds.length ?? 0 : model.workspaces.length;
  const counts = [!scope ? `${model.projects.length} projects` : "", scope?.kind !== "workspace" && scope?.kind !== "unassigned" ? `${workspaceCount} workspaces` : "", `${managed} agents`, native ? `${native} subagents` : ""].filter(Boolean).join(" · ");
  const selection = theme.selection ?? "#6264dc";
  const nodeStale = nodes.some(node => node.freshness === "stale");
  const nodeRefreshing = nodes.some(node => node.freshness === "refreshing");
  const hostIssues = model.hosts.flatMap(host => {
    const status = hostStatus(host, hostChoices.find(choice => choice.id === host.id));
    if (!status || status === "online") return [];
    return [{ id: host.id, label: host.label, status, tone: status === "error" ? theme.error : theme.waiting }];
  });
  const unassignedHosts = useMemo(() => model.hosts.filter(host =>
    model.workspaces.some(item => item.hostId === host.id && !ownership.projectByNode.has(item.id))
    || model.nodes.some(item => item.hostId === host.id && !ownership.projectByNode.has(item.id))).map(host => host.id), [model, ownership]);
  const projectChoices = useMemo(() => {
    const names = new Map<string, number>();
    for (const item of model.projects) names.set(item.name, (names.get(item.name) ?? 0) + 1);
    const choices: { key: string; label: string; scope: OverviewScope }[] = [{ key: "all", label: "All projects", scope: null }];
    for (const item of [...model.projects].sort((left, right) =>
      labelForHost(left.hostId).localeCompare(labelForHost(right.hostId)) || left.name.localeCompare(right.name))) {
      choices.push({ key: item.id, label: (names.get(item.name) ?? 0) > 1 ? `${item.name} — ${labelForHost(item.hostId)}` : item.name,
        scope: { kind: "project", id: item.id } });
    }
    for (const hostId of unassignedHosts) choices.push({
      key: unassignedScopeId(hostId), label: unassignedHosts.length > 1 ? `Unassigned — ${labelForHost(hostId)}` : "Unassigned",
      scope: { kind: "unassigned", id: unassignedScopeId(hostId) },
    });
    return choices;
  }, [model.projects, unassignedHosts, hostChoices, model.hosts]);

  const triggerFor = (target: OpenMenu) => target === "host" ? hostTrigger : target === "project" ? projectTrigger : appearanceTrigger;
  const focusTrigger = (target: OpenMenu) => {
    const node = asWebNode(triggerFor(target).current);
    node?.focus?.();
  };
  const closeMenu = (restoreFocus: boolean) => {
    const target = openMenu;
    setOpenMenu(null);
    if (restoreFocus && target) focusTrigger(target);
  };
  const chooseHost = (hostId: string | null) => {
    onHostFilter(hostId);
    setOpenMenu(null);
    if (!compact) focusTrigger("host");
  };
  const chooseProject = (next: OverviewScope) => {
    onProject(next);
    setOpenMenu(null);
    if (!compact) focusTrigger("project");
  };

  useLayoutEffect(() => {
    if (!openMenu || compact || Platform.OS !== "web") return;
    const items = menuItems(asWebNode(menu.current));
    items[0]?.focus?.();
  }, [openMenu, compact]);

  useEffect(() => {
    if (!openMenu || compact || Platform.OS !== "web") return;
    const doc = (globalThis as unknown as { document?: WebDocument }).document;
    if (!doc?.addEventListener) return;
    const panel = asWebNode(menu.current);
    const trigger = asWebNode(triggerFor(openMenu).current);
    const pointer = (event: WebEvent) => {
      if (panel?.contains?.(event.target) || trigger?.contains?.(event.target)) return;
      // The first outside press only dismisses the menu; it must not also
      // reset graph focus or selection underneath.
      event.preventDefault?.(); event.stopPropagation?.();
      setOpenMenu(null);
    };
    const key = (event: WebEvent) => {
      const name = event.key;
      if (name === "Escape") {
        event.preventDefault?.(); event.stopPropagation?.();
        setOpenMenu(null); trigger?.focus?.();
        return;
      }
      const items = menuItems(panel);
      if (!items.length) return;
      const active = doc.activeElement;
      const index = items.findIndex(item => item === active);
      if (name === "ArrowDown" || name === "ArrowUp" || name === "Home" || name === "End") {
        event.preventDefault?.();
        const next = name === "Home" ? 0 : name === "End" ? items.length - 1
          : name === "ArrowDown" ? (index + 1 + items.length) % items.length : (index - 1 + items.length) % items.length;
        items[next]?.focus?.();
        return;
      }
      if ((name === "Enter" || name === " " || name === "Spacebar") && index >= 0) {
        event.preventDefault?.(); event.stopPropagation?.(); items[index]?.click?.();
      }
    };
    doc.addEventListener("pointerdown", pointer, true);
    doc.addEventListener("keydown", key, true);
    return () => {
      doc.removeEventListener("pointerdown", pointer, true);
      doc.removeEventListener("keydown", key, true);
    };
  }, [openMenu, compact]);

  const appearancePanel = appearance ? <View testID="overview-appearance-panel"
    style={[compact ? styles.modalAppearance : [styles.menuPanel, styles.appearancePanel], { borderColor: theme.border, backgroundColor: theme.surface }]}>
    <View style={styles.appearanceGroup}>
      <Text style={[styles.appearanceLabel, { color: theme.muted }]}>Theme</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Theme" style={styles.appearanceOptions}>{themeOptions.map(option =>
        <Pressable key={option.value} testID={`overview-theme-${option.value}`} accessibilityRole="radio"
          accessibilityLabel={`Theme ${option.label}`} aria-checked={appearance.theme === option.value}
          accessibilityState={{ checked: appearance.theme === option.value, disabled: appearanceDisabled }}
          disabled={appearanceDisabled} onPress={() => onAppearanceTheme?.(option.value)}
          style={[styles.appearanceOption, { minWidth: 44, minHeight: compact ? 44 : 36,
            borderColor: appearance.theme === option.value ? selection : theme.border,
            backgroundColor: appearance.theme === option.value ? selection : "transparent" }]}>
          <Text style={{ color: appearance.theme === option.value ? theme.background : theme.foreground, fontSize: 12, fontWeight: appearance.theme === option.value ? "600" : "400" }}>{option.label}</Text>
        </Pressable>)}</View>
    </View>
    <View style={styles.appearanceGroup}>
      <Text style={[styles.appearanceLabel, { color: theme.muted }]}>Background</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Background" style={styles.appearanceOptions}>{backgroundOptions.map(option =>
        <Pressable key={option.value} testID={`overview-background-${option.value}`} accessibilityRole="radio"
          accessibilityLabel={`Background ${option.label}`} aria-checked={appearance.background === option.value}
          accessibilityState={{ checked: appearance.background === option.value, disabled: appearanceDisabled }}
          disabled={appearanceDisabled} onPress={() => onAppearanceBackground?.(option.value)}
          style={[styles.appearanceOption, { minWidth: 44, minHeight: compact ? 44 : 36,
            borderColor: appearance.background === option.value ? selection : theme.border,
            backgroundColor: appearance.background === option.value ? selection : "transparent" }]}>
          <Text style={{ color: appearance.background === option.value ? theme.background : theme.foreground, fontSize: 12, fontWeight: appearance.background === option.value ? "600" : "400" }}>{option.label}</Text>
        </Pressable>)}</View>
    </View>
    <View style={styles.appearanceFooter}>
      {onOpenAppearanceSettings ? <Pressable testID="overview-open-appearance-settings" accessibilityRole="button" onPress={onOpenAppearanceSettings} style={styles.appearanceAction}>
        <Text style={{ color: selection, fontSize: 12, fontWeight: "600" }}>Appearance settings →</Text>
      </Pressable> : null}
      {appearanceError && onReloadAppearance ? <Pressable testID="overview-reload-appearance" accessibilityRole="button" onPress={onReloadAppearance} style={styles.appearanceAction}>
        <Text style={{ color: theme.waiting, fontSize: 12 }}>Reload</Text>
      </Pressable> : null}
    </View>
    {appearanceError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.waiting, fontSize: 11, lineHeight: 15 }}>{appearanceError}</Text>
      : appearanceDisabled ? <Text style={{ color: theme.muted, fontSize: 11, lineHeight: 15 }}>Loading or saving appearance…</Text> : null}
  </View> : null;

  const hostRows = [
    <MenuChoice key="all" theme={theme} compact={compact} testID="overview-host-option-all" label="All hosts"
      selected={!presentation.hostFilter} onPress={() => chooseHost(null)} />,
    ...hostChoices.map(choice => {
      const state = model.hosts.find(host => host.id === choice.id);
      return <MenuChoice key={choice.id} theme={theme} compact={compact} testID={`overview-host-option-${choice.id}`}
        label={choice.label} detail={state ? hostStatus(state, choice) : choice.status}
        selected={presentation.hostFilter === choice.id} onPress={() => chooseHost(choice.id)} />;
    }),
  ];
  const projectRows = projectChoices.map(choice => <MenuChoice key={choice.key} theme={theme} compact={compact}
    testID={`overview-project-option-${choice.key}`}
    label={choice.label} selected={choice.key === "all" ? !scope : choice.scope?.kind === "unassigned"
      ? scope?.kind === "unassigned" && scope.id === choice.scope.id : choice.key === project?.id}
    onPress={() => chooseProject(choice.scope)} />);

  return <View testID="overview-header" style={[styles.header, { borderBottomColor: theme.border, paddingHorizontal: compact ? 10 : 16 }]}>
    <View style={[styles.toolbar, { minHeight: compact ? 44 : 40 }]}>
      {scope ? <ToolbarButton theme={theme} compact={compact} testID="overview-back" label={scope.kind === "workspace" ? "Back to project" : "All projects"} icon="ChevronLeft" onPress={onBack} /> : null}
      <View style={styles.dropdownAnchor}>
        <ToolbarButton ref={hostTrigger} theme={theme} compact={compact} testID="overview-host-filter" label={`Host: ${hostTriggerLabel}${hostIssues.length ? `. ${hostIssues.map(issue => `${issue.label} ${issue.status}`).join(", ")}` : ""}`}
          icon="Server" text={hostTriggerLabel} trailingIcon="ChevronDown" maxWidth={compact ? 96 : 220}
          active={openMenu === "host"} onPress={() => setOpenMenu(open => open === "host" ? null : "host")} />
        {!compact && openMenu === "host" ? <View ref={menu} testID="overview-host-menu"
          style={[styles.menuPanel, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled">{hostRows}</ScrollView>
        </View> : null}
      </View>
      <View style={[styles.dropdownAnchor, styles.projectAnchor]}>
        <ToolbarButton ref={projectTrigger} theme={theme} compact={compact} testID="overview-project-filter" label={`Project: ${projectLabel}`}
          icon="Folder" text={projectLabel} textTestID="overview-scope-title" trailingIcon="ChevronDown"
          maxWidth={compact ? 160 : 280} active={openMenu === "project"} onPress={() => setOpenMenu(open => open === "project" ? null : "project")} />
        {!compact && openMenu === "project" ? <View ref={menu} testID="overview-project-menu"
          style={[styles.menuPanel, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled">{projectRows}</ScrollView>
        </View> : null}
      </View>
      <View style={styles.spacer} />
      <ToolbarButton theme={theme} compact={compact} testID="overview-motion" label={motion ? "Pause animation" : "Resume animation"}
        icon={motion ? "Pause" : "Play"} text={compact ? undefined : motion ? "Pause" : "Resume"} active={!motion} onPress={onMotion} />
      {appearance ? <View style={styles.dropdownAnchor}>
        <ToolbarButton ref={appearanceTrigger} theme={theme} compact={compact} testID="overview-appearance" label="Quick appearance"
          icon="Palette" text={compact ? undefined : "Appearance"} active={openMenu === "appearance"}
          onPress={() => setOpenMenu(open => open === "appearance" ? null : "appearance")} />
        {!compact && openMenu === "appearance" ? <View ref={menu} style={styles.appearanceAnchor}>{appearancePanel}</View> : null}
      </View> : null}
      {fullscreen ? <ToolbarButton theme={theme} compact={compact} testID="overview-fullscreen"
        label={fullscreen.active ? "Exit fullscreen" : "Fullscreen graph"} icon={fullscreen.active ? "Minimize" : "Maximize"}
        text={compact ? undefined : fullscreen.active ? "Exit" : "Fullscreen"} active={fullscreen.active} onPress={fullscreen.toggle} /> : null}
    </View>
    <View testID="overview-status" style={styles.metaRow}>
      <Text testID="overview-scope-counts" style={[styles.counts, { color: theme.muted }]}>{counts}</Text>
      <Text style={[styles.status, { color: working ? theme.working : theme.muted }]}>● {working} working</Text>
      {waiting ? <Text style={[styles.status, { color: theme.waiting }]}>◆ {waiting} waiting</Text> : null}
      {errors ? <Text style={[styles.status, { color: theme.error }]}>! {errors} error{errors === 1 ? "" : "s"}</Text> : null}
      {unread ? <Text style={[styles.status, { color: theme.accent }]}>○ {unread} unread</Text> : null}
      {nodeStale ? <Text style={[styles.status, { color: theme.muted }]}>Some status unavailable · last known state</Text>
        : nodeRefreshing ? <Text style={[styles.status, { color: theme.muted }]}>Updating…</Text> : null}
      {hostIssues.map(issue => <Text key={issue.id} testID={`overview-host-status:${issue.id}`}
        style={[styles.status, { color: issue.tone }]}>{issue.label}: {issue.status}</Text>)}
    </View>
    {compact && openMenu === "host" ? <Modal title="Choose host" open onOpenChange={open => { if (!open) setOpenMenu(null); }}>
      <Modal.Content scrollable contentContainerStyle={styles.modalContent}>{hostRows}</Modal.Content>
    </Modal> : null}
    {compact && openMenu === "project" ? <Modal title="Choose project" open onOpenChange={open => { if (!open) setOpenMenu(null); }}>
      <Modal.Content scrollable contentContainerStyle={styles.modalContent}>{projectRows}</Modal.Content>
    </Modal> : null}
    {compact && openMenu === "appearance" && appearance ? <Modal title="Appearance" open onOpenChange={open => { if (!open) setOpenMenu(null); }}>
      <Modal.Content scrollable={false} contentContainerStyle={styles.modalContent}>{appearancePanel}</Modal.Content>
    </Modal> : null}
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingTop: 4, paddingBottom: 5, gap: 3, borderBottomWidth: 1, zIndex: 30 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6 },
  toolbarControl: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, flexShrink: 1 },
  toolbarText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  controlPressed: { transform: [{ scale: 0.97 }] },
  dropdownAnchor: { position: "relative" },
  projectAnchor: { flexShrink: 1, minWidth: 0 },
  spacer: { flex: 1, minWidth: 4 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 1, paddingHorizontal: 2 },
  breadcrumb: { fontSize: 11, lineHeight: 15, flexShrink: 1, maxWidth: "100%" },
  counts: { fontSize: 11, lineHeight: 15 },
  status: { fontSize: 11, lineHeight: 15 },
  menuPanel: { position: "absolute", top: 40, left: 0, width: 264, maxWidth: 320, borderWidth: 1, borderRadius: 12,
    paddingVertical: 4, zIndex: 60, elevation: 12, boxShadow: "0 12px 32px #00000022" },
  menuScroll: { maxHeight: 320 },
  menuChoice: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 4, paddingHorizontal: 9, borderRadius: 8 },
  menuChoiceText: { flex: 1, minWidth: 0, gap: 1 },
  appearanceAnchor: { position: "absolute", top: 40, right: 0, zIndex: 60 },
  appearancePanel: { position: "relative", top: 0, left: 0, width: 300, padding: 10, gap: 9, borderWidth: 1, borderRadius: 12,
    elevation: 12, boxShadow: "0 12px 32px #00000022" },
  modalAppearance: { padding: 2, gap: 9 },
  modalContent: { paddingVertical: 4, gap: 1 },
  appearanceGroup: { gap: 5 },
  appearanceLabel: { fontSize: 9, fontWeight: "600", letterSpacing: 0.7 },
  appearanceOptions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  appearanceOption: { paddingHorizontal: 12, borderWidth: 1, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  appearanceFooter: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  appearanceAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
});
