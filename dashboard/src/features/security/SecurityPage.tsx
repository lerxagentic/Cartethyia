import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  RefreshCw,
  Ban,
  Unlock,
  AlertTriangle,
  Activity,
  Globe,
  Radio,
  Filter,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  useSecurityOverview,
  useSecurityEvents,
  useBanIp,
  useUnbanIp,
} from "../../hooks/security";
import { toast } from "../../shared/toast";
import { getErrorMessage } from "../../shared/helpers";

export default function SecurityPage(): ReactNode {
  const [tab, setTab] = useState<"monitor" | "overview" | "bans">("monitor");
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(true);

  // Modal ban state
  const [banTargetIp, setBanTargetIp] = useState<string | null>(null);
  const [banReason] = useState("Suspicious unauthorized requests");
  const [banDuration] = useState("1440"); // 24 hours

  const overviewQuery = useSecurityOverview();
  const eventsQuery = useSecurityEvents({ errorsOnly, search, limit: 100 });

  const banMutation = useBanIp();
  const unbanMutation = useUnbanIp();

  const handleConfirmBan = async () => {
    if (!banTargetIp) return;
    try {
      await banMutation.mutateAsync({
        ip: banTargetIp,
        reason: banReason,
        durationMinutes: Number(banDuration) || 1440,
      });
      toast.success("IP Banned", `${banTargetIp} has been locked out.`);
      setBanTargetIp(null);
    } catch (e) {
      toast.error("Ban Failed", getErrorMessage(e));
    }
  };

  const handleUnban = async (ip: string) => {
    try {
      await unbanMutation.mutateAsync(ip);
      toast.success("IP Unbanned", `${ip} lockout lifted.`);
    } catch (e) {
      toast.error("Unban Failed", getErrorMessage(e));
    }
  };

  const overview = overviewQuery.data;
  const events = eventsQuery.data?.events ?? [];

  return (
    <div className="space-y-6" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Top Banner & Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "14px",
        }}
      >
        <Card>
          <CardBody style={{ padding: "16px", display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                color: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Globe size={20} />
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600 }}>
                UNIQUE CLIENT IPS
              </div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--text-primary)" }}>
                {overview?.topIps.length ?? 0}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody style={{ padding: "16px", display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "color-mix(in srgb, var(--red) 15%, transparent)",
                color: "var(--red)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AlertTriangle size={20} />
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600 }}>
                SUSPICIOUS ANOMALIES (7D)
              </div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--red)" }}>
                {overview?.suspiciousEvents.length ?? 0}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody style={{ padding: "16px", display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "color-mix(in srgb, var(--orange) 15%, transparent)",
                color: "var(--orange)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ShieldX size={20} />
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600 }}>
                ACTIVE BANNED IPS
              </div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "var(--orange)" }}>
                {overview?.activeBans.length ?? 0}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody style={{ padding: "16px", display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                background: "color-mix(in srgb, var(--teal) 15%, transparent)",
                color: "var(--teal)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <ShieldCheck size={20} />
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", fontWeight: 600 }}>
                SECURITY ENFORCEMENT
              </div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--teal)" }}>
                STRIKES & LOCKOUT ON
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Tabs & Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          <Button
            variant={tab === "monitor" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setTab("monitor")}
            icon={<Radio size={14} />}
          >
            Live Activity Monitor
          </Button>
          <Button
            variant={tab === "overview" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setTab("overview")}
            icon={<Activity size={14} />}
          >
            IP & User-Agent Threats
          </Button>
          <Button
            variant={tab === "bans" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setTab("bans")}
            icon={<Ban size={14} />}
          >
            Active Banned List ({overview?.activeBans.length ?? 0})
          </Button>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void eventsQuery.refetch();
              void overviewQuery.refetch();
            }}
            icon={<RefreshCw size={13} className={eventsQuery.isFetching ? "animate-spin" : ""} />}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Tab 1: Live Monitor */}
      {tab === "monitor" && (
        <Card>
          <CardHeader
            title="Real-time Incoming Requests & Threats"
            subtitle="Tracks Client IP, User-Agent, target endpoint, and rejection status."
            icon={<ShieldAlert size={16} />}
            action={
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <Button
                  variant={errorsOnly ? "danger" : "secondary"}
                  size="sm"
                  onClick={() => setErrorsOnly(!errorsOnly)}
                  icon={<Filter size={13} />}
                >
                  {errorsOnly ? "Showing: Errors / Blocked Only" : "Showing: All Traffic"}
                </Button>
                <div style={{ width: "240px" }}>
                  <Input
                    placeholder="Search IP, UA, endpoint..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
            }
          />
          <CardBody style={{ padding: 0 }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--inner-border)", background: "var(--surface-2)" }}>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>TIME</th>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>CLIENT IP</th>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>STATUS</th>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>ENDPOINT</th>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>USER AGENT</th>
                    <th style={{ padding: "10px 14px", color: "var(--text-secondary)", fontWeight: 600 }}>ANOMALY / ORIGIN</th>
                    <th style={{ padding: "10px 14px", textAlign: "right", color: "var(--text-secondary)", fontWeight: 600 }}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "30px", textAlign: "center", color: "var(--text-tertiary)" }}>
                        No suspicious security events detected.
                      </td>
                    </tr>
                  ) : (
                    events.map((ev) => {
                      const isError = (ev.http_status ?? 0) >= 400;
                      const isBlocked = ev.http_status === 401 || ev.http_status === 403;
                      return (
                        <tr
                          key={ev.id}
                          style={{
                            borderBottom: "1px solid var(--inner-border)",
                            background: isBlocked ? "color-mix(in srgb, var(--red) 5%, transparent)" : "transparent",
                          }}
                        >
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap", color: "var(--text-tertiary)" }}>
                            {new Date(ev.created_at).toLocaleTimeString([], { hour12: false })}
                          </td>
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap", fontWeight: 600 }}>
                            <span
                              style={{
                                color: isBlocked ? "var(--red)" : "var(--text-primary)",
                                fontFamily: "monospace",
                              }}
                            >
                              {ev.client_ip ?? "unknown"}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                            <span
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 700,
                                background: isError
                                  ? "color-mix(in srgb, var(--red) 15%, transparent)"
                                  : "color-mix(in srgb, var(--teal) 15%, transparent)",
                                color: isError ? "var(--red)" : "var(--teal)",
                              }}
                            >
                              {ev.http_status ?? ev.status}
                            </span>
                          </td>
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap", color: "var(--text-secondary)" }}>
                            <code>{ev.endpoint ?? "-"}</code>
                          </td>
                          <td
                            style={{
                              padding: "10px 14px",
                              maxWidth: "280px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              color: "var(--text-secondary)",
                            }}
                            title={ev.user_agent ?? ""}
                          >
                            {ev.user_agent ?? "-"}
                          </td>
                          <td style={{ padding: "10px 14px", color: isError ? "var(--red)" : "var(--text-tertiary)" }}>
                            {ev.error_category ?? ev.error_origin ?? "-"}
                          </td>
                          <td style={{ padding: "10px 14px", textAlign: "right" }}>
                            {ev.client_ip && ev.client_ip !== "127.0.0.1" && ev.client_ip !== "::1" && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setBanTargetIp(ev.client_ip)}
                                icon={<Ban size={12} />}
                              >
                                Ban IP
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Tab 2: IP & UA Threats */}
      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(450px, 1fr))", gap: "20px" }}>
          {/* Top IPs */}
          <Card>
            <CardHeader title="Top Active & Probe IP Addresses" subtitle="Volume & failure rate analysis per IP" />
            <CardBody style={{ padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--inner-border)", background: "var(--surface-2)" }}>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>IP</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>TOTAL</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>ERRORS</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>LAST SEEN</th>
                    <th style={{ padding: "10px 14px", textAlign: "right" }}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {overview?.topIps.map((row) => (
                    <tr key={row.ip} style={{ borderBottom: "1px solid var(--inner-border)" }}>
                      <td style={{ padding: "10px 14px", fontWeight: 600, fontFamily: "monospace" }}>{row.ip}</td>
                      <td style={{ padding: "10px 14px" }}>{row.total_requests}</td>
                      <td style={{ padding: "10px 14px", color: row.error_requests > 0 ? "var(--red)" : "inherit" }}>
                        {row.error_requests}
                      </td>
                      <td style={{ padding: "10px 14px", color: "var(--text-tertiary)" }}>
                        {new Date(row.last_seen).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "10px 14px", textAlign: "right" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setBanTargetIp(row.ip)}
                          icon={<Ban size={12} />}
                        >
                          Ban
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>

          {/* Top User Agents */}
          <Card>
            <CardHeader title="User-Agent Signatures" subtitle="Frequent client tooling and web scrapers" />
            <CardBody style={{ padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--inner-border)", background: "var(--surface-2)" }}>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>USER AGENT</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>REQUESTS</th>
                    <th style={{ padding: "10px 14px", textAlign: "left" }}>ERRORS</th>
                  </tr>
                </thead>
                <tbody>
                  {overview?.topUserAgents.map((ua, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid var(--inner-border)" }}>
                      <td
                        style={{
                          padding: "10px 14px",
                          maxWidth: "260px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={ua.user_agent}
                      >
                        <code>{ua.user_agent}</code>
                      </td>
                      <td style={{ padding: "10px 14px" }}>{ua.total_requests}</td>
                      <td style={{ padding: "10px 14px", color: ua.error_requests > 0 ? "var(--red)" : "inherit" }}>
                        {ua.error_requests}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Tab 3: Active Bans */}
      {tab === "bans" && (
        <Card>
          <CardHeader
            title="Actively Banned / Locked-out IP Addresses"
            subtitle="IP addresses restricted from accessing the gateway or console"
            icon={<ShieldX size={16} />}
          />
          <CardBody style={{ padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--inner-border)", background: "var(--surface-2)" }}>
                  <th style={{ padding: "10px 14px", textAlign: "left" }}>IP ADDRESS</th>
                  <th style={{ padding: "10px 14px", textAlign: "left" }}>BAN REASON</th>
                  <th style={{ padding: "10px 14px", textAlign: "left" }}>EXPIRES AT</th>
                  <th style={{ padding: "10px 14px", textAlign: "right" }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {!overview?.activeBans.length ? (
                  <tr>
                    <td colSpan={4} style={{ padding: "30px", textAlign: "center", color: "var(--text-tertiary)" }}>
                      No active bans recorded. Gateway is clear.
                    </td>
                  </tr>
                ) : (
                  overview.activeBans.map((ban, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid var(--inner-border)" }}>
                      <td style={{ padding: "10px 14px", fontWeight: 700, fontFamily: "monospace", color: "var(--red)" }}>
                        {ban.ip}
                      </td>
                      <td style={{ padding: "10px 14px" }}>{ban.reason}</td>
                      <td style={{ padding: "10px 14px", color: "var(--text-tertiary)" }}>
                        {ban.expiresAt ? new Date(ban.expiresAt).toLocaleString() : "Permanent / Manual"}
                      </td>
                      <td style={{ padding: "10px 14px", textAlign: "right" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleUnban(ban.ip)}
                          icon={<Unlock size={12} />}
                        >
                          Unban
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Confirm Ban Dialog */}
      <ConfirmDialog
        open={banTargetIp !== null}
        onClose={() => setBanTargetIp(null)}
        onConfirm={handleConfirmBan}
        title={`Lockout & Ban IP: ${banTargetIp}`}
        message={`Are you sure you want to block all incoming requests from ${banTargetIp}? This prevents the client from accessing the router.`}
        confirmLabel="Ban IP Now"
        danger
      />
    </div>
  );
}
