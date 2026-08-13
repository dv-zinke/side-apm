import { createContext, useContext } from "react";
import type { Transaction } from "./api";

// Lets any live widget (heatmap, speed band) drill into a specific trace.
export const NavCtx = createContext<{ openTrace: (t: Transaction) => void }>({ openTrace: () => {} });
export const useNav = () => useContext(NavCtx);
