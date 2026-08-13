import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionTable } from "./TransactionTable";
import { TraceTree } from "./TraceTree";
import { RecordSummary } from "./RecordSummary";
import { RedDashboard } from "./RedDashboard";
import { ServiceMap } from "./ServiceMap";
import { XView } from "./XView";
import type { Transaction } from "./api";

const qc = new QueryClient();

export default function App() {
  const [sel, setSel] = useState<Transaction | null>(null);
  const [tab, setTab] = useState<"trace" | "red" | "map" | "xview">("trace");
  return (
    <QueryClientProvider client={qc}>
      <div style={{ height: "100vh", background: "#111", color: "#ddd", display: "flex", flexDirection: "column" }}>
        <nav style={{ display: "flex", gap: 16, padding: "8px 12px", borderBottom: "1px solid #333" }}>
          <a onClick={() => setTab("trace")} style={{ cursor: "pointer", color: tab === "trace" ? "#fff" : "#888" }}>트레이스 분석</a>
          <a onClick={() => setTab("red")} style={{ cursor: "pointer", color: tab === "red" ? "#fff" : "#888" }}>RED 대시보드</a>
          <a onClick={() => setTab("map")} style={{ cursor: "pointer", color: tab === "map" ? "#fff" : "#888" }}>서비스맵</a>
          <a onClick={() => setTab("xview")} style={{ cursor: "pointer", color: tab === "xview" ? "#fff" : "#888" }}>X-View</a>
        </nav>
        {tab === "map" ? (
          <ServiceMap />
        ) : tab === "xview" ? (
          <XView />
        ) : tab === "red" ? (
          <RedDashboard />
        ) : (
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            <div style={{ flex: 1, overflow: "auto", padding: 12, borderRight: "1px solid #333" }}>
              <TransactionTable onSelect={setSel} />
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
              {sel ? (
                <>
                  <h4>레코드 요약</h4>
                  <RecordSummary traceId={sel.traceId} />
                  <h4 style={{ marginTop: 16 }}>트리 뷰</h4>
                  <TraceTree traceId={sel.traceId} />
                </>
              ) : <div>트랜잭션을 선택하세요</div>}
            </div>
          </div>
        )}
      </div>
    </QueryClientProvider>
  );
}
