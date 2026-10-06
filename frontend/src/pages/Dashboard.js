import { useEffect, useState } from "react";
import api, { formatApiError } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { DASH } from "@/constants/testIds";
import { useAuth } from "@/context/AuthContext";
import {
  HandshakeIcon, CoinsIcon, PiggyBankIcon, ChartLineUpIcon, ShieldChevronIcon,
  PencilSimpleIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

const fmt = (n) => new Intl.NumberFormat("it-IT").format(Math.round(n || 0));
const fmtValue = (n) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(Number(n || 0));
const formatDateTime = (value, dateOptions, offsetMinutes = 0) => {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + offsetMinutes);
  const formattedDate = date.toLocaleDateString("it-IT", dateOptions);
  return `${formattedDate} ${date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
};

const IMAGE_BASE_URL = `${process.env.REACT_APP_BACKEND_URL}/data`;

function MyTeamCard({ label, value, icon: Icon, accent, tid }) {
  return (
    <Card data-testid={tid} className="card-lift bg-[color:var(--bg-surface)] border-[color:var(--border)]">
      <CardContent className="p-3.5 sm:p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="text-[9px] uppercase tracking-[0.2em] text-[color:var(--text-muted)] font-bold line-clamp-1">{label}</div>
          {Icon && (
            <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${accent || "bg-[color:var(--primary)]/20 text-[color:var(--primary-text)]"}`}>
              <Icon size={15} weight="duotone" />
            </div>
          )}
        </div>
        <div className="font-mono text-xl sm:text-2xl font-bold text-white">{value}</div>
      </CardContent>
    </Card>
  );
}

/* Iniziali: prima lettera delle prime due parole, o prime due lettere se il nome è una sola parola. */
function getInitials(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (name || "??").slice(0, 2).toUpperCase();
}

