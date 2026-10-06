import { useEffect, useState } from "react";
import api, { formatApiError } from "@/lib/api";
import { ADMIN } from "@/constants/testIds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  ShieldStarIcon, PlusIcon, TrashIcon, UsersIcon, CaretDownIcon, CoinsIcon,
  PencilSimpleIcon, CalendarBlankIcon, StackIcon, CalendarCheckIcon, ArrowsClockwiseIcon,
  CheckCircleIcon, XCircleIcon, SpinnerGapIcon
} from "@phosphor-icons/react";

const DEADLINE_ORDER = [
  "luglio", "agosto", "inizio_stagione", "settembre", "asta_estiva", "ottobre",
  "novembre", "dicembre", "gennaio", "febbraio", "asta_invernale",
  "marzo", "aprile", "maggio", "giugno",
];
const OPTIONAL_DEADLINES = new Set(["inizio_stagione", "asta_estiva", "asta_invernale"]);
const DEADLINE_LABELS = {
  luglio: "Luglio", agosto: "Agosto", inizio_stagione: "Inizio stagione", settembre: "Settembre",
  asta_estiva: "Asta estiva", ottobre: "Ottobre", novembre: "Novembre", dicembre: "Dicembre",
  gennaio: "Gennaio", febbraio: "Febbraio", asta_invernale: "Asta invernale",
  marzo: "Marzo", aprile: "Aprile", maggio: "Maggio", giugno: "Giugno",
};
const METRIC_LABELS = { gol: "Gol", assist: "Assist", presenze: "Presenze", bonus: "Bonus" };
const SCOPE_LABELS  = { stagione: "in stagione", totale: "in carriera" };
const SHIRT_LABELS  = { fantasquadra: "ne LA Lega", generale: "in Serie A" };

