import type { QuotaWindow } from "../hooks/quota";

export interface FreeAccess {
  /** The plan name as the provider reported it, e.g. "Free Plan Subscription". */
  readonly plan: string;
  /** Farthest date free access is known to run to, ISO 8601. */
  readonly until: string | null;
  /**
   * True when `until` is a recurring reset (a monthly allowance rolling over)
   * rather than a hard expiry. The two read very differently to an operator: a
   * reset means "still free after this date", an expiry means "not free after".
   */
  readonly recurring: boolean;
  /** True when every free window has been used up. */
  readonly exhausted: boolean;
  /** Highest remaining percentage across the free windows, for a compact badge. */
  readonly remainingPercent: number | null;
}

/** Whether a provider plan name describes a free tier. */
function isFreePlan(plan: string | null | undefined): plan is string {
  if (typeof plan !== "string") return false;
  return /\bfree\b/i.test(plan);
}

/**
 * Derives the free-tier badge for one account's quota.
 *
 * Returns null for a paid plan, so a caller can render nothing rather than a
 * misleading "Free" label on a pay-per-use account.
 *
 * The subtlety this exists to handle: a free tier is usually reported as *two*
 * kinds of window, and they mean different things.
 *
 * - A **recurring** window ("Monthly", `recurring: true`) is an allowance that
 *   refills. Its `resetsAt` is not an end date — the account is still free
 *   afterwards. Labelling that "free until" would be wrong.
 * - A **non-recurring** window ("Bonus Pack", `recurring: false`) is a grant
 *   with a real deadline. That date *is* an end date.
 *
 * So a hard expiry is preferred when one exists, and a recurring window is only
 * used as a fallback (reported with `recurring: true` so the UI can say "resets"
 * instead of "until"). Windows that are already spent are ignored, because a
 * date on an exhausted grant is not a date the operator can still use.
 */
export function freeAccessFromQuota(
  quota: { readonly plan: string | null; readonly windows: readonly QuotaWindow[] } | null | undefined,
): FreeAccess | null {
  if (!quota || !isFreePlan(quota.plan)) return null;
  const plan = quota.plan;
  const windows = quota.windows ?? [];

  /** A window still has value when it is not fully consumed. */
  const hasRemaining = (window: QuotaWindow): boolean => {
    if (typeof window.remainingPercent === "number") return window.remainingPercent > 0;
    if (typeof window.remaining === "number") return window.remaining > 0;
    // No percentage or absolute figure: treat a dated window as still usable
    // rather than hiding it, since the provider did report a live grant.
    return window.resetsAt !== null;
  };

  const usable = windows.filter(hasRemaining);
  // No windows at all is not the same as "all spent": the provider reported a
  // free plan but no window detail, so the honest state is unknown. Saying
  // "exhausted" would claim the quota is gone when it may be untouched, and
  // saying "usable" would imply a date we do not have. `until: null` with
  // `exhausted: false` renders the bare "Free plan" badge, which is all that
  // is actually known.
  if (windows.length === 0) {
    return { plan, until: null, recurring: false, exhausted: false, remainingPercent: null };
  }
  if (usable.length === 0) {
    return { plan, until: null, recurring: false, exhausted: true, remainingPercent: 0 };
  }

  const dateOf = (window: QuotaWindow): number => {
    const ms = window.resetsAt ? new Date(window.resetsAt).getTime() : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };

  // A hard expiry outranks a recurring reset: it is the date access actually
  // ends, which is what "free until" means.
  const expiries = usable.filter((window) => window.recurring === false && window.resetsAt !== null);
  const pool = expiries.length > 0 ? expiries : usable.filter((window) => window.resetsAt !== null);
  const chosen = pool.reduce<QuotaWindow | null>(
    (best, window) => (best === null || dateOf(window) > dateOf(best) ? window : best),
    null,
  );

  const percents = usable
    .map((window) => window.remainingPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    plan,
    until: chosen?.resetsAt ?? null,
    // Only a fallback (non-expiry) window is recurring; an expiry is not.
    recurring: chosen !== null && chosen.recurring !== false,
    exhausted: false,
    remainingPercent: percents.length > 0 ? Math.max(...percents) : null,
  };
}

