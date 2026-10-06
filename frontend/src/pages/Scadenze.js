import { useCallback, useEffect, useState } from "react";
import api, { formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { SCADENZE } from "@/constants/testIds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { MegaphoneIcon } from "@phosphor-icons/react";

const formatDateTime = (value, offsetMinutes = 0) => {
  if(!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + offsetMinutes);
  const formattedDate = date.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  return `${formattedDate} · ${date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
};

/* Converte una data ISO nel formato richiesto da <input type="datetime-local"> (YYYY-MM-DDTHH:mm),
   nel fuso orario locale del browser. */
const toLocalInputValue = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const EDITING_ENABLED = true;
const EDITING_ENABLED_ABSOLUTE = false;

const EDITABLE_FIELDS_BY_KIND = {
  null: ["due_date"],
  fine_mese: ["due_date"],
  esecuzione_trasferimento: ["due_date"],
  stadium_works: ["due_date", "done"],
  pagamento_trasferimento: ["due_date", "done"],
  bonus_misurabile: ["due_date", "done"],
  clausola_libera: ["due_date", "done", "title", "description"],
};

function editableFields(kind) {
  if (EDITING_ENABLED_ABSOLUTE) return new Set(["title", "description", "due_date", "done"]);
  if (EDITING_ENABLED) return new Set(EDITABLE_FIELDS_BY_KIND[kind] ?? []);
  return new Set();
}

export default function Scadenze() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editForm, setEditForm] = useState({ title: "", description: "", due_date: "", done: false });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get("/reminders", { params: { limit: null } });
    setItems(data);
  }, []);
  useEffect(() => { load(); }, [load]);

  const isPresident = user?.role === "presidente" && (EDITING_ENABLED || EDITING_ENABLED_ABSOLUTE);
  
  const openEdit = (c) => {
    setSelected(c);
    setEditForm({ title: c.title, description: c.description || "", due_date: toLocalInputValue(c.due_date), done: false });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const fields = editableFields(selected.kind);
    const patch = {};
    if (fields.has("title") && editForm.title !== selected.title) patch.title = editForm.title;
    if (fields.has("description") && editForm.description !== (selected.description || "")) patch.description = editForm.description;
    if (fields.has("due_date") && editForm.due_date) {
      const dueDate = new Date(editForm.due_date);
      if (Number.isNaN(dueDate.getTime()) || dueDate.getTime() <= Date.now()) {
        toast.error("La scadenza deve essere futura.");
        return;
      }
      const newDueIso = dueDate.toISOString();
      const currentDueIso = selected.due_date ? new Date(selected.due_date).toISOString() : null;
      if (newDueIso !== currentDueIso) patch.due_date = newDueIso;
    }
    if (fields.has("done") && editForm.done) patch.done = true;
    if (!Object.keys(patch).length) {
      toast.info("Nessuna modifica da salvare");
      setSelected(null);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/reminders/${selected.id}`, patch, {
        params: {
          editing_enabled: EDITING_ENABLED,
          editing_enabled_absolute: EDITING_ENABLED_ABSOLUTE,
        },
      });
      toast.success(patch.done ? "Reminder annullato" : "Scadenza aggiornata");
      setSelected(null);
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setSaving(false); }
  };

  const sorted = [...items].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const selectedFields = selected ? editableFields(selected.kind) : new Set();

  return (
    <div data-testid={SCADENZE.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">Reminders</div>
        <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
          <MegaphoneIcon size={44} weight="duotone" className="inline mr-3 text-[color:var(--primary-hover)]" />
          Tutte le scadenze LAL
        </h1>
      </div>

      {sorted.length === 0 && (
        <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
          <CardContent className="p-12 text-center text-[color:var(--text-muted)]">
            Nessuna scadenza ancora.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {sorted.map((c) => {
          const canEditReminder = isPresident && editableFields(c.kind).size > 0 && (c.kind || !c.entity);
          const CardWrapper = canEditReminder ? "button" : "div";
          return (
            <CardWrapper
              key={c.id}
              type={canEditReminder ? "button" : undefined}
              onClick={canEditReminder ? () => openEdit(c) : undefined}
              className={`text-left ${canEditReminder ? "cursor-pointer" : ""}`}
            >
              <Card
                data-testid={SCADENZE.card}
                className="bg-[color:var(--bg-surface)] border-[color:var(--border)] card-lift h-full"
              >
                <CardContent className="p-4">
                  <div className="font-mono text-[10px] text-[color:var(--gold)]">
                    {formatDateTime(c.due_date, c.kind != null ? -1 : 0)}
                  </div>
                  <div className="text-sm font-bold mt-1">{c.title}</div>
                  {c.description?.trim().split(/\s+/).length > 1 && (
                    <div className="text-xs text-[color:var(--text-muted)] mt-1">{c.description}</div>
                  )}
                </CardContent>
              </Card>
            </CardWrapper>
          );
        })}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-lg max-h-[90vh] overflow-y-auto">
          {selected && (
            <form onSubmit={saveEdit}>
              <DialogHeader>
                <DialogTitle className="text-2xl font-display">Modifica scadenza</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                {selectedFields.has("title") && (
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Titolo</label>
                    <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                  </div>
                )}
                {selectedFields.has("description") && (
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Descrizione</label>
                    <Textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                  </div>
                )}
                {selectedFields.has("due_date") && (
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Scadenza</label>
                    <Input
                      type="datetime-local"
                      min={toLocalInputValue(new Date().toISOString())}
                      value={editForm.due_date}
                      onChange={(e) => setEditForm({ ...editForm, due_date: e.target.value })}
                      className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono"
                    />
                    {selected.kind != null && (
                      <p className="text-xs text-[color:var(--text-muted)] mt-1">
                        Questo è il momento salvato in cui l'azione non è più svolgibile. In elenco viene mostrato un minuto prima, come ultimo istante utile.
                      </p>
                    )}
                  </div>
                )}
                {selectedFields.has("done") && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={editForm.done} onCheckedChange={(checked) => setEditForm({ ...editForm, done: checked === true })} />
                    Annulla reminder senza eseguirlo
                  </label>
                )}
              </div>
              <DialogFooter className="gap-2 mt-4">
                <Button type="button" variant="ghost" onClick={() => setSelected(null)}>Chiudi</Button>
                <Button type="submit" disabled={saving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                  {saving ? "Salvo…" : "Salva"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}