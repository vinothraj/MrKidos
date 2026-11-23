"use client";

import { useCallback, useEffect, useState } from "react";

export type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };

/**
 * Loads data when the component mounts and whenever `loader` changes, with cancellation.
 * `loader` MUST be stable (wrap it in useCallback with its real dependencies).
 * `reload()` fetches again without flashing the loading state, so lists stay on screen while they refresh.
 */
export function useLoad<T>(loader: () => Promise<T>): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    loader().then(
      (data) => {
        if (active) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [loader, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, reload };
}