/** Compact badge text for a free tier, or null when there is nothing to show. */
export function freeAccessBadge(access: FreeAccess | null): string | null {
  if (!access) return null;
  if (access.exhausted) return "Free quota used";
  if (!access.until) return "Free plan";
  const date = new Date(access.until);
  if (!Number.isFinite(date.getTime())) return "Free plan";
  const formatted = date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return access.recurring ? `Free · resets ${formatted}` : `Free until ${formatted}`;
}

/** Models proven to consume 0 credits on CodeBuddy / WorkBuddy */
const BUDDY_FREE_MODELS = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-sg",
  "auto",
  "hy3",
  "hy4-preview-f",
  "gemini-2.5-flash-image",
  "gemini-3.0-pro-image",
  "gemini-3.1-flash-image",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5v-turbo",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7",
  "minimax-m3",
]);

/** Returns badge text for a model that does not deduct credits/quota, or null if paid. */
export function modelFreeBadge(
  providerId: string,
  modelId: string,
  access: FreeAccess | null,
  quotaWindows?: readonly QuotaWindow[] | null,
): { label: string; tooltip: string } | null {
  const normProv = providerId.toLowerCase();
  const isBuddy = normProv === "cb" || normProv === "workbuddy" || normProv === "cbcn";

  if (isBuddy) {
    if (BUDDY_FREE_MODELS.has(modelId)) {
      // Prioritaskan reset cycle bulanan (misal 31 Okt 2026) jika ada,
      // fallback ke access.until
      const monthlyWindow = quotaWindows?.find((w) => w.label.toLowerCase() === "monthly");
      const targetDateStr = monthlyWindow?.resetsAt ?? access?.until ?? null;
      const untilDate = targetDateStr ? new Date(targetDateStr) : null;
      const formatted =
        untilDate && Number.isFinite(untilDate.getTime())
          ? untilDate.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
          : null;

      const label = formatted ? `FREE until ${formatted}` : "FREE (0 credit)";
      const tooltip = formatted
        ? `Model ini gratis (0 credit) dan tidak memotong kuota paket hingga ${formatted}`
        : "Model ini gratis (0 credit) dan tidak memotong kuota paket";
      return { label, tooltip };
    }
    // Paid buddy model
    return null;
  }

  // Non-buddy: fallback to plan-level badge if free
  if (access) {
    const label = freeAccessBadge(access);
    if (!label) return null;
    return {
      label,
      tooltip: `${access.plan}${
        access.remainingPercent !== null ? ` · ${Math.round(access.remainingPercent)}% remaining` : ""
      }`,
    };
  }

  return null;
}

export interface QuotaBarTone {
  bar: string;
  text: string;
}

