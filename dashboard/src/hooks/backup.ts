import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { BackupExportResponse, BackupImportResponse } from "../data/contracts";
import type { DeleteAllScope } from "../../../src/console/backup/store";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Backup/restore hooks.
 *
 * Both operations re-authenticate the operator's console password on the
 * server, so the password travels with the request rather than being cached
 * anywhere client-side. Export returns the payload as JSON; the page hands it
 * to the download helper, because it is a file the operator keeps rather than a
 * value the app reads back.
 *
 * Restore does not need a hook of its own to decide what the file is: the
 * server detects a native backup from a router export by shape, so the
 * dashboard hands the parsed file over and renders the report it gets back.
 */
export function useExportBackup() {
  return useMutation<BackupExportResponse, ApiErrorShape, { password: string; sections?: string; format?: "native" | "9router" }>({
    mutationFn: ({ password, sections, format }) => {
      const query = new URLSearchParams({ password });
      if (sections !== undefined && sections.length > 0) query.set("sections", sections);
      // `native` is the server default; only send the param when asking for 9router.
      if (format === "9router") query.set("format", "9router");
      return consoleRequest<BackupExportResponse>(`/backup/export?${query.toString()}`);
    },
  });
}

export interface AutoBackupStatus {
  readonly enabled: boolean;
  readonly botTokenMasked: string | null;
  readonly chatId: string | null;
  readonly intervalHours: number;
  readonly lastSentAt: string | null;
  readonly lastError: string | null;
}

export function useAutoBackupStatus() {
  return {
    get: () => consoleRequest<AutoBackupStatus>("/backup/auto-backup"),
    update: (password: string, patch: { enabled?: boolean; botToken?: string; chatId?: string; intervalHours?: number }) =>
      consoleRequest<AutoBackupStatus>("/backup/auto-backup", {
        method: "PATCH",
        body: JSON.stringify({ password, ...patch }),
      }),
    runNow: (password: string) =>
      consoleRequest<{ sent: boolean; error?: string }>("/backup/auto-backup/run", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
  };
}

/**
 * Restores a backup file.
 *
 * A successful restore rewrites configuration, so every cached read of it is
 * invalidated rather than left serving the pre-restore state.
 */
export interface DeleteAllResponse {
  readonly deleted: Record<string, number>;
}

export function useDeleteAllBackup() {
  const queryClient = useQueryClient();
  return useMutation<DeleteAllResponse, ApiErrorShape, { password: string; scopes: readonly DeleteAllScope[] }>({
    mutationFn: ({ password, scopes }) =>
      consoleRequest<DeleteAllResponse>("/backup/delete-all", {
        method: "POST",
        body: JSON.stringify({ password, scopes }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}

export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation<BackupImportResponse, ApiErrorShape, { password: string; backup: unknown }>({
    mutationFn: ({ password, backup }) =>
      consoleRequest<BackupImportResponse>("/backup/import", {
        method: "POST",
        body: JSON.stringify({ password, backup }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}
