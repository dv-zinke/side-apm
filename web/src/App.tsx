import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionTable } from "./TransactionTable";
import { TraceTree } from "./TraceTree";
import type { Transaction } from "./api";

const qc = new QueryClient();

export default function App() {
  const [sel, setSel] = useState<Transaction | null>(null);
  return (
    <QueryClientProvider client={qc}>
      <div style={{ display: "flex", height: "100vh", background: "#111", color: "#ddd" }}>
        <div style={{ flex: 1, overflow: "auto", padding: 12, borderRight: "1px solid #333" }}>
          <h3>트레이스 분석</h3>
          <TransactionTable onSelect={setSel} />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          <h3>트리 뷰</h3>
          {sel ? <TraceTree traceId={sel.traceId} /> : <div>트랜잭션을 선택하세요</div>}
        </div>
      </div>
    </QueryClientProvider>
  );
}