const toLocalInputValue = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function Section({ title, icon: Icon, children, className = "" }) {
  return (
    <Collapsible className={`overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-surface)] ${className}`}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left sm:px-5">
        <span className="flex items-center gap-2 font-display text-lg font-bold">
          <Icon size={20} weight="duotone" className="text-[color:var(--gold)]" />
          {title}
        </span>
        <CaretDownIcon size={16} className="shrink-0 text-[color:var(--text-muted)] transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-[color:var(--border)] p-4 sm:p-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function Admin() {
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [season, setSeason] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [players, setPlayers] = useState([]);
  const [updatingItemId, setUpdatingItemId] = useState(null);

  const [teamOpen, setTeamOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editUserTarget, setEditUserTarget] = useState(null);
  const [editUserForm, setEditUserForm] = useState({ name: "", email: "", team_id: "none" });

  const [tf, setTf] = useState({ name: "", manager_name: "", stadium_name: "", stadium_capacity: 5000 });
  const [uf, setUf] = useState({ email: "", password: "", name: "", team_id: "none" });
  const [dcrForm, setDcrForm] = useState(Object.fromEntries(DEADLINE_ORDER.map((f) => [f, ""])));

  const load = async () => {
    const [{ data: t }, { data: u }, { data: s }, { data: transfersData }, { data: remindersData }, { data: playersData }] = await Promise.all([
      api.get("/teams"), api.get("/users"), api.get("/season/current"),
      api.get("/transfers"), api.get("/reminders", { params: { limit: null } }), api.get("/players", { params: { limit: null } }),
    ]);
    setTeams(t); setUsers(u); setSeason(s);
    setTransfers(transfersData); setReminders(remindersData); setPlayers(playersData);
    setDcrForm(Object.fromEntries(DEADLINE_ORDER.map((f) => [f, toLocalInputValue(s?.date_composizione_rosa?.[f])])));
  };
  useEffect(() => { load(); }, []);

  const createTeam = async (e) => {
    e.preventDefault();
    try {
      await api.post("/teams", { ...tf, stadium_capacity: Number(tf.stadium_capacity) });
      toast.success("Squadra creata"); setTeamOpen(false);
      setTf({ name: "", manager_name: "", stadium_name: "", stadium_capacity: 5000 });
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const delTeam = async (t) => {
    if (!window.confirm(`Eliminare ${t.name}?`)) return;
    try {
      await api.delete(`/teams/${t.id}`);
      toast.success("Squadra eliminata");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const createUser = async (e) => {
    e.preventDefault();
    try {
      await api.post("/auth/register", {
        email: uf.email, password: uf.password, name: uf.name,
        team_id: uf.team_id === "none" ? null : uf.team_id,
      });
      toast.success("Utente creato"); setUserOpen(false);
      setUf({ email: "", password: "", name: "", team_id: "none" });
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const delUser = async (u) => {
    if (!window.confirm(`Eliminare ${u.email}?`)) return;
    try {
      await api.delete(`/users/${u.id}`);
      toast.success("Utente eliminato");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const openEditUser = (u) => {
    setEditUserTarget(u);
    setEditUserForm({ name: u.name, email: u.email, team_id: u.team_id || "none" });
    setEditUserOpen(true);
  };

  const saveEditUser = async (e) => {
    e.preventDefault();
    const newTeamId = editUserForm.team_id === "none" ? null : editUserForm.team_id;
    if (editUserForm.name === editUserTarget.name && editUserForm.email === editUserTarget.email && newTeamId === (editUserTarget.team_id || null)) {
      toast.info("Nessuna modifica da salvare");
      setEditUserOpen(false);
      return;
    }
    try {
      await api.patch(`/users/${editUserTarget.id}`, { name: editUserForm.name, email: editUserForm.email, team_id: newTeamId });
      toast.success("Utente aggiornato");
      setEditUserOpen(false);
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  /* Un campo è considerato "bloccato" (non più modificabile) se la sua data è già passata.
     Approssimazione ragionevole della regola reale del backend (che dipende da reminder confermati). */
  const lockedFields = new Set(
    DEADLINE_ORDER.filter((field) => {
      const v = season?.date_composizione_rosa?.[field];
      return v && new Date(v).getTime() < Date.now();
    })
  );

  const saveSeasonDeadlines = async (e) => {
    e.preventDefault();
    const payload = {};
    DEADLINE_ORDER.forEach((field) => {
      if (lockedFields.has(field)) return;
      const inputValue = dcrForm[field];
      const originalIso = season?.date_composizione_rosa?.[field] || null;
      const newIso = inputValue ? new Date(inputValue).toISOString() : null;
      const originalTime = originalIso ? new Date(originalIso).getTime() : null;
      const newTime = newIso ? new Date(newIso).getTime() : null;
      if (newTime !== originalTime) payload[field] = newIso;
    });
    if (Object.keys(payload).length === 0) {
      toast.info("Nessuna modifica da salvare");
      return;
    }
    try {
      await api.patch("/season", { date_composizione_rosa: payload });
      toast.success("Scadenze aggiornate");
      load();
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const visibleUsers = users.filter((u) => u.role !== "presidente");
  const teamsMap = Object.fromEntries(teams.map((t) => [t.id, t]));
  const playersMap = Object.fromEntries(players.map((p) => [p.id, p]));
  const remindersMap = new Map(reminders.map((r) => [`${r.transfer_id}:${r.entity_id}:${r.kind}`, r]));
  const obligationGroups = transfers
    .filter((transfer) => transfer.status === "convalidato" || transfer.status === "eseguito")
    .map((transfer) => {
    const teamLabel = transfer.team_a_id
      ? `${teamsMap[transfer.team_a_id]?.name ?? "Squadra A"} ↔ ${teamsMap[transfer.team_b_id]?.name ?? "Squadra B"}`
      : `Assegnazione a ${teamsMap[transfer.team_b_id]?.name ?? "Squadra"}`;
    const items = [
      ...(transfer.bonus ?? []).map((bonus) => {
        const reminder = remindersMap.get(`${transfer.id}:${bonus.id}:bonus_misurabile`);
        return {
          id: bonus.id,
          kind: "bonus_misurabile",
          state: bonus.stato ?? "aperta",
          heading: `Bonus · ${playersMap[bonus.player_id]?.name ?? bonus.player_id}`,
          description: `${METRIC_LABELS[bonus.metrica] ?? bonus.metrica} ≥ ${bonus.soglia} ${SCOPE_LABELS[bonus.ambito] ?? bonus.ambito} ${SHIRT_LABELS[bonus.maglia] ?? bonus.maglia}`,
          amount: bonus.amount,
          dueDate: reminder?.due_date,
          paidBy: bonus.paid_by_team_id,
          paidTo: bonus.paid_to_team_id,
        };
      }),
      ...(transfer.clausole_libere ?? []).map((clause) => ({
        id: clause.id,
        kind: "clausola_libera",
        state: clause.stato ?? "aperta",
        heading: "Clausola libera",
        description: clause.testo,
        dueDate: clause.due_date,
        paidBy: null,
        paidTo: null,
      })),
    ].filter((item) => item.state === "aperta");
    return { id: transfer.id, teamLabel, createdAt: transfer.created_at, items };
  }).filter((group) => group.items.length > 0);
  const obligations = obligationGroups.flatMap((group) => group.items.map((item) => ({
    ...item,
    transferId: group.id,
    teamLabel: group.teamLabel,
    transferCreatedAt: group.createdAt,
  })));

  const activateObligation = async (transferId, item) => {
    const itemName = item.kind === "bonus_misurabile" ? "bonus" : "clausola";
    if (!window.confirm(`Attivare questo ${itemName}? La gestione dell'adempimento resterà manuale al Presidente.`)) return;
    setUpdatingItemId(item.id);
    try {
      await api.post(`/transfers/${transferId}/items/${item.kind}/${item.id}/activate`);
      toast.success(`${itemName === "bonus" ? "Bonus" : "Clausola"} attivata. La gestione resta manuale.`);
      await load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setUpdatingItemId(null);
    }
  };

  const deactivateObligation = async (transferId, item) => {
    const itemName = item.kind === "bonus_misurabile" ? "bonus" : "clausola";
    if (!window.confirm(`Annullare questo ${itemName}? Non verrà attivato e il relativo reminder sarà chiuso.`)) return;
    setUpdatingItemId(item.id);
    try {
      await api.post(`/transfers/${transferId}/items/${item.kind}/${item.id}/deactivate`);
      toast.success(`${itemName === "bonus" ? "Bonus" : "Clausola"} annullata.`);
      await load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setUpdatingItemId(null);
    }
  };

  const formatObligationDate = (value) => value
    ? new Date(value).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })
    : null;

  return (
    <div data-testid={ADMIN.container} className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="mb-8">
        <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">Sala Presidente</div>
        <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
          <ShieldStarIcon size={44} weight="duotone" className="inline mr-3 text-[color:var(--gold)]" />
          Comando Assoluto.
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Squadre */}
        <Section title="Squadre" icon={ShieldStarIcon}>
          <div className="flex justify-end items-center mb-4">
            <Dialog open={teamOpen} onOpenChange={setTeamOpen}>
              <DialogTrigger asChild>
                <Button data-testid={ADMIN.createTeamBtn} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
                  <PlusIcon size={16} className="mr-2" /> Nuova squadra
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
                <DialogHeader><DialogTitle>Nuova squadra</DialogTitle></DialogHeader>
                <form onSubmit={createTeam} className="space-y-4">
                  {[["name", "Nome"], ["manager_name", "Allenatore"], ["stadium_name", "Stadio"], ["stadium_capacity", "Capienza"]].map(([k, l]) => (
                    <div key={k}>
                      <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">{l}</label>
                      <Input required={k === "name"} value={tf[k]} onChange={(e) => setTf({ ...tf, [k]: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                    </div>
                  ))}
                  <DialogFooter><Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Crea</Button></DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {teams.length === 0 && <div className="text-sm text-[color:var(--text-muted)]">Nessuna squadra.</div>}
            {teams.map((t) => (
              <div key={t.id} className="flex items-center justify-between p-3 border border-[color:var(--border)] rounded-lg">
                <div>
                  <div className="font-bold">{t.name}</div>
                  <div className="text-xs text-[color:var(--text-muted)]">Allenatore: {t.manager_name || "—"}</div>
                  <div className="text-xs text-[color:var(--text-muted)]">{t.stadium_name || "Stadio non definito"}</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => delTeam(t)} className="text-[color:var(--danger)]"><TrashIcon size={16} /></Button>
              </div>
            ))}
          </div>
        </Section>
        {/* Utenti */}
        <Section title="Utenti" icon={UsersIcon}>
          <div className="flex justify-end items-center mb-4">
            <Dialog open={userOpen} onOpenChange={setUserOpen}>
              <DialogTrigger asChild>
                <Button data-testid={ADMIN.createUserBtn} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
                  <PlusIcon size={16} className="mr-2" /> Nuovo utente
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
                <DialogHeader><DialogTitle>Nuovo utente</DialogTitle></DialogHeader>
                <form onSubmit={createUser} className="space-y-4">
                  {[["email", "Email"], ["password", "Password"], ["name", "Nome"]].map(([k, l]) => (
                    <div key={k}>
                      <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">{l}</label>
                      <Input required type={k === "password" ? "password" : k === "email" ? "email" : "text"} value={uf[k]} onChange={(e) => setUf({ ...uf, [k]: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                    </div>
                  ))}
                  <div>
                    <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Squadra assegnata</label>
                    <Select value={uf.team_id} onValueChange={(v) => setUf({ ...uf, team_id: v })}>
                      <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue placeholder="Nessuna" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— Nessuna —</SelectItem>
                        {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <DialogFooter><Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Crea</Button></DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {visibleUsers.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-2 p-3 border border-[color:var(--border)] rounded-lg">
                <div>
                  <div className="font-bold">{u.name}</div>
                  <div className="text-xs text-[color:var(--text-muted)]">{u.email}</div>
                  <div className="text-xs text-[color:var(--text-muted)]">{teamsMap[u.team_id]?.name || "Nessuna squadra"}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => openEditUser(u)} className="h-7 w-7 text-[color:var(--text-secondary)]"><PencilSimpleIcon size={14} /></Button>
                  <Button variant="ghost" size="icon" onClick={() => delUser(u)} className="h-7 w-7 text-[color:var(--danger)]"><TrashIcon size={14} /></Button>
                </div>
              </div>
            ))}
          </div>
        </Section>
        {/* Scadenze composizione rosa */}
        <Section title="Scadenze composizione rosa" icon={CalendarBlankIcon}>
          <p className="text-xs text-[color:var(--text-muted)] mb-4">
            Le scadenze già passate non sono più modificabili.
          </p>
          <form onSubmit={saveSeasonDeadlines} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {DEADLINE_ORDER.map((field) => {
              const locked = lockedFields.has(field);
              return (
                <div key={field}>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">
                    {DEADLINE_LABELS[field]}{locked && <span className="ml-1 normal-case font-normal">(passata)</span>}
                  </label>
                  <Input
                    type="datetime-local"
                    required={!OPTIONAL_DEADLINES.has(field) && !locked}
                    disabled={locked}
                    value={dcrForm[field]}
                    onChange={(e) => setDcrForm({ ...dcrForm, [field]: e.target.value })}
                    className={`font-mono ${locked ? "bg-[color:var(--bg-elev)] text-[color:var(--text-muted)] border-[color:var(--border)] cursor-not-allowed" : "bg-[color:var(--bg-main)] border-[color:var(--border)]"}`}
                  />
                </div>
              );
            })}
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Salva scadenze</Button>
            </div>
          </form>
        </Section>
        {/* Azioni di massa */}
        <Section title="Azioni di massa" icon={StackIcon}>
          <p className="text-sm text-[color:var(--text-muted)]">Sezione in costruzione.</p>
        </Section>
        {/* Gestione clausole */}
        <Section title="Clausole e bonus" icon={CoinsIcon} className="lg:col-span-2">
          <div className="space-y-6">
            <p className="text-xs text-[color:var(--text-muted)]">
              L'attivazione registra lo stato sul trasferimento e nasconde il reminder. L'adempimento resta in gestione manuale al Presidente.
            </p>
            {obligations.length === 0 && (
              <p className="text-sm text-[color:var(--text-muted)]">Nessun bonus o clausola da gestire.</p>
            )}
            {obligations.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">Da gestire</div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {obligations.map((item) => (
                        <div key={`${item.kind}:${item.id}`} className="min-w-0 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-main)] p-3">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--text-muted)]">
                                <span className="font-semibold">{item.teamLabel}</span>
                                {item.transferCreatedAt && <span>{new Date(item.transferCreatedAt).toLocaleDateString("it-IT")}</span>}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold">{item.heading}</span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300">
                                  Aperta
                                </span>
                              </div>
                              <p className="text-sm text-[color:var(--text-secondary)] break-words">{item.description}</p>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--text-muted)]">
                                {item.amount != null && <span>Importo: <strong className="text-[color:var(--text-secondary)]">{item.amount} M</strong></span>}
                                {item.paidBy && <span>{teamsMap[item.paidBy]?.name ?? "Squadra"} → {teamsMap[item.paidTo]?.name ?? "Squadra"}</span>}
                                {formatObligationDate(item.dueDate) && <span>Scadenza: {formatObligationDate(item.dueDate)}</span>}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={updatingItemId === item.id}
                                onClick={() => activateObligation(item.transferId, item)}
                                className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-semibold"
                              >
                                {updatingItemId === item.id ? <SpinnerGapIcon size={15} className="mr-1.5 animate-spin" /> : <CheckCircleIcon size={15} className="mr-1.5" />}
                                Attiva
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={updatingItemId === item.id}
                                onClick={() => deactivateObligation(item.transferId, item)}
                                className="border-[color:var(--danger)]/50 text-[color:var(--danger)]"
                              >
                                {updatingItemId === item.id ? <SpinnerGapIcon size={15} className="mr-1.5 animate-spin" /> : <XCircleIcon size={15} className="mr-1.5" />}
                                Annulla
                              </Button>
                            </div>
                          </div>
                        </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
        {/* Azioni annuali */}
        <Section title="Azioni annuali" icon={CalendarCheckIcon}>
          <p className="text-sm text-[color:var(--text-muted)]">Sezione in costruzione.</p>
        </Section>
        {/* Cambio stagione */}
        <Section title="Cambio stagione" icon={ArrowsClockwiseIcon}>
          <p className="text-sm text-[color:var(--text-muted)]">Sezione in costruzione.</p>
        </Section>
      </div>

      <Dialog open={editUserOpen} onOpenChange={setEditUserOpen}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
          <DialogHeader><DialogTitle>Modifica utente</DialogTitle></DialogHeader>
          <form onSubmit={saveEditUser} className="space-y-4">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nome</label>
              <Input required value={editUserForm.name} onChange={(e) => setEditUserForm({ ...editUserForm, name: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
                        <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Email</label>
              <Input required type="email" value={editUserForm.email} onChange={(e) => setEditUserForm({ ...editUserForm, email: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Squadra assegnata</label>
              <Select value={editUserForm.team_id} onValueChange={(v) => setEditUserForm({ ...editUserForm, team_id: v })}>
                <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Nessuna —</SelectItem>
                  {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditUserOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Salva</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}