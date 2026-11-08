import { Animated, Easing, Platform } from "react-native";
import { useEffect, useMemo, useRef } from "react";
import { identityHash } from "./identity";

/** A phase clock keeps rate changes from restarting every node at the same beat. */
export function useNativeHeartbeat(id: string, running: boolean, workingCount: number) {
  const phase = useRef(new Animated.Value(identityHash(id) / 0x1_0000_0000)).current;
  const period = Math.round(60_000 / (36 + Math.min(48, Math.max(0, workingCount) * 8)));
  useEffect(() => {
    let alive = true;
    let animation: Animated.CompositeAnimation | undefined;
    phase.stopAnimation(current => {
      if (!alive || !running) return;
      const cycle = (start: number) => {
        if (!alive) return;
        const position = Number.isFinite(start) ? Math.max(0, Math.min(0.9999, start)) : 0;
        phase.setValue(position);
        animation = Animated.timing(phase, {
          toValue: 1,
          duration: Math.max(1, Math.round((1 - position) * period)),
          easing: Easing.linear,
          useNativeDriver: Platform.OS !== "web",
          isInteraction: false,
        });
        animation.start(({ finished }) => { if (alive && finished) cycle(0); });
      };
      cycle(current);
    });
    return () => { alive = false; animation?.stop(); phase.stopAnimation(); };
  }, [phase, running, period]);
  return useMemo(() => ({
    opacity: running ? phase.interpolate({ inputRange: [0, 0.11, 0.22, 0.29, 0.42, 1], outputRange: [0.025, 0.24, 0.05, 0.15, 0.025, 0.025] }) : 0,
    transform: [{ scale: phase.interpolate({ inputRange: [0, 0.11, 0.22, 0.29, 0.42, 1], outputRange: [1, 1.12, 1.02, 1.07, 1, 1] }) }],
  }), [phase, running]);
}
