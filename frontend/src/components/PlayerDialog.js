import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api, { formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { PencilSimpleIcon, TrashIcon, UserIcon, SignOutIcon, CheckCircleIcon, ShieldCheckIcon, FileTextIcon } from "@phosphor-icons/react";

/* Mostra un decimale solo se serve davvero: 100.0 → "100 M", 12.5 → "12,5 M". */
const fmtM = (n) => {
  const rounded = Math.round(Number(n || 0) * 10) / 10;
  const isWhole = Number.isInteger(rounded);
  return `${new Intl.NumberFormat("it-IT", { minimumFractionDigits: isWhole ? 0 : 1, maximumFractionDigits: isWhole ? 0 : 1 }).format(rounded)} M`;
};
const fmtIntM = (n) => `${new Intl.NumberFormat("it-IT").format(Math.round(n || 0))} M`;

/* Se image è un URL esterno (es. Transfermarkt) lo usa così com'è;
   se è un file caricato localmente (categoria player-image/...), lo risolve col backend. */
const resolveImageUrl = (image) =>
  !image ? "" : /^https?:\/\//.test(image) ? image : `${process.env.REACT_APP_BACKEND_URL}/data/${image}`;

const ROLES = ["P", "D", "C", "A"];
const ROLE_STYLES = {
  P: "border-orange-300/90 bg-orange-400/35 text-orange-100",
  D: "border-sky-300/90 bg-sky-400/35 text-sky-100",
  C: "border-emerald-300/90 bg-emerald-400/35 text-emerald-100",
  A: "border-red-300/90 bg-red-400/35 text-red-100",
};

const SECTION_LABELS = {
  prima_squadra: "Prima Squadra",
  primavera: "Primavera",
  tribuna: "Tribuna",
  estero: "Estero",
  academy: "Academy",
  in_prestito: "In prestito",
};

/* Replica fedele di add_months() del backend (Python): sposta una data di N mesi,
   gestendo correttamente i mesi con meno giorni (es. 31 gennaio + 1 mese = 28/29 febbraio). */
function addMonths(date, months) {
  const d = new Date(date);
  let month = d.getMonth() + months;
  let year = d.getFullYear() + Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  const daysInTargetMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(d.getDate(), daysInTargetMonth);
  return new Date(year, month, day, d.getHours(), d.getMinutes(), d.getSeconds());
}

/* Replica fedele di compute_years_in_team() del backend: porzione di contratto
   onorata ad oggi, con bonus di mezzo anno superati i 182 giorni e la soglia
   minima di un mese dalla stipula. */
function computeYearsInTeam(contractStart) {
  if (!contractStart) return null;
  const startDt = new Date(contractStart);
  if (Number.isNaN(startDt.getTime())) return null;
  const nowDt = new Date();
  let days = Math.floor((nowDt - startDt) / (1000 * 60 * 60 * 24));
  if (days < 0) days = 0;
  const yearsInt = Math.floor(days / 365);
  const remainder = days % 365;
  const halfYearBonus = remainder >= 182 ? 0.5 : 0.0;
  const oneMonthAfterStart = addMonths(startDt, 1);
  const extraHalf = oneMonthAfterStart >= nowDt ? 0.0 : 0.5;
  return yearsInt + halfYearBonus + extraHalf;
}

/**
 * Dialog di dettaglio giocatore, condiviso tra Listone e Squadra.
 * Linkabile: il giocatore aperto è determinato dal query param nell'URL
 * (default "player"), non da stato locale — coerente con il pattern già
 * usato in Bacheca per i comunicati.
 *
 * Props:
 * - players: lista giocatori già caricata dalla pagina genitrice
 * - teams: lista squadre già caricata dalla pagina genitrice
 * - reminders: (opzionale) lista reminder già caricata dalla pagina genitrice,
 *   usata in futuro per decidere quali azioni mostrare
 * - paramName: nome del query param nell'URL (default "player")
 * - onPlayerDeleted: callback chiamata dopo un'eliminazione O una modifica riuscita
 *   (per ricaricare la lista/i dati nella pagina genitrice)
 * - seasonStartYear: primo anno stagionale
 */
export default function PlayerDialog({ players, teams, reminders = [], paramName = "player", onPlayerDeleted, seasonStartYear = null, seasonTeams = [] }) {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [roster, setRoster] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [newRealClub, setNewRealClub] = useState("");
  const [pendingTransferStatus, setPendingTransferStatus] = useState(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [signForm, setSignForm] = useState({ contract_years: "1", jersey_number: "" });
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewYears, setRenewYears] = useState("1");
  const [uploadingImage, setUploadingImage] = useState(false);

  const playerId = searchParams.get(paramName);
  const player = players.find((p) => p.id === playerId) || null;
  const hasPendingValidatedTransfer = Boolean(pendingTransferStatus);
  const teamsMap = Object.fromEntries(teams.map((t) => [t.id, t]));
  const isPresident = user?.role === "presidente";
  const isOwner = user?.team_id && player?.fanta_team_id === user.team_id;
  const isCurrent = user?.team_id && player?.current_team_id === user.team_id;
  const canManageAutoRelease = isPresident || isOwner || (isCurrent && !player?.fanta_team_id);

  /* Reminder collegati a questo giocatore: pronto per decidere in futuro
     quali azioni mostrare (svincolo, rinnovo, ecc.) — non ancora utilizzato. */
  const playerReminders = player
    ? reminders.filter((r) => r.entity === "player" && r.entity_id === player.id)
    : [];
  const loanReminder = player
    ? reminders.find((r) => r.entity === "player" && r.entity_id === player.id && !r.done && ["prestito_secco", "prestito_diritto", "prestito_obbligo"].includes(r.kind))
    : null;
  const autoReleaseLoanReminder = loanReminder
    ? reminders.find((r) => r.entity === "reminder" && r.entity_id === loanReminder.id && r.kind === "auto_release_prestito" && !r.done)
    : null;

  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete(paramName);
    setSearchParams(next);
    setEditing(false);
  };

  /* Carica la composizione rosa corrente della squadra che detiene fisicamente
     il giocatore (current_team_id), per sapere in quale sezione si trova oggi. */
  useEffect(() => {
    if (!player?.current_team_id) { setRoster(null); return; }
    api.get(`/teams/${player.current_team_id}/roster-current`)
      .then(({ data }) => setRoster(data))
      .catch(() => setRoster(null));
  }, [player?.current_team_id]);

  useEffect(() => {
    let isMounted = true;
    if (!playerId) {
      setPendingTransferStatus(null);
      return () => { isMounted = false; };
    }
    setPendingTransferStatus(null);
    Promise.all([
      api.get("/transfers"),
      api.get("/reminders", { params: { limit: null } }),
    ])
      .then(([{ data: transfers }, { data: allReminders }]) => {
        if (!isMounted) return;
        const transfer = transfers.find((item) => item.status === "convalidato" && (item.movements ?? []).some((movement) => (
          movement.player_id === playerId &&
          allReminders.some((reminder) => (
            reminder.transfer_id === item.id &&
            reminder.entity_id === movement.id &&
            reminder.kind === "esecuzione_trasferimento" &&
            !reminder.done
          ))
        )));
        const movement = transfer?.movements.find((item) => item.player_id === playerId);
        if (!transfer || !movement) {
          setPendingTransferStatus(false);
          return;
        }
        const currentlyLoaned = player?.current_team_id && player.current_team_id !== player.fanta_team_id;
        setPendingTransferStatus({
          futureOwnerTeamId: movement.tipo === "definitivo" ? movement.to_team_id : movement.from_team_id,
          futureCurrentTeamId: movement.tipo === "definitivo" && currentlyLoaned ? player.current_team_id : movement.to_team_id,
        });
      })
      .catch(() => {
        if (isMounted) setPendingTransferStatus(false);
      });
    return () => { isMounted = false; };
  }, [playerId, player?.current_team_id, player?.fanta_team_id]);

  const currentSection = player && roster
    ? Object.entries(roster.sections).find(([, list]) => list.some((p) => p.id === player.id))?.[0]
    : null;

  const deletePlayer = async () => {
    if (!window.confirm(`Eliminare ${player.name}?`)) return;
    try {
      await api.delete(`/players/${player.id}`);
      toast.success("Giocatore eliminato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const releasePlayer = async () => {
    if (hasPendingValidatedTransfer) {
      toast.error("Non puoi svincolare deliberatamente un giocatore con un trasferimento convalidato non ancora eseguito.");
      return;
    }
    const isAcademy = player.tier === "academy";
    const confirmMsg = isAcademy
      ? `Svincolare ${player.name}? Non è previsto alcun incasso (Academy).`
      : `Svincolare ${player.name}? Incasserai ${(player.cartellino * 0.9 * contractPortion / player.contract_years).toFixed(2)} M complessivi.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await api.patch(`/players/${player.id}/release`);
      toast.success("Giocatore svincolato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const proposeAutoRelease = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/players/${player.id}/propose-auto-release`, null, { params: { new_real_club: newRealClub } });
      toast.success(hasPendingValidatedTransfer
        ? "Trasferimento eseguito e processo di svincolo automatico avviato"
        : (player.fanta_team_id ? "Processo di svincolo automatico avviato" : "Passaggio all'estero effettuato"));
      setProposeOpen(false);
      setNewRealClub("");
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const acceptAutoRelease = async () => {
    if (!window.confirm(`Confermi lo svincolo automatico di ${player.name}? Incasserai ${(player.cartellino * 0.9).toFixed(2)} M complessivi.`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/accept-auto-release`);
      toast.success("Svincolo automatico confermato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };

  const keepInSquad = async () => {
    if (!window.confirm(`Mantenere ${player.name} in rosa?`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/keep-in-squad`);
      toast.success("Giocatore mantenuto in rosa");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };

  const signContract = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/players/${player.id}/sign-contract`, null, {
        params: {
          contract_years: Number(signForm.contract_years),
          jersey_number: Number(signForm.jersey_number),
        },
      });
      toast.success("Contratto firmato");
      setSignOpen(false);
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const renewContract = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/players/${player.id}/renewal-contract`, null, {
        params: { contract_years: Number(renewYears) },
      });
      toast.success("Contratto rinnovato");
      setRenewOpen(false);
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    }
  };

  const riscattaDirittoAction = async () => {
    if (!window.confirm(`Riscattare ${player.name}?`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/diritto/riscatta`);
      toast.success("Diritto di riscatto esercitato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };

  const terminaDirittoAction = async () => {
    if (!window.confirm(`Non esercitare il riscatto per ${player.name}? Il giocatore tornerà alla squadra proprietaria.`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/diritto/termina`);
      toast.success("Diritto di riscatto non esercitato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };  

  const mantieniPrestitoAction = async () => {
    if (!window.confirm(`Mantenere il prestito di ${player.name} fino alla scadenza naturale?`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/prestito/mantieni`);
      toast.success("Prestito mantenuto");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };

  const terminaPrestitoAction = async () => {
    if (!window.confirm(`Terminare subito il prestito di ${player.name}?`)) return;
    setDecisionLoading(true);
    try {
      await api.post(`/players/${player.id}/prestito/termina`);
      toast.success("Prestito terminato");
      close();
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setDecisionLoading(false); }
  };

  const notImplemented = () => toast.info("Funzione in arrivo");

  const canEditJersey = player && player.fanta_team_id && player.tier !== "academy";

  const openEdit = () => {
    setEditForm({
      name: player.name,
      role: player.role,
      birth_year: player.birth_year,
      real_club: player.real_club || "",
      image: player.image || "",
      transfermarkt_value: player.transfermarkt_value,
      fantavalore: player.fantavalore,
      salary: player.salary,
      jersey_number: player.jersey_number ?? "",
    });
    setEditing(true);
  };

  const handleImageUpload = async (file) => {
    if (!file) return;
    setUploadingImage(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/uploads", fd, {
        params: { category: "player-image" },
        headers: { "Content-Type": "multipart/form-data" },
      });
      setEditForm((f) => ({ ...f, image: data.filename }));
      toast.success("Immagine caricata");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setUploadingImage(false); }
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const numericForm = {
      ...editForm,
      birth_year: Number(editForm.birth_year),
      transfermarkt_value: Number(editForm.transfermarkt_value),
      fantavalore: Number(editForm.fantavalore),
      salary: Number(editForm.salary),
    };
    const noChange =
      numericForm.name === player.name &&
      numericForm.role === player.role &&
      numericForm.birth_year === player.birth_year &&
      numericForm.real_club === (player.real_club || "") &&
      numericForm.image === (player.image || "") &&
      numericForm.transfermarkt_value === player.transfermarkt_value &&
      numericForm.fantavalore === player.fantavalore &&
      numericForm.salary === player.salary &&
      (!canEditJersey || (editForm.jersey_number === "" ? null : Number(editForm.jersey_number)) === (player.jersey_number ?? null));
    if (noChange) {
      toast.info("Nessuna modifica da salvare");
      setEditing(false);
      return;
    }
    const payload = {
      name: numericForm.name,
      role: numericForm.role,
      birth_year: numericForm.birth_year,
      real_club: numericForm.real_club,
      image: numericForm.image || null,
      transfermarkt_value: numericForm.transfermarkt_value,
      fantavalore: numericForm.fantavalore,
      salary: numericForm.salary,
    };
    if (canEditJersey) {
      payload.jersey_number = editForm.jersey_number === "" ? null : Number(editForm.jersey_number);
    }
    setSaving(true);
    try {
      await api.patch(`/players/${player.id}`, payload);
      toast.success("Giocatore aggiornato");
      setEditing(false);
      onPlayerDeleted?.();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setSaving(false); }
  };


  if (!player) return null;

  const rawContractPortion = computeYearsInTeam(player.contract_start);
  const contractPortion = rawContractPortion != null && player.contract_years
    ? Math.min(rawContractPortion, player.contract_years)
    : rawContractPortion;
  const isOnLoan = player.current_team_id && player.current_team_id !== player.fanta_team_id;
  const isIngaggiato = player.fanta_team_id && player.tier != "academy";

  return (
    <Dialog open={!!player} onOpenChange={(o) => !o && close()}>
      <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] w-[calc(100%-2rem)] max-w-3xl max-h-[90vh] overflow-y-auto">
        {!editing ? (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">{player.name}</DialogTitle>
            </DialogHeader>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Colonna sinistra: anagrafica + ruolo/sezione + azioni */}
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                    <div className="flex-initial space-y-3">
                        {player.image ? (
                            <img src={resolveImageUrl(player.image)} alt={player.name} className="h-24 w-24 rounded-xl object-cover shrink-0" />
                        ) : (
                            <div className="h-24 w-24 rounded-xl bg-[color:var(--bg-elev)] flex items-center justify-center shrink-0 text-[color:var(--text-muted)]">
                            <UserIcon size={36} weight="fill" />
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={`text-xs font-mono font-bold border rounded px-2.5 py-1 ${ROLE_STYLES[player.role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>
                                {player.role}
                            </span>
                            <span className={`text-xs font-mono border rounded px-2.5 py-1 ${seasonStartYear && seasonStartYear - player.birth_year <= 23 ? "border-lime-200/90 bg-lime-300/80 font-bold text-lime-950" : "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>
                                {player.birth_year || "—"}
                            </span>
                        </div>
                    </div>
                    <div className="flex-1 space-y-3">
                        <div className="min-w-0">
                            {isIngaggiato ? (
                                <h2 className="font-display text-2xl font-bold leading-tight">{player.jersey_number !== null && player.jersey_number !== undefined ? `#${player.jersey_number}` : "-"} - {player.name}</h2>
                            ) : (
                                <h2 className="font-display text-2xl font-bold leading-tight">{player.name}</h2>
                            )}
                            <div className="text-sm mt-2 space-y-0.5">
                            <div>
                                <span className="text-[color:var(--text-muted)]">FantaSquadra: </span>
                                <span className="font-bold whitespace-nowrap">{player.fanta_team_id ? teamsMap[player.fanta_team_id]?.name : "Svincolato"}</span>
                                {pendingTransferStatus && pendingTransferStatus.futureOwnerTeamId !== player.fanta_team_id && (
                                  <span className="ml-1 text-xs text-[color:var(--gold)]">
                                    → {teamsMap[pendingTransferStatus.futureOwnerTeamId]?.name ?? "Svincolato"}
                                  </span>
                                )}
                            </div>
                            <div>
                                <span className="text-[color:var(--text-muted)]">Squadra: </span>
                                <span className="whitespace-nowrap">{player.real_club || "Svincolato"}</span>
                            </div>
                            {isOnLoan && (
                                <div>
                                <span className="text-[color:var(--text-muted)]">In prestito a: </span>
                                <span className="font-bold text-[color:var(--gold)] whitespace-nowrap">{teamsMap[player.current_team_id]?.name}</span>
                                {pendingTransferStatus && pendingTransferStatus.futureCurrentTeamId !== player.current_team_id && (
                                  <span className="ml-1 text-xs text-[color:var(--text-muted)]">
                                    → {teamsMap[pendingTransferStatus.futureCurrentTeamId]?.name ?? "—"}
                                  </span>
                                )}
                                </div>
                            )}
                            {!isOnLoan && pendingTransferStatus && pendingTransferStatus.futureCurrentTeamId !== pendingTransferStatus.futureOwnerTeamId && (
                                <div>
                                <span className="text-[color:var(--text-muted)]">In prestito futuro: </span>
                                <span className="font-bold text-[color:var(--gold)] whitespace-nowrap">
                                  {teamsMap[pendingTransferStatus.futureCurrentTeamId]?.name ?? "—"}
                                </span>
                                </div>
                            )}
                            {player.fanta_team_id && currentSection && (
                                <div className="text-sm">
                                <span className="text-[color:var(--text-muted)]">Sezione: </span>
                                <span className="font-bold text-[color:var(--gold)]  whitespace-nowrap">{SECTION_LABELS[currentSection] || currentSection}</span>
                                </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                
                <div className="flex flex-wrap gap-2 pt-2 border-t border-[color:var(--border)]">
                {(isPresident) && (
                  <>
                    <Button variant="outline" size="sm" onClick={openEdit} className="border-[color:var(--border)]">
                      <PencilSimpleIcon size={14} className="mr-2" /> Modifica
                    </Button>
                    <Button variant="destructive" size="sm" onClick={deletePlayer}>
                      <TrashIcon size={14} className="mr-2" /> Elimina
                    </Button>
                  </>
                )}
                {((isPresident && player.fanta_team_id) || isOwner) &&
                  !playerReminders.some((r) => r.kind === "auto_release" && !r.done) &&
                  (player.tier === "academy" || !!contractPortion) && (
                    <Button variant="outline" size="sm" disabled={pendingTransferStatus !== false} onClick={releasePlayer} className="border-[color:var(--danger)]/50 text-[color:var(--danger)]">
                      <SignOutIcon size={14} className="mr-2" /> Svincolo deliberato
                    </Button>
                )}
                {isPresident &&
                  player.tier !== "academy" &&
                  seasonTeams.includes(player.real_club) &&
                  !playerReminders.some((r) => r.kind === "auto_release" && !r.done) && (
                    <Button variant="outline" size="sm" onClick={() => setProposeOpen(true)} className="border-[color:var(--border)]">
                      <SignOutIcon size={14} className="mr-2" /> {player.fanta_team_id ? "Inizio processo svincolo automatico" : "Passaggio all'estero"}
                    </Button>
                )}
                {canManageAutoRelease &&
                  playerReminders.some((r) => r.kind === "auto_release" && !r.done) && (
                  <>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={acceptAutoRelease} className="border-[color:var(--danger)]/50 text-[color:var(--danger)]">
                      <SignOutIcon size={14} className="mr-2" /> Svincolo automatico
                    </Button>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={keepInSquad} className="border-[color:var(--success)]/50 text-[color:var(--success)]">
                      <ShieldCheckIcon size={14} className="mr-2" /> Mantenimento in rosa
                    </Button>
                  </>
                )}
                {((isPresident && player.fanta_team_id) || isOwner) &&
                  !player.contract_start &&
                  (player.tier === "academy" || playerReminders.some((r) => r.kind === "contract_signature" && !r.done)) && (
                    <Button variant="outline" size="sm" onClick={() => setSignOpen(true)} className="border-[color:var(--border)]">
                      <FileTextIcon size={14} className="mr-2" /> Firma primo contratto
                    </Button>
                )}
                {((isPresident && player.fanta_team_id) || isOwner) &&
                  player.contract_start &&
                  playerReminders.some((r) => r.kind === "contract_termination" && !r.done) &&
                  contractPortion === player.contract_years && (
                    <Button variant="outline" size="sm" onClick={() => setRenewOpen(true)} className="border-[color:var(--border)]">
                      <FileTextIcon size={14} className="mr-2" /> Rinnovo contratto
                    </Button>
                )}
                {(isPresident || isCurrent) &&
                  playerReminders.some((r) => r.kind === "attivazione_prestito_diritto" && !r.done) && (
                  <>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={riscattaDirittoAction} className="border-[color:var(--success)]/50 text-[color:var(--success)]">
                      <ShieldCheckIcon size={14} className="mr-2" /> Esercita diritto di riscatto
                    </Button>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={terminaDirittoAction} className="border-[color:var(--danger)]/50 text-[color:var(--danger)]">
                      <SignOutIcon size={14} className="mr-2" /> Non esercitare diritto
                    </Button>
                  </>
                )}
                {(isPresident || isCurrent) && autoReleaseLoanReminder && (
                  <>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={mantieniPrestitoAction} className="border-[color:var(--success)]/50 text-[color:var(--success)] hover:bg-[color:var(--success)]/10">
                      <ShieldCheckIcon size={14} className="mr-2" /> Mantieni il prestito
                    </Button>
                    <Button variant="outline" size="sm" disabled={decisionLoading} onClick={terminaPrestitoAction} className="border-[color:var(--danger)]/50 text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10">
                      <SignOutIcon size={14} className="mr-2" /> Termina il prestito
                    </Button>
                  </>
                )}
                </div>
              </div>

              {/* Colonna destra: dati economici e contrattuali */}
              <div className="bg-[color:var(--bg-main)] border border-[color:var(--border)] rounded-xl p-5 space-y-3">
                <div className="text-[10px] uppercase tracking-widest text-[color:var(--gold)] font-bold mb-2">
                  Dati economici e contrattuali
                </div>
                <Row label="Valore Transfermarkt" value={fmtM(player.transfermarkt_value)} />
                <Row label="FantaValore" value={fmtIntM(player.fantavalore)} />
                <Row label="Cartellino" value={fmtIntM(player.cartellino)} highlight />
                <Row label="Stipendio Base" value={fmtM(player.salary)} />
                {isIngaggiato && (
                  <>
                    <Row label="Rinnovi" value={player.renewal_count !== 0 ? player.renewal_count : "—"} />
                    <Row label="Stipendio" value={fmtM(player.effective_salary)} highlight />
                    <Row label="Anni di contratto" value={player.contract_years != null ? `${player.contract_years} anni` : "—"} />
                    <Row label="Scadenza contratto" value={player.contract_end ? new Date(player.contract_end).toLocaleDateString("it-IT") : "—"} />
                    <Row label="Porzione onorata" value={contractPortion != null ? `${fmtM(contractPortion).replace(" M", "")} anni` : "—"} />
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-display">Modifica {player.name}</DialogTitle>
            </DialogHeader>
            <form onSubmit={saveEdit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nome</label>
                <Input required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value.toUpperCase() })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] uppercase" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Ruolo</label>
                <Select value={editForm.role} onValueChange={(v) => setEditForm({ ...editForm, role: v })}>
                  <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                  <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Anno di nascita</label>
                <Input required type="number" min="1950" max={seasonStartYear || undefined} step="1" value={editForm.birth_year} onChange={(e) => setEditForm({ ...editForm, birth_year: e.target.value.replace(/\D/g, "").slice(0, 4) })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Squadra reale</label>
                <Select
                  value={seasonTeams.includes(editForm.real_club) ? editForm.real_club : "altro"}
                  onValueChange={(v) => setEditForm({ ...editForm, real_club: v === "altro" ? "" : v })}
                >
                  <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {seasonTeams.map((club) => <SelectItem key={club} value={club}>{club}</SelectItem>)}
                    {!seasonTeams.includes(player.real_club) && (
                      <SelectItem value="altro">Altro (fuori Serie A)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {!seasonTeams.includes(editForm.real_club) && (
                  <Input required placeholder="Nome squadra" value={editForm.real_club} onChange={(e) => setEditForm({ ...editForm, real_club: e.target.value })} className="mt-2 bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                )}
              </div>
              <div className="col-span-2 space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Immagine</label>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Input
                    placeholder="Incolla un URL esterno…"
                    value={editForm.image}
                    onChange={(e) => setEditForm({ ...editForm, image: e.target.value })}
                    className="flex-1 bg-[color:var(--bg-main)] border-[color:var(--border)]"
                  />
                  <span className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-widest shrink-0">oppure</span>
                  <Input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={uploadingImage}
                    onChange={(e) => handleImageUpload(e.target.files?.[0])}
                    className="flex-1 bg-[color:var(--bg-main)] border-[color:var(--border)]"
                  />
                </div>
                {editForm.image && (
                  <a href={resolveImageUrl(editForm.image)} target="_blank" rel="noreferrer" className="text-xs text-[color:var(--gold)] hover:underline inline-block">
                    Anteprima attuale (apri)
                  </a>
                )}
                {uploadingImage && <div className="text-xs text-[color:var(--gold)]">Caricamento…</div>}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Valore Transfermarkt</label>
                <Input required type="number" min="0.1" step="0.1" value={editForm.transfermarkt_value} onChange={(e) => setEditForm({ ...editForm, transfermarkt_value: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">FantaValore</label>
                <Input required type="number" min="1" step="1" value={editForm.fantavalore} onChange={(e) => setEditForm({ ...editForm, fantavalore: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Stipendio Base</label>
                <Input required type="number" min="0" step="0.1" value={editForm.salary} onChange={(e) => setEditForm({ ...editForm, salary: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
              </div>
              {canEditJersey && (
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Numero maglia</label>
                  <Input type="number" min="0" step="1" value={editForm.jersey_number} onChange={(e) => setEditForm({ ...editForm, jersey_number: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                </div>
              )}
              <DialogFooter className="sm:col-span-2 gap-2 mt-2">
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Annulla</Button>
                <Button type="submit" disabled={saving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                  {saving ? "Salvo…" : "Salva"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    
      <Dialog open={proposeOpen} onOpenChange={setProposeOpen}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-display">Nuova squadra reale</DialogTitle>
          </DialogHeader>
          <form onSubmit={proposeAutoRelease} className="space-y-4">
            {hasPendingValidatedTransfer && (
              <p className="text-sm text-[color:var(--text-secondary)]">
                Il trasferimento convalidato verrà eseguito subito prima di avviare lo svincolo automatico alla nuova proprietà.
              </p>
            )}
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">
                Squadra (deve essere fuori Serie A)
              </label>
              <Input required value={newRealClub} onChange={(e) => setNewRealClub(e.target.value)} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setProposeOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Avvia</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-display">Firma primo contratto</DialogTitle>
          </DialogHeader>
          <form onSubmit={signContract} className="space-y-4">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Anni di contratto</label>
              <Select value={signForm.contract_years} onValueChange={(v) => setSignForm({ ...signForm, contract_years: v })}>
                <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 5].map((y) => <SelectItem key={y} value={String(y)}>{y} {y === 1 ? "anno" : "anni"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Numero maglia</label>
              <Input required type="number" min="0" step="1" value={signForm.jersey_number} onChange={(e) => setSignForm({ ...signForm, jersey_number: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setSignOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Firma</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={renewOpen} onOpenChange={setRenewOpen}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-display">Rinnovo contratto</DialogTitle>
          </DialogHeader>
          <form onSubmit={renewContract} className="space-y-4">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nuovi anni di contratto</label>
              <Select value={renewYears} onValueChange={setRenewYears}>
                <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 5].map((y) => <SelectItem key={y} value={String(y)}>{y} {y === 1 ? "anno" : "anni"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenewOpen(false)}>Annulla</Button>
              <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Rinnova</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function Row({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[color:var(--text-muted)]">{label}</span>
      <span className={`font-mono ${highlight ? "font-bold text-[color:var(--gold)]" : ""}`}>{value}</span>
    </div>
  );
}