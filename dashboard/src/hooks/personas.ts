import { consoleRequest, isRecord } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { PersonaView } from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { querySignal } from "./common";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface PersonaListResult {
  readonly items: readonly PersonaView[];
  readonly activeId: string | null;
}

function assertPersonaList(value: unknown): PersonaListResult {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw { status: 500, code: "invalid_response", message: "Invalid persona list response" } satisfies ApiErrorShape;
  }
  const activeId = value.activeId;
  return {
    items: value.items as PersonaView[],
    activeId: typeof activeId === "string" && activeId.length > 0 ? activeId : null,
  };
}

export interface PersonaInput {
  readonly name: string;
  readonly description?: string;
  readonly content: string;
}

/** Lists saved personas and which one is active. */
export function usePersonas() {
  return useQuery({
    queryKey: queryKeys.personas.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/personas", { signal: querySignal(context) }).then(assertPersonaList),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

function invalidatePersonas(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.personas.all });
}

export function useCreatePersona() {
  const queryClient = useQueryClient();
  return useMutation<PersonaView, ApiErrorShape, PersonaInput>({
    mutationFn: (input) =>
      consoleRequest<PersonaView>("/personas", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidatePersonas(queryClient),
  });
}

export function useUpdatePersona() {
  const queryClient = useQueryClient();
  return useMutation<PersonaView, ApiErrorShape, PersonaInput & { id: string }>({
    mutationFn: ({ id, ...input }) =>
      consoleRequest<PersonaView>(`/personas/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidatePersonas(queryClient),
  });
}

export function useDeletePersona() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiErrorShape, string>({
    mutationFn: (id) =>
      consoleRequest<unknown>(`/personas/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidatePersonas(queryClient),
  });
}

/** Activates a persona (or clears the active one with `null`). */
export function useActivatePersona() {
  const queryClient = useQueryClient();
  return useMutation<{ activeId: string | null }, ApiErrorShape, string | null>({
    mutationFn: (personaId) =>
      consoleRequest<{ activeId: string | null }>("/personas/active", {
        method: "PUT",
        body: JSON.stringify({ personaId }),
      }),
    onSuccess: () => invalidatePersonas(queryClient),
  });
}
