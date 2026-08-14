import { createContext, useContext } from "react";
import type { Transaction } from "./api";

// Lets any widget drill into a trace (modal) or a service (filtered list).
export const NavCtx = createContext<{
  openTrace: (t: Transaction) => void;
  openService: (name: string) => void;
}>({ openTrace: () => {}, openService: () => {} });
export const useNav = () => useContext(NavCtx);
