import { useEffect, useMemo, useState } from "react";
import { UserRound, Trash2, Check, Pencil, Star } from "lucide-react";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/page-header";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
import {
  usePersonas,
  useCreatePersona,
  useUpdatePersona,
  useDeletePersona,
  useActivatePersona,
} from "../hooks/personas";
import type { PersonaView } from "../data/contracts";

interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: "", description: "", content: "" };

/**
 * Custom Personas — a library of operator-authored system prompts.
 *
 * Exactly one persona is active at a time. When one is active the router
 * REPLACES every caller's system prompt with it, so the model follows the
 * router's instruction rather than the client's (a coding agent's own prompt
 * would otherwise win). The UI states that plainly because it is destructive
 * to the caller's prompt by design.
 */
export default function Personas(): React.ReactNode {
  const personas = usePersonas();
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const deletePersona = useDeletePersona();
  const activatePersona = useActivatePersona();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] = useState<PersonaView | null>(null);

  const items = personas.data?.items ?? [];
  const activeId = personas.data?.activeId ?? null;
  const activePersona = useMemo(
    () => items.find((persona) => persona.id === activeId) ?? null,
    [items, activeId],
  );

  // A draft being edited whose row vanished (deleted elsewhere) must not be
  // saved back into existence.
  useEffect(() => {
    if (draft.id && !items.some((persona) => persona.id === draft.id)) {
      setDraft(EMPTY_DRAFT);
    }
  }, [items, draft.id]);

  const saving = createPersona.isPending || updatePersona.isPending;

  async function save(): Promise<void> {
    const name = draft.name.trim();
    const content = draft.content.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (!content) {
      toast.error("Persona prompt is required");
      return;
    }
    try {
      if (draft.id) {
        await updatePersona.mutateAsync({
          id: draft.id,
          name,
          description: draft.description,
          content,
        });
        toast.success("Persona updated");
      } else {
        const created = await createPersona.mutateAsync({
          name,
          description: draft.description,
          content,
        });
        toast.success("Persona saved");
        setDraft({
          id: created.id,
          name: created.name,
          description: created.description,
          content: created.content,
        });
        return;
      }
      setDraft(EMPTY_DRAFT);
    } catch (error) {
      toast.error("Could not save persona", getErrorMessage(error));
    }
  }

  async function activate(persona: PersonaView): Promise<void> {
    try {
      await activatePersona.mutateAsync(persona.id);
      toast.success(`Persona "${persona.name}" is now active`, "Every request through this router will use it.");
    } catch (error) {
      toast.error("Could not activate persona", getErrorMessage(error));
    }
  }

  async function deactivate(): Promise<void> {
    try {
      await activatePersona.mutateAsync(null);
      toast.success("Persona cleared", "Callers' own system prompts are used again.");
    } catch (error) {
      toast.error("Could not clear persona", getErrorMessage(error));
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    try {
      await deletePersona.mutateAsync(pendingDelete.id);
      toast.success("Persona deleted");
      if (draft.id === pendingDelete.id) setDraft(EMPTY_DRAFT);
    } catch (error) {
      toast.error("Could not delete persona", getErrorMessage(error));
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Custom Personas"
        description="Paste a persona and apply it. When active, the router replaces every caller's system prompt with it — so all models follow your persona, not the provider's or the client's."
        icon={<UserRound size={18} />}
        badges={
          activePersona ? (
            <Badge tone="ok">
              <Star size={12} /> {activePersona.name}
            </Badge>
          ) : (
            <Badge tone="default">No persona active</Badge>
          )
        }
        actions={
          activePersona ? (
            <Button variant="secondary" size="sm" onClick={() => void deactivate()} loading={activatePersona.isPending}>
              Clear active persona
            </Button>
          ) : null
        }
      />

      <Card>
        <CardHeader
          title={draft.id ? "Edit persona" : "New persona"}
          subtitle="The persona text becomes the model's system prompt verbatim."
          action={
            draft.id ? (
              <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
                New
              </Button>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">Name</span>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. Pirate captain"
              maxLength={200}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">Description (optional)</span>
            <Input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="What this persona is for"
              maxLength={1000}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">Persona prompt</span>
            <Textarea
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              placeholder="Paste the full persona here. This replaces the client's system prompt."
              rows={12}
              maxLength={200_000}
            />
            <span className="text-[11px] text-text-muted">{draft.content.length.toLocaleString()} characters</span>
          </label>
          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} loading={saving} icon={<Check size={14} />}>
              {draft.id ? "Save changes" : "Save persona"}
            </Button>
            {draft.id ? (
              <Button variant="ghost" onClick={() => setDraft(EMPTY_DRAFT)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Library" subtitle={`${items.length} saved persona${items.length === 1 ? "" : "s"}`} />
        <CardBody className="flex flex-col gap-2">
          {personas.isLoading ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-text-muted">No personas yet. Save one above.</p>
          ) : (
            items.map((persona) => {
              const isActive = persona.id === activeId;
              return (
                <div
                  key={persona.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-subtle p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-main">{persona.name}</span>
                      {isActive ? <Badge tone="ok">Active</Badge> : null}
                    </div>
                    {persona.description ? (
                      <p className="text-xs text-text-muted mt-0.5">{persona.description}</p>
                    ) : null}
                    <p className="text-[11px] text-text-muted mt-1 line-clamp-2 whitespace-pre-wrap break-words">
                      {persona.content.slice(0, 200)}
                      {persona.content.length > 200 ? "…" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void deactivate()}
                        loading={activatePersona.isPending}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Check size={14} />}
                        onClick={() => void activate(persona)}
                        loading={activatePersona.isPending}
                      >
                        Apply
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      label="Edit"
                      onClick={() =>
                        setDraft({
                          id: persona.id,
                          name: persona.name,
                          description: persona.description,
                          content: persona.content,
                        })
                      }
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      label="Delete"
                      onClick={() => setPendingDelete(persona)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete persona?"
        message={
          pendingDelete
            ? `"${pendingDelete.name}" will be removed${pendingDelete.id === activeId ? " and deactivated" : ""}.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => void confirmDelete()}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
