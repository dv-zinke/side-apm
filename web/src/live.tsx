import { createContext, useContext, useEffect, useRef, useCallback } from "react";
import { liveTxnStream } from "./api";
import type { LiveTxn } from "./api";

// One shared SSE connection fanned out to every live widget, so the dashboard
// can show the speed band, heatmap and Apdex without opening 3 streams.
type Sub = (t: LiveTxn) => void;
const LiveCtx = createContext<{ subscribe: (cb: Sub) => () => void }>({ subscribe: () => () => {} });

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const subs = useRef<Set<Sub>>(new Set());
  useEffect(() => {
    const close = liveTxnStream((t) => { subs.current.forEach((cb) => cb(t)); });
    return close;
  }, []);
  const subscribe = useCallback((cb: Sub) => {
    subs.current.add(cb);
    return () => { subs.current.delete(cb); };
  }, []);
  return <LiveCtx.Provider value={{ subscribe }}>{children}</LiveCtx.Provider>;
}

export function useLiveTxns(cb: Sub) {
  const { subscribe } = useContext(LiveCtx);
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => subscribe((t) => ref.current(t)), [subscribe]);
}
