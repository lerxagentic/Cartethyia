import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../data/api";

export interface SecurityIpSummary {
  readonly ip: string;
  readonly total_requests: number;
  readonly error_requests: number;
  readonly blocked_requests: number;
  readonly last_seen: string;
  readonly sample_user_agent?: string;
}

export interface SecurityEventItem {
  readonly id: string;
  readonly created_at: string;
  readonly client_ip: string | null;
  readonly user_agent: string | null;
  readonly endpoint: string | null;
  readonly requested_model?: string | null;
  readonly http_status: number | null;
  readonly latency_ms?: number | null;
  readonly error_category?: string | null;
  readonly error_origin?: string | null;
  readonly status: string | null;
}

export interface SecurityActiveBan {
  readonly ip: string;
  readonly expiresAt?: string | number;
  readonly reason?: string;
}

export interface SecurityUserAgentSummary {
  readonly user_agent: string;
  readonly total_requests: number;
  readonly error_requests: number;
  readonly last_seen: string;
}

export interface SecurityOverviewData {
  readonly topIps: readonly SecurityIpSummary[];
  readonly suspiciousEvents: readonly SecurityEventItem[];
  readonly activeBans: readonly SecurityActiveBan[];
  readonly topUserAgents: readonly SecurityUserAgentSummary[];
}

export function useSecurityOverview() {
  return useQuery({
    queryKey: ["console", "security", "overview"],
    queryFn: () => consoleRequest<SecurityOverviewData>("/security/overview"),
    refetchInterval: 10_000,
  });
}

export function useSecurityEvents(params: { errorsOnly: boolean; search: string; limit?: number }) {
  return useQuery({
    queryKey: ["console", "security", "events", params.errorsOnly, params.search, params.limit],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.errorsOnly) q.set("errorsOnly", "true");
      if (params.search) q.set("search", params.search);
      if (params.limit) q.set("limit", String(params.limit));
      return consoleRequest<{ events: readonly SecurityEventItem[] }>(`/security/events?${q.toString()}`);
    },
    refetchInterval: 6_000,
  });
}

export function useBanIp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ip: string; reason?: string; durationMinutes?: number }) =>
      consoleRequest<{ success: boolean; bannedUntil: string }>("/security/ban", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["console", "security"] });
    },
  });
}

export function useUnbanIp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ip: string) =>
      consoleRequest<{ success: boolean }>("/security/ban", {
        method: "DELETE",
        body: JSON.stringify({ ip }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["console", "security"] });
    },
  });
}