function TeamBadge({ team }) {
  const c1 = team.color_1 || "#6B21A8";
  const c2 = team.color_2 || c1;
  const c3 = team.color_3 || c2;
  const hasImage = !!team.image;

    return (
    <Link
      to={`/squadra/${team.id}`}
      data-testid={`home-team-${team.id}`}
      className="group relative h-full aspect-squadre flex flex-col items-center gap-3 p-5 rounded-2xl border transition-all duration-300 overflow-hidden hover:-translate-y-[2px] hover:shadow-[0_20px_60px_-20px_var(--team-glow)]"
      style={{
        background: `linear-gradient(to bottom right, ${c1} 20%, ${c2} 80%)`,
        borderColor: `${c3}AA`,
        "--team-glow": `${c3}66`,
      }}
    >
      <div className="relative flex-1 w-full flex items-center justify-center">
      {hasImage ? (
        <img
          src={`${IMAGE_BASE_URL}/${team.image}`}
          alt={team.name}
          className="h-40 w-40 object-contain"
        />
      ) : (
        <div className="h-32 w-32 rounded-full flex items-center justify-center bg-black/20 drop-shadow-[0_4px_10px_var(--team-glow)]">
          <span className="font-display text-4xl font-bold text-white">{getInitials(team.name)}</span>
        </div>
      )}
      </div>
      <div className="text-center relative hidden lg:block group-hover:block">
        <div
          className="font-display text-base font-bold transition-colors leading-tight tracking-wide"
          style={{ color: c3, textShadow: '0 1px 5px rgba(0, 0, 0, 1), 0 0 1px rgba(0, 0, 0, 1)' }}
        >
          {team.name}
        </div>
        <div className="text-[10px] uppercase tracking-[0.25em] text-white/85 mt-2 font-mono" style={{ color: c3, textShadow: '0 1px 3px rgba(0, 0, 0, 1), 0 0 3px rgba(0, 0, 0, 1)' }}>
          VdM Rosa: {fmtValue(team.roster_value_current || 0)} M
        </div>
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", body: "" });
  const [saving, setSaving] = useState(false);

  const load = () => api.get("/dashboard/summary").then(({ data }) => setData(data));
  useEffect(() => { load(); }, []);

  const team = data?.my_team;
  const teams = (data?.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name, "it"));
  const isLogged = user && user !== false;

  const openCommunique = (c) => {
    setSelected(c);
    setEditing(false);
    setEditForm({ title: c.title, body: c.body, pinned: !!c.pinned });
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
      setSelected({ ...selected, ...payload });
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
      setSelected(null);
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  return (
    <div data-testid={DASH.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="mb-8 fade-up">
        <div className="text-[10px] uppercase tracking-[0.35em] text-[color:var(--gold)] mb-3 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
          {isLogged && (
            <div className="flex items-center gap-2">
              <span>Ciao {user?.name}</span>
              <span className="hidden sm:inline">·</span>
            </div>
          )}
          <span>
            {new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}
          </span>
        </div>
        <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-none">
          <span className="gradient-text">LA&nbsp;Lega</span>
        </h1>
      </div>

      {team && (
        <div className="mb-12 fade-up fade-up-1">
          <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] font-bold mb-3">
            La tua squadra
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <MyTeamCard tid={DASH.summaryCard} label="Valore Società" value={fmt(team.vs)} icon={ChartLineUpIcon} accent="bg-[color:var(--gold)]/20 text-[color:var(--gold)]" />
            <MyTeamCard label="Budget Trasferimenti" value={fmt(team.bdg_trasferimenti)} icon={HandshakeIcon} />
            <MyTeamCard label="Budget Stipendi" value={fmt(team.bdg_stipendi)} icon={CoinsIcon} />
            <MyTeamCard label="Utili Liberi" value={fmt(team.u_liberi)} icon={PiggyBankIcon} accent="bg-[color:var(--success)]/20 text-[color:var(--success)]" />
          </div>
        </div>
      )}

      <div className="mb-12 fade-up fade-up-2">
        <div className="flex items-baseline gap-4 mb-6">
          <div className="text-[10px] uppercase tracking-[0.4em] text-[color:var(--gold)] font-bold">Le squadre</div>
          <div className="flex-1 h-px bg-gradient-to-r from-[color:var(--gold)]/40 to-transparent" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-5">
          {teams.map((t) => <TeamBadge key={t.id} team={t} />)}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 fade-up fade-up-3">
        <Card className="lg:col-span-2 flex flex-col bg-[color:var(--bg-surface)] border-[color:var(--border)]">
          <CardHeader className="border-b border-[color:var(--border)]">
            <CardTitle className="flex items-center justify-between text-sm uppercase tracking-widest">
              Prossime scadenze
              <Link to="/scadenze" className="text-xs text-[color:var(--gold)] hover:underline">Vedi tutte →</Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid flex-1 grid-cols-1 auto-rows-fr p-0 sm:grid-cols-3">
            {(!data?.upcoming_reminders || data.upcoming_reminders.length === 0) && (
              <div className="p-8 text-center text-[color:var(--text-muted)] text-sm">Nessuna scadenza</div>
            )}
            {data?.upcoming_reminders?.map((r, index) => (
              <div key={r.id} className={`h-full min-w-0 p-4 border-b border-[color:var(--border)] last:border-b-0 sm:[&:nth-child(3n+1)]:border-r sm:[&:nth-child(3n+2)]:border-r sm:[&:nth-last-child(-n+2)]:border-b-0 ${index >= 6 ? "max-sm:hidden" : ""} ${index === 5 ? "max-sm:border-b-0" : ""}`}>
                <div className="font-mono text-xs text-[color:var(--gold)]">
                  {formatDateTime(r.due_date, { day: "numeric", month: "short", year: "numeric" }, r.kind != null ? -1 : 0)}
                </div>
                <div className="text-sm font-bold mt-1 line-clamp-2">{r.title}</div>
                {typeof r.description === "string" && r.description.trim().split(/\s+/).length > 1 && (
                  <div className="text-xs text-[color:var(--text-muted)] mt-1">{r.description}</div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
          <CardHeader className="border-b border-[color:var(--border)]">
            <CardTitle className="flex items-center justify-between text-sm uppercase tracking-widest">
              Ultimi comunicati
              <Link to="/bacheca" className="text-xs text-[color:var(--gold)] hover:underline">Vedi tutti →</Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {(!data?.latest_communiques || data.latest_communiques.length === 0) && (
              <div className="p-8 text-center text-[color:var(--text-muted)] text-sm">Nessun comunicato disponibile</div>
            )}
            {data?.latest_communiques?.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => openCommunique(c)}
                className="w-full text-left p-5 border-b border-[color:var(--border)] last:border-b-0 hover:bg-[color:var(--bg-elev)] transition-colors"
              >
                <div className="font-mono text-xs text-[color:var(--gold)]">
                  {c.author_name} · {formatDateTime(c.created_at)}
                </div>
                <div className="text-sm font-bold mt-1 line-clamp-2">{c.title}</div>
                <div className="text-xs text-[color:var(--text-muted)] mt-1 line-clamp-2">{c.body}</div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
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
                      data-testid={DASH.communiqueEditBtn}
                      variant="ghost" size="icon"
                      onClick={() => setEditing(true)}
                      className="h-8 w-8 text-[color:var(--text-secondary)] hover:text-white"
                      title="Modifica"
                    >
                      <PencilSimpleIcon size={16} />
                    </Button>
                    <Button
                      data-testid={DASH.communiqueDeleteBtn}
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