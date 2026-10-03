import { createContext, useContext } from "react";
import type { Transaction } from "./api";

// Lets any widget drill into a trace (modal), a service (filtered list), or
// jump to another view by id.
export const NavCtx = createContext<{
  openTrace: (t: Transaction) => void;
  openService: (name: string) => void;
  setView: (id: string) => void;
}>({ openTrace: () => {}, openService: () => {}, setView: () => {} });
export const useNav = () => useContext(NavCtx);
