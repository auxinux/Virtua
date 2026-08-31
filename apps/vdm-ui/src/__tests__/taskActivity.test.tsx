import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

let activity = { count: 1, lastFinishedAt: null as string | null };
let vmCalls = 0;

vi.mock("@/api/client", () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === "/api/vdm/tasks/active-count") return activity;
      if (path.startsWith("/api/vdm/vms")) { vmCalls += 1; return [{ name: `vm${vmCalls}` }]; }
      return [];
    }),
  },
}));

import { useTaskActivity } from "@/hooks/useTaskActivity";
import { api } from "@/api/client";

/** Mimics the sidebar: one per-node resource list plus the activity poll. */
function Probe() {
  const { count } = useTaskActivity();
  const vms = useQuery<Array<{ name: string }>>({
    queryKey: ["vdm-vms", "n1"],
    queryFn: () => api.get("/api/vdm/vms?node=n1"),
    staleTime: 30_000,
  });
  return <div>active:{count} list:{(vms.data ?? []).map((v) => v.name).join(",")}</div>;
}

function renderProbe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
}

describe("useTaskActivity", () => {
  beforeEach(() => { vmCalls = 0; activity = { count: 1, lastFinishedAt: null }; });

  it("exposes the active task count for the badge", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByText(/active:1/)).toBeTruthy());
  });

  it("refreshes resource lists when a task reaches a terminal state", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByText(/list:vm1/)).toBeTruthy());

    // A task finishes: the async creation is only visible now.
    activity = { count: 0, lastFinishedAt: "2026-08-31T12:00:00.000Z" };

    // The list must be refetched even though it is still within its staleTime.
    await waitFor(() => expect(screen.getByText(/list:vm2/)).toBeTruthy(), { timeout: 10_000 });
  }, 15_000);
});
