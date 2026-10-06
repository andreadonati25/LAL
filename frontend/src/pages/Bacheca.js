import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api, { formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { BACHECA } from "@/constants/testIds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { MegaphoneIcon, PlusIcon, PushPinIcon, TrashIcon, PencilSimpleIcon } from "@phosphor-icons/react";

const formatDateTime = (value, dateOptions, offsetMinutes = 0) => {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + offsetMinutes);
  const formattedDate = date.toLocaleDateString("it-IT", dateOptions);
  return `${formattedDate} ${date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
};

export default function Bacheca() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [teams, setTeams] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ team_id: "", title: "", body: "", pinned: false });
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", body: "", pinned: false });
  const [saving, setSaving] = useState(false);

  /* Il comunicato "aperto" non è uno stato locale: è derivato dall'id presente nell'URL. */
  const selectedId = searchParams.get("id");
  const selected = items.find((c) => c.id === selectedId) || null;

  const load = useCallback(async () => {
    const [{ data: c }, { data: t }] = await Promise.all([
      api.get("/communiques"),
      api.get("/teams"),
    ]);
    setItems(c);
    setTeams(t);
    setForm((f) => ({ ...f, team_id: user?.team_id || null }));
  }, [user?.team_id]);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/communiques", form);
      setOpen(false);
      setForm({ team_id: user?.team_id || null, title: "", body: "", pinned: false });
      toast.success("Comunicato pubblicato");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    finally { setSaving(false); }
  };

  const openCommunique = (c) => {
    const next = new URLSearchParams(searchParams);
    next.set("id", c.id);
    setSearchParams(next);
    setEditing(false);
    setEditForm({ title: c.title, body: c.body, pinned: !!c.pinned });
  };

  const closeCommunique = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next);
    setEditing(false);
  };

  const canManage = (c) => user?.role === "presidente" || c.author_id === user?.id;

  const saveEdit = async (e) => {
    e.preventDefault();
    const isPresident = user?.role === "presidente";
    const noChange =
      editForm.title === selected.title &&
      editForm.body === selected.body &&
      (!isPresident || editForm.pinned === !!selected.pinned);
    if (noChange) {
      toast.info("Nessuna modifica da salvare");
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const payload = { title: editForm.title, body: editForm.body };
      if (isPresident) payload.pinned = editForm.pinned;
      await api.patch(`/communiques/${selected.id}`, payload);
      toast.success("Comunicato aggiornato");
      setEditing(false);
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setSaving(false); }
  };

  const deleteCommunique = async (c) => {
    if (!window.confirm("Eliminare il comunicato?")) return;
    try {
      await api.delete(`/communiques/${c.id}`);
      toast.success("Eliminato");
      closeCommunique();
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const teamsMap = Object.fromEntries(teams.map((t) => [t.id, t]));
  const sorted = [...items].sort((a, b) => (b.pinned - a.pinned) || (new Date(b.created_at) - new Date(a.created_at)));

  return (
    <div data-testid={BACHECA.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">Comunicazioni</div>
          <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
            <MegaphoneIcon size={44} weight="duotone" className="inline mr-3 text-[color:var(--primary-hover)]" />
            Bacheca ufficiale.
          </h1>
        </div>

        {(user?.team_id || user?.role === "presidente") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid={BACHECA.newPostBtn} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
                <PlusIcon size={16} className="mr-2" /> Nuovo comunicato
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl max-h-[90vh] overflow-y-auto">
              <form onSubmit={submit}>
                <DialogHeader>
                  <DialogTitle className="text-3xl font-display">Nuovo comunicato</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Titolo</label>
                    <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Testo</label>
                    <Textarea required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] min-h-[280px]" />
                  </div>
                  {user?.role === "presidente" && (
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={form.pinned}
                        onCheckedChange={(v) => setForm({ ...form, pinned: v })}
                        className="data-[state=checked]:bg-[color:var(--gold)] data-[state=unchecked]:bg-[color:var(--bg-elev)]"
                      />
                      <span className="text-sm">Comunicato in evidenza</span>
                    </div>
                  )}
                </div>
                <DialogFooter className="gap-2 mt-4">
                  <Button data-testid={BACHECA.submitPost} type="submit" disabled={saving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                    {saving ? "Pubblicazione…" : "Pubblica"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {sorted.length === 0 && (
        <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
          <CardContent className="p-12 text-center text-[color:var(--text-muted)]">
            Nessun comunicato ancora.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
        {sorted.map((c) => (
          <button key={c.id} type="button" onClick={() => openCommunique(c)} className="text-left">
            <Card
              data-testid={BACHECA.postCard}
              className={`bg-[color:var(--bg-surface)] border-[color:var(--border)] card-lift aspect-square flex flex-col overflow-hidden ${c.pinned ? "border-[color:var(--gold)]/60 glow-gold" : ""}`}
            >
              <CardContent className="p-4 sm:p-5 flex flex-col h-full">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[color:var(--gold)] font-bold shrink-0">
                  <span className="flex items-center gap-1 truncate">
                    {c.pinned && <PushPinIcon size={12} weight="fill" className="shrink-0" />}
                    <span className="truncate">{teamsMap[c.team_id]?.name || c.author_name}</span>
                  </span>
                  <span className="shrink-0 text-[9px] opacity-80">
                    {new Date(c.created_at).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </div>
                <div className="relative flex-1 min-h-0 mt-2 overflow-hidden">
                  <h2 className="font-display text-lg sm:text-xl md:text-2xl leading-tight mb-1.5">{c.title}</h2>
                  <div className="text-xs sm:text-sm text-[color:var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                    {c.body}
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[color:var(--bg-surface)] to-transparent" />
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && closeCommunique()}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl max-h-[90vh] overflow-y-auto">
          {selected && !editing && (
            <>
              <DialogHeader>
                <DialogTitle className="text-3xl font-display">{selected.title}</DialogTitle>
              </DialogHeader>
              <div className="flex items-center justify-between -mt-2">
                <div className="font-mono text-xs text-[color:var(--gold)]">
                  {selected.author_name} · {formatDateTime(selected.created_at)}
                </div>
                {canManage(selected) && (
                  <div className="flex items-center gap-1">
                    <Button
                      data-testid={BACHECA.communiqueEditBtn}
                      variant="ghost" size="icon"
                      onClick={() => setEditing(true)}
                      className="h-8 w-8 text-[color:var(--text-secondary)] hover:text-white"
                      title="Modifica"
                    >
                      <PencilSimpleIcon size={16} />
                    </Button>
                    <Button
                      data-testid={BACHECA.communiqueDeleteBtn}
                      variant="ghost" size="icon"
                      onClick={() => deleteCommunique(selected)}
                      className="h-8 w-8 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/20"
                      title="Elimina"
                    >
                      <TrashIcon size={16} />
                    </Button>
                  </div>
                )}
              </div>
              <div className="text-[color:var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                {selected.body}
              </div>
            </>
          )}

          {selected && editing && (
            <form onSubmit={saveEdit}>
              <DialogHeader>
                <DialogTitle className="text-3xl font-display">Modifica comunicato</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Titolo</label>
                  <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Testo</label>
                  <Textarea value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] min-h-[280px]" />
                </div>
                {user?.role === "presidente" && (
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={editForm.pinned}
                      onCheckedChange={(v) => setEditForm({ ...editForm, pinned: v })}
                      className="data-[state=checked]:bg-[color:var(--gold)] data-[state=unchecked]:bg-[color:var(--bg-elev)]"
                    />
                    <span className="text-sm">Comunicato in evidenza</span>
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2 mt-4">
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Annulla</Button>
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