export function formatResetDistance(value: string | null, recurring = true): string {
  if (!value) return "";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return recurring ? "Resetting soon" : "Expired";
  const prefix = recurring ? "Resets in" : "Expires in";
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${prefix} ${totalMinutes}mins`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${prefix} ${totalHours}h${minutes > 0 ? ` ${minutes}mins` : ""}`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const suffix = `${hours > 0 ? ` ${hours}h` : ""}${minutes > 0 ? ` ${minutes}mins` : ""}`;
  if (totalDays >= 365) {
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    return `${prefix} ${years}y${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  if (totalDays >= 30) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    return `${prefix} ${months}mo${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  return `${prefix} ${totalDays}d${suffix}`;
}

export function formatQuotaWindowLabel(label: string): string {
  const match = /^(\d+)\s*hour$/i.exec(label.trim());
  if (!match) return label;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return label;
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours === 720) return "Monthly";
  if (hours === 8760) return "Yearly";
  // The guard must test the value that is actually emitted. The day remainder is
  // `Math.floor(remainder / 24)`, a whole number of DAYS, so testing the raw hour
  // remainder emitted a "0d" suffix for any remainder in 1..23 hours — a day count
  // that reads as "less than a day", the opposite of a window just past a month.
  if (hours >= 8760) {
    const days = Math.floor((hours % 8760) / 24);
    return `${Math.floor(hours / 8760)}y${days > 0 ? ` ${days}d` : ""}`;
  }
  if (hours >= 720) {
    const days = Math.floor((hours % 720) / 24);
    return `${Math.floor(hours / 720)}mo${days > 0 ? ` ${days}d` : ""}`;
  }
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`;
  return `${hours}h`;
}

export function formatQuotaRefresh(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Last refreshed: ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
    : "";
}

export function friendlyQuotaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("invalidated") ||
    lower.includes("reauthorization") ||
    lower.includes("refresh token revoked")
  )
    return "OAuth account invalidated — re-login required";
  // Collectorless providers never refresh, so this backend string should no
  // longer surface — but a stale cached error may still carry it. Keep the
  // mapping as a safety net, not a state the UI can reach fresh.
  if (lower.includes("endpoint is not available") || lower === "not available")
    return "Quota tracking is not supported for this provider";
  if (lower.includes("overloaded") || lower.includes("capacity") || lower.includes("temporarily unavailable"))
    return "Provider capacity unavailable — retry after the indicated time";
  if (lower.includes("usage limit") || lower.includes("quota") || lower.includes("rate limit"))
    return "Quota exhausted or rate limited — wait for reset";
  if (lower.includes("http 500") || lower.includes("internal server error"))
    return "Provider temporarily unavailable — retry in a moment";
  if (lower.includes("http 429") || lower.includes("too many requests"))
    return "Rate limited — slow down requests";
  if (lower.includes("http 401") || lower.includes("unauthorized") || lower.includes("invalid"))
    return "Credential expired — re-login or refresh token";
  if (lower.includes("http 403") || lower.includes("forbidden"))
    return "Access denied — check account permissions";
  if (lower.includes("http 402") || lower.includes("payment"))
    return "Payment required — top up account balance";
  if (lower.includes("connect") || lower.includes("network") || lower.includes("timeout"))
    return "Network error — check connection and retry";
  return "Provider error — inspect account health details";
}

export function quotaBarTone(remaining: number | null): QuotaBarTone {
  if (remaining === null) return { bar: "var(--text-tertiary)", text: "var(--text-tertiary)" };
  if (remaining < 20) return { bar: "var(--red)", text: "var(--red)" };
  if (remaining < 50) return { bar: "var(--orange)", text: "var(--orange)" };
  return { bar: "var(--green)", text: "var(--green)" };
}

/** Maximum quota windows shown together in an account card. */
export const QUOTA_WINDOWS_PER_PAGE = 4;

/** Returns a bounded quota-window slice and the normalized page position. */
export function paginateQuotaWindows<T>(
  windows: readonly T[],
  requestedPage: number,
): {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly startIndex: number;
} {
  const pageCount = Math.ceil(windows.length / QUOTA_WINDOWS_PER_PAGE);
  const lastPage = Math.max(0, pageCount - 1);
  const safeRequestedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, safeRequestedPage), lastPage);
  const startIndex = page * QUOTA_WINDOWS_PER_PAGE;
  return {
    items: windows.slice(startIndex, startIndex + QUOTA_WINDOWS_PER_PAGE),
    page,
    pageCount,
    startIndex,
  };
}

export interface AccountIdentity {
  readonly primary: string;
  readonly secondary: string | null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isTokenHint(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("sk-") || value.startsWith("…");
}

export function displayAccountHint(hint: string, name: string): string {
  if (hint.startsWith("eyJ") || hint === "—") return name;
  return hint;
}

/** Credential-kind labels are categories, not identities — never displayed. */
const NON_IDENTITY_HINTS: ReadonlySet<string> = new Set(["oauth", "api_key", "none"]);

export function accountIdentity(hint: string, name: string): AccountIdentity {
  const fallbackName = name.trim() || "Unnamed account";
  const normalizedHint = displayAccountHint(hint, fallbackName).trim();
  const usableHint =
    normalizedHint && normalizedHint !== "—" && !NON_IDENTITY_HINTS.has(normalizedHint.toLowerCase())
      ? normalizedHint
      : null;
  const email =
    [usableHint, fallbackName].find((value): value is string => value !== null && isEmail(value)) ??
    null;
  if (email !== null) {
    const secondary =
      [fallbackName, usableHint].find(
        (value): value is string => value !== null && value !== email && !isTokenHint(value),
      ) ?? null;
    return { primary: email, secondary };
  }
  const secondary =
    usableHint !== null && usableHint !== fallbackName && !isTokenHint(usableHint)
      ? usableHint
      : null;
  return { primary: fallbackName, secondary };
}
