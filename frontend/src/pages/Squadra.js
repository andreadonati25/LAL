import { useEffect, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import PlayerDialog from "@/components/PlayerDialog";
import api, { formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { SQUADRA } from "@/constants/testIds";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { PencilSimpleIcon, FloppyDiskIcon, FilePdfIcon, MapPinIcon, UserIcon, CoinsIcon, CrownIcon, TShirtIcon, CaretDownIcon} from "@phosphor-icons/react";

/* Componente Squadra che mostra la pagina di gestione della squadra scelta. */

const fmt = (n) => new Intl.NumberFormat("it-IT").format(Math.round(n || 0));
const fmtValue = (n) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(Number(n || 0));
const fmtMillions = (n, divideByMillion = true) => `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 }).format(divideByMillion ? Number(n || 0) / 1_000_000 : Number(n || 0))}M`;
const fmtM = (n) => {
  const rounded = Math.round(Number(n || 0) * 100) / 100;
  const isWhole = Number.isInteger(rounded);
  const isOneDecimal = !isWhole && Number.isInteger(rounded * 10);
  const minimumFraction = isWhole ? 0 : isOneDecimal ? 1 : 2;
  return `${new Intl.NumberFormat("it-IT", { minimumFractionDigits: minimumFraction, maximumFractionDigits: minimumFraction }).format(rounded)}M`;
};

const resolveImageUrl = (image) =>
  !image ? "" : /^https?:\/\//.test(image) ? image : `${process.env.REACT_APP_BACKEND_URL}/data/${image}`;

const ROLE_GRADIENT_COLORS = {
  P: "rgba(251, 146, 60, 0.35)",
  D: "rgba(56, 189, 248, 0.35)",
  C: "rgba(52, 211, 153, 0.35)",
  A: "rgba(248, 113, 113, 0.35)",
};
const ROLE_STYLES = {
  P: "border-orange-300/90 bg-orange-400/35 text-orange-100",
  D: "border-sky-300/90 bg-sky-400/35 text-sky-100",
  C: "border-emerald-300/90 bg-emerald-400/35 text-emerald-100",
  A: "border-red-300/90 bg-red-400/35 text-red-100",
};
const ROLE_ORDER = ["P", "D", "C", "A"];
const SEASON_MONTHS = ["luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre", "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno"];
const ROSTER_SECTIONS = [
  ["prima_squadra", "Prima Squadra"], ["primavera", "Primavera"], ["tribuna", "Tribuna"],
  ["estero", "Estero"], ["academy", "Academy"], ["in_prestito", "In prestito"],
];
const STADIUM_WORK_OPTIONS = [-20000, -10000, -5000, -2000, -1000, 0, 1000, 2000, 5000, 10000, 50000, 100000];
const OWNER_TEAM_FIELDS = [
  ["name", "Nome squadra", "text"],
  ["manager_name", "Allenatore", "text"], ["president_name", "Presidente", "text"],
  ["motto", "Motto", "text"],
  ["organigramma", "Organigramma (PDF)", "pdf-upload"], ["image", "Logo squadra", "image-upload"],
  ["color_1", "Colore 1", "color"], ["color_2", "Colore 2", "color"], ["color_3", "Colore 3", "color"],
  ["stadium_name", "Nome stadio", "text"], ["stadium_capacity", "Capienza stadio", "number"],
];
const PRESIDENT_TEAM_FIELDS = [
  ...OWNER_TEAM_FIELDS,
  ["vs", "Valore Società (M)", "money"], ["bdg_trasferimenti", "Budget trasferimenti (M)", "money"],
  ["bdg_stipendi", "Budget stipendi (M)", "money"], ["u_liberi", "Utili liberi (M)", "money"],
  ["aspettativa_stagionale", "Aspettativa", "number"], ["roster_value_summer", "Valore rosa Asta Estiva (M)", "decimal"], ["bdgt_dilazionato_30giu", "Budget Trasferimenti 30/06 (M)", "money"],
];
const PRESIDENT_TEAM_JSON_FIELDS = [
  ["stadium_capacity_by_month", "Capienza stadio per mese", false],
  ["salary_spend_by_month", "Spesa stipendi per mese (M)", true],
  ["utili", "Utili maturati (M)", true],
  ["vs_var", "Variazione Valore Società (M)", true],
];

const FULL_WIDTH_FIELDS = new Set(["name", "motto"]);
const THIRD_WIDTH_FIELDS = new Set(["color_1", "color_2", "color_3", "aspettativa_stagionale", "roster_value_summer", "bdgt_dilazionato_30giu"]);
const getFieldSpan = (k) =>
  FULL_WIDTH_FIELDS.has(k) ? "sm:col-span-6" : THIRD_WIDTH_FIELDS.has(k) ? "sm:col-span-2" : "sm:col-span-3";
const COMPACT_LABEL_FIELDS = new Set(["bdgt_dilazionato_30giu"]);

/* Mini-form per un campo JSON: una riga per chiave, con conversione in milioni se isMoney. */
function JsonFieldEditor({ value, onChange, isMoney }) {
  const obj = value && typeof value === "object" ? value : {};

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {Object.keys(obj).map((subKey) => {
        const val = obj[subKey];
        // Calcolo del valore visualizzato nell'input
        const displayValue = isMoney
          ? val === "" || val == null
            ? ""
            : Number(val) / 1_000_000
          : (val ?? "");
        return (
          <div key={subKey}>
            <label className="text-[9px] uppercase tracking-widest text-[color:var(--text-muted)] block mb-0.5">
              {subKey}
            </label>
            <Input
              type="number"
              step={isMoney ? "0.1" : "1"}
              value={displayValue}
              onChange={(e) => {
                const rawVal = e.target.value;
                let finalVal;

                if (rawVal === "") {
                  finalVal = ""; // Permette all'input di essere completamente svuotato
                } else if (isMoney) {
                  finalVal = Number(rawVal) * 1_000_000;
                } else {
                  finalVal = Number(rawVal);
                }

                onChange({ ...obj, [subKey]: finalVal });
              }}
              className="text-sm bg-[color:var(--bg-surface)] border-[color:var(--border)]"
            />
          </div>
        );
      })}
    </div>
  );
}

function groupByRole(players) {
  const groups = {};
  players.forEach((p) => {
    const r = p.role || "?";
    (groups[r] ||= []).push(p);
  });
  return ROLE_ORDER.filter((r) => groups[r]?.length).map((r) => [r, groups[r]]);
}

const assetUrl = (name) => name ? `${process.env.REACT_APP_BACKEND_URL}/data/${encodeURIComponent(name)}` : "";

export default function Squadra() {
  const { user } = useAuth();
  const { id: paramId } = useParams();
  const nav = useNavigate();
  const [teams, setTeams] = useState([]);
  /* Se paramId è presente, significa che stiamo visualizzando una squadra specifica, altrimenti mostriamo la squadra dell'utente loggato (se presente). */
  const [teamId, setTeamId] = useState(paramId || user?.team_id || null);
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState({});
  const [captainIds, setCaptainIds] = useState({ captain: null, vice: null });
  const [rosterStats, setRosterStats] = useState({ contracted_players: 0, academy_market_value: 0 });
  const [teamForm, setTeamForm] = useState(null);
  const [editTeamOpen, setEditTeamOpen] = useState(false);
  const [stadiumWorkOpen, setStadiumWorkOpen] = useState(false);
  const [stadiumWork, setStadiumWork] = useState(1000);
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [nextComposition, setNextComposition] = useState(null);
  const [compositionDraft, setCompositionDraft] = useState(null);
  const [compositionSaving, setCompositionSaving] = useState(false);
  const [draggedPlayerId, setDraggedPlayerId] = useState(null);
  const [dragOverSection, setDragOverSection] = useState(null);
  const [dragOverPlayerId, setDragOverPlayerId] = useState(null);
  const [seasonTeams, setSeasonTeams] = useState([]);
  const [seasonStartYear, setSeasonStartYear] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [reminders, setReminders] = useState([]);
  const [nowCompositionOpen, setNowCompositionOpen] = useState(false);
  const [nowCompositionDraft, setNowCompositionDraft] = useState(null);
  const [nowCompositionSaving, setNowCompositionSaving] = useState(false);
  const [captainOpen, setCaptainOpen] = useState(false);
  const [captainForm, setCaptainForm] = useState({ captain_id: "", vice_captain_id: "" });
  const [captainSaving, setCaptainSaving] = useState(false);
  const [uploading, setUploading] = useState({});
  const [jerseyOpen, setJerseyOpen] = useState(false);
  const [jerseyDraft, setJerseyDraft] = useState({});
  const [jerseySaving, setJerseySaving] = useState(false);
  
  const handleDropGeneric = (draft, setDraft, targetSection, targetPlayerId = null) => {
    if (!draggedPlayerId) return;
    const from = ["prima_squadra", "primavera", "tribuna"].find((s) => draft[s].includes(draggedPlayerId));
    if (from) {
      const fromArr = draft[from].filter((id) => id !== draggedPlayerId);
      const toArr = from === targetSection ? fromArr : [...draft[targetSection]];
      let toIdx = targetPlayerId ? toArr.indexOf(targetPlayerId) : toArr.length;
      if (toIdx === -1) toIdx = toArr.length;
      toArr.splice(toIdx, 0, draggedPlayerId);
      setDraft({ ...draft, [from]: from === targetSection ? toArr : fromArr, [targetSection]: toArr });
    }
    setDraggedPlayerId(null);
    setDragOverSection(null);
    setDragOverPlayerId(null);
  };
  const handleDrop = (targetSection, targetPlayerId = null) => handleDropGeneric(compositionDraft, setCompositionDraft, targetSection, targetPlayerId);
  const handleDropNow = (targetSection, targetPlayerId = null) => handleDropGeneric(nowCompositionDraft, setNowCompositionDraft, targetSection, targetPlayerId); 

  const openPlayer = (p) => {
    const next = new URLSearchParams(searchParams);
    next.set("player", p.id);
    setSearchParams(next);
  };

  /* Permessi: il presidente può modificare tutto, il proprietario può gestire. */
  const isPresident = user?.role === "presidente";
  const isOwner = user?.team_id === teamId;
  const canManageOwn = isPresident || isOwner;  // proprietario può gestire tier

  /* Queste costanti servono solo per decidere cosa mostrare, la sicurezza vera è nel backend. */

  const load = async (tid) => {
    if (!tid) return;
    const [{ data: t }, { data: currentRoster }, { data: season }, { data: rems}, { data: nextcomp}] = await Promise.all([
      api.get(`/teams/${tid}`),
      api.get(`/teams/${tid}/roster-current`),
      api.get("/season/current"),
      api.get("/reminders", { params: { limit: null } }),
      api.get(`/teams/${tid}/roster-next`),
    ]);
    setTeam(t);
    setRoster(currentRoster.sections || {});
    setCaptainIds({ captain: currentRoster.captain_id, vice: currentRoster.vice_captain_id });
    setRosterStats({ contracted_players: currentRoster.contracted_players || 0, academy_market_value: currentRoster.academy_market_value || 0 });
    setTeamForm(t);
    setSeasonStartYear(season.season_start_year);
    setSeasonTeams(season.squadre_serie_a || []); 
    setReminders(rems);
    setNextComposition(nextcomp)
  };

  useEffect(() => {
    api.get("/teams").then(({ data }) => {
      setTeams(data);
      const initial = paramId || user?.team_id || data[0]?.id;
      if (initial) { setTeamId(initial); load(initial); }
    });
  }, [paramId, user]);

  useEffect(() => { if (teamId) load(teamId); }, [teamId]);

  const startStadiumWork = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/teams/${teamId}/stadium-works`, { stadium_work: Number(stadiumWork) });
      toast.success("Lavori allo stadio avviati");
      setStadiumWorkOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const openComposition = async () => {
    try {
      setCompositionDraft({
        prima_squadra: nextComposition.sections.prima_squadra.map((player) => player.id),
        primavera: nextComposition.sections.primavera.map((player) => player.id),
        tribuna: nextComposition.sections.tribuna.map((player) => player.id),
      });
      setCompositionOpen(true);
    } catch (e) { toast.error(formatApiError(e.response?.nextComposition?.detail)); }
  };

    const copyCurrentComposition = () => {
    if (!nextComposition || !compositionDraft) return;
    const sections = ["prima_squadra", "primavera", "tribuna"];
    const candidateIds = new Set(sections.flatMap((s) => nextComposition.sections[s].map((p) => p.id)));
    const newDraft = { prima_squadra: [], primavera: [], tribuna: [] };
    const placed = new Set();
    sections.forEach((section) => {
      (roster[section] || []).forEach((p) => {
        if (candidateIds.has(p.id) && !placed.has(p.id)) {
          newDraft[section].push(p.id);
          placed.add(p.id);
        }
      });
    });
    sections.forEach((section) => {
      compositionDraft[section].forEach((id) => {
        if (!placed.has(id) && candidateIds.has(id)) {
          newDraft[section].push(id);
          placed.add(id);
        }
      });
    });
    setCompositionDraft(newDraft);
  };

  const saveComposition = async (e) => {
    e.preventDefault();
    const sectionsUnchanged = ["prima_squadra", "primavera", "tribuna"].every((s) =>
      JSON.stringify(compositionDraft[s]) === JSON.stringify(nextComposition.sections[s].map((p) => p.id))
    );
    if (sectionsUnchanged) {
      toast.info("Nessuna modifica da salvare");
      setCompositionOpen(false);
      return;
    }
    const playersById = Object.values(nextComposition.sections).flat().reduce((playersMap, player) => ({ ...playersMap, [player.id]: player }), {});
    if (nextComposition.captain_id && compositionDraft.primavera.includes(nextComposition.captain_id)) {
      toast.error("Il capitano non può essere inserito in Primavera");
      return;
    }
    const over23 = compositionDraft.primavera.filter((id) => nextComposition.season_start_year - playersById[id].birth_year > 23).length;
    if (over23 > 2) {
      toast.error("Massimo 2 giocatori over-23 in Primavera");
      return;
    }
    const roleLimits = { P: 3, D: 8, C: 8, A: 6 };
    const roleCounts = compositionDraft.prima_squadra.reduce((counts, id) => {
      const role = playersById[id]?.role;
      return { ...counts, [role]: (counts[role] || 0) + 1 };
    }, {});
    if (Object.entries(roleLimits).some(([role, limit]) => (roleCounts[role] || 0) > limit)) {
      toast.error("Superati i limiti di ruolo della Prima Squadra");
      return;
    }
    try {
      setCompositionSaving(true);
      await api.post(`/teams/${teamId}/roster-next`, compositionDraft);
      toast.success("Composizione rosa aggiornata");
      setCompositionOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    finally { setCompositionSaving(false); }
  };

  const openNowComposition = () => {
    setNowCompositionDraft({
      prima_squadra: (roster.prima_squadra || []).map((p) => p.id),
      primavera: (roster.primavera || []).map((p) => p.id),
      tribuna: (roster.tribuna || []).map((p) => p.id),
    });
    setNowCompositionOpen(true);
  };

  const nowPlayersById = Object.values(roster).flat().reduce((map, p) => ({ ...map, [p.id]: p }), {});

  const saveNowComposition = async (e) => {
    e.preventDefault();
    const sectionsUnchanged = ["prima_squadra", "primavera", "tribuna"].every((s) =>
      JSON.stringify(nowCompositionDraft[s]) === JSON.stringify((roster[s] || []).map((p) => p.id))
    );
    if (sectionsUnchanged) {
      toast.info("Nessuna modifica da salvare");
      setNowCompositionOpen(false);
      return;
    }
    if (captainIds.captain && nowCompositionDraft.primavera.includes(captainIds.captain)) {
      toast.error("Il capitano non può essere inserito in Primavera");
      return;
    }
    const over23 = nowCompositionDraft.primavera.filter((id) => seasonStartYear - nowPlayersById[id].birth_year > 23).length;
    if (over23 > 2) {
      toast.error("Massimo 2 giocatori over-23 in Primavera");
      return;
    }
    const roleLimits = { P: 3, D: 8, C: 8, A: 6 };
    const roleCounts = nowCompositionDraft.prima_squadra.reduce((counts, id) => {
      const role = nowPlayersById[id]?.role;
      return { ...counts, [role]: (counts[role] || 0) + 1 };
    }, {});
    if (Object.entries(roleLimits).some(([role, limit]) => (roleCounts[role] || 0) > limit)) {
      toast.error("Superati i limiti di ruolo della Prima Squadra");
      return;
    }
    try {
      setNowCompositionSaving(true);
      await api.post(`/teams/${teamId}/roster-now`, nowCompositionDraft);
      toast.success("Composizione rosa attuale aggiornata");
      setNowCompositionOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    finally { setNowCompositionSaving(false); }
  };

    const saveTeam = async (e) => {
    e.preventDefault();
    const numericFields = ["vs", "bdg_trasferimenti", "bdg_stipendi", "u_liberi", "stadium_capacity", "aspettativa_stagionale", "roster_value_summer", "bdgt_dilazionato_30giu"];
    const jsonFields = ["stadium_capacity_by_month", "salary_spend_by_month", "utili", "vs_var"];
    const normalized = { ...teamForm };
    numericFields.forEach((k) => {
      if (normalized[k] !== undefined) normalized[k] = Number(normalized[k] || 0);
    });
    jsonFields.forEach((k) => {
      if (typeof normalized[k] === "string") {
        try { normalized[k] = JSON.parse(normalized[k]); } catch { /* lasciato invariato, errore gestito dal backend */ }
      }
    });
    const payload = {};
    Object.keys(normalized).forEach((k) => {
      const before = jsonFields.includes(k) ? JSON.stringify(team?.[k] ?? {}) : team?.[k];
      const after = jsonFields.includes(k) ? JSON.stringify(normalized[k] ?? {}) : normalized[k];
      if (after !== before) payload[k] = normalized[k];
    });
    if (Object.keys(payload).length === 0) {
      toast.info("Nessuna modifica da salvare");
      setEditTeamOpen(false);
      return;
    }
    try {
      await api.patch(`/teams/${teamId}`, payload);
      toast.success("Squadra aggiornata");
      setEditTeamOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
  };

  const handleFileUpload = async (field, category, file) => {
    if (!file) return;
    setUploading((u) => ({ ...u, [field]: true }));
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/uploads", fd, {
        params: { category },
        headers: { "Content-Type": "multipart/form-data" },
      });
      setTeamForm((f) => ({ ...f, [field]: data.filename }));
      toast.success("File caricato");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setUploading((u) => ({ ...u, [field]: false }));
    }
  };

  const currentSeasonMonthIndex = (new Date().getMonth() + 6) % 12;
  const confirmedSalarySpend = SEASON_MONTHS
    .slice(0, currentSeasonMonthIndex)
    .filter((month) => month !== "luglio" && month !== "giugno")
    .reduce((total, month) => total + Number(team?.salary_spend_by_month?.[month] || 0), 0);
  const nextPlayersById = nextComposition
    ? Object.values(nextComposition.sections).flat().reduce((playersMap, player) => ({ ...playersMap, [player.id]: player }), {})
    : {};

  const draftMonthlySpend = compositionDraft
  ? [...compositionDraft.prima_squadra, ...compositionDraft.tribuna, ...nextComposition.sections.estero.map((player) => player.id)]
      .reduce((sum, id) => sum + Number(nextPlayersById[id]?.effective_salary || 0) / 10, 0)
  : 0;
  
  const nowdraftMonthlySpend = nowCompositionDraft
  ? [...nowCompositionDraft.prima_squadra, ...nowCompositionDraft.tribuna, ...(roster.estero || []).map((p) => p.id)]
      .reduce((sum, id) => sum + Number(nowPlayersById[id]?.effective_salary || 0) / 10, 0)
  : 0;

  const sortAutoPlayers = (players) =>
    [...players].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name, "it"));

  const CaptainBadge = () => (
  <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-bold text-amber-400 border border-amber-500/30" title="Capitano">C</span>
  );

  const ViceCaptainBadge = () => (
    <span className="inline-flex items-center gap-1 rounded bg-slate-500/10 px-1.5 py-0.5 text-xs font-bold text-slate-300 border border-slate-500/30" title="Vice Capitano">VC</span>
  );

  const eligibleCaptains = Object.values(roster).flat()
    .filter((p) => p.fanta_team_id === teamId && p.current_team_id === teamId && p.tier === "utilizzabile");

  const missingCaptain = !captainIds.captain;
  const missingVice = !captainIds.vice;
  const captainMode = missingCaptain && missingVice ? "both" : missingCaptain ? "captain-only" : missingVice ? "vice-only" : "edit-both";

  const captainButtonLabel = missingCaptain && missingVice ? "Nomina capitano e vice"
    : missingCaptain ? "Nomina il capitano"
    : missingVice ? "Nomina il vice capitano"
    : "Modifica capitano e vice";

  const hasCaptainReminder = reminders.some((r) => r.entity === "team" && r.entity_id === teamId && r.kind === "capitano_vice" && !r.done);
  const showCaptainBtn = isPresident || (isOwner && hasCaptainReminder);  

  const openCaptainDialog = () => {
    setCaptainForm({ captain_id: captainIds.captain || "", vice_captain_id: captainIds.vice || "" });
    setCaptainOpen(true);
  };

  const onCaptainSelect = (v) => {
    setCaptainForm((f) => {
      const next = { ...f, captain_id: v };
      if (captainMode === "captain-only") {
        next.vice_captain_id = v === captainIds.vice ? "" : captainIds.vice;
      }
      return next;
    });
  };

  const saveCaptainVice = async (e) => {
    e.preventDefault();
    if (!captainForm.captain_id || !captainForm.vice_captain_id || captainForm.captain_id === captainForm.vice_captain_id) {
      toast.error("Seleziona due giocatori diversi");
      return;
    }
    if (captainForm.captain_id === (captainIds.captain || "") && captainForm.vice_captain_id === (captainIds.vice || "")) {
      toast.info("Nessuna modifica da salvare");
      setCaptainOpen(false);
      return;
    }
    setCaptainSaving(true);
    try {
      await api.post(`/teams/${teamId}/capitano`, null, {
        params: { captain_id: captainForm.captain_id, vice_captain_id: captainForm.vice_captain_id },
      });
      toast.success("Capitano e vice aggiornati");
      setCaptainOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    finally { setCaptainSaving(false); }
  };

  const jerseyPlayers = Object.values(roster).flat().filter((p) => p.current_team_id === teamId && p.tier !== "academy");
  const hasJerseyReminder = reminders.some((r) => r.team_id === teamId && !r.done && ["numero_maglia_mancante", "numero_maglia_duplicato"].includes(r.kind));
  const showJerseyBtn = isPresident || (isOwner && hasJerseyReminder);

  const openJersey = () => {
    setJerseyDraft(Object.fromEntries(jerseyPlayers.map((p) => [p.id, p.jersey_number ?? ""])));
    setJerseyOpen(true);
  };

  const saveJerseyNumbers = async (e) => {
    e.preventDefault();
    const values = Object.values(jerseyDraft).filter((v) => v !== "").map(Number);
    if (new Set(values).size !== values.length) {
      toast.error("Numeri di maglia duplicati");
      return;
    }
    const unchanged = jerseyPlayers.every((p) => String(jerseyDraft[p.id] ?? "") === String(p.jersey_number ?? ""));
    if (unchanged) {
      toast.info("Nessuna modifica da salvare");
      setJerseyOpen(false);
      return;
    }
    setJerseySaving(true);
    try {
      const numbers = Object.fromEntries(Object.entries(jerseyDraft).map(([id, v]) => [id, v === "" ? null : Number(v)]));
      await api.patch(`/teams/${teamId}/jersey-numbers`, { numbers });
      toast.success("Numeri di maglia aggiornati");
      setJerseyOpen(false);
      load(teamId);
    } catch (e) { toast.error(formatApiError(e.response?.data?.detail)); }
    finally { setJerseySaving(false); }
  };

  const c1 = team?.color_1 || "#6B21A8";
  const c2 = team?.color_2 || c1;
  const c3 = team?.color_3 || c2;

  const activeMonths = SEASON_MONTHS.filter((m) => m !== "luglio" && m !== "giugno");
  const pastMonths = activeMonths.slice(0, currentSeasonMonthIndex - 1); // Escludiamo il mese corrente perché non è ancora confermato
  const remainingMonthsCount = activeMonths.length - pastMonths.length;
  const lastPlayedMonth = pastMonths[pastMonths.length - 1];
  const currentMonthlyRate = lastPlayedMonth ? Number(team?.salary_spend_by_month?.[lastPlayedMonth] || 0) : 0;
  const isEarly = pastMonths.length <= 1;
  const projectedAnnualSpend = !isEarly && currentMonthlyRate > 0
    ? confirmedSalarySpend + (currentMonthlyRate * remainingMonthsCount)
    : null;

  return (
    <div data-testid={SQUADRA.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">Squadra</div>
          <h1 className="font-display text-[clamp(2rem,5vw,3rem)] font-bold tracking-tighter max-w-full">
            <Select value={teamId || ""} onValueChange={(v) => { setTeamId(v); nav(`/squadra/${v}`); }}>
              <SelectTrigger className="h-auto w-auto max-w-full gap-3 border-0 bg-transparent p-0 font-display text-[clamp(2rem,5vw,3rem)] font-bold leading-tight tracking-tighter text-inherit shadow-none hover:bg-transparent focus:ring-0 [&>span]:text-inherit [&>span]:line-clamp-none [&>span]:break-words">
                <SelectValue placeholder="Seleziona squadra" />
              </SelectTrigger>
              <SelectContent>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </h1>
          {team?.users?.length > 0 && (
            <div className="text-[color:var(--text-muted)] mt-1">
              {team.users.map((teamUser) => teamUser.name).join(", ")}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Modifiche */}
          {canManageOwn && (
            <Dialog open={editTeamOpen} onOpenChange={setEditTeamOpen}>
              <DialogTrigger asChild>
                <Button data-testid={SQUADRA.saveTeamBtn} variant="outline" className="border-[color:var(--border)]">
                  <PencilSimpleIcon size={16} className="mr-2" /> Dati Club
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl">
                <DialogHeader><DialogTitle>Modifica dati club</DialogTitle></DialogHeader>
                <form onSubmit={saveTeam} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                  <div className="grid grid-cols-1 sm:grid-cols-6 gap-4">
                    {(isPresident ? PRESIDENT_TEAM_FIELDS : OWNER_TEAM_FIELDS).map(([k, label, type]) => (
                      <div key={k} className={getFieldSpan(k)}>
                        <label className={`uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1 whitespace-nowrap ${COMPACT_LABEL_FIELDS.has(k) ? "text-[9px]" : "text-[10px]"}`}>
                          {label}
                          {(type === "pdf-upload" || type === "image-upload") && teamForm?.[k] && (
                            <>
                              {" - "}
                              <a href={assetUrl(teamForm[k])} target="_blank" rel="noreferrer" className="normal-case font-normal text-[color:var(--gold)] hover:underline">
                                File attuale
                              </a>
                            </>
                          )}
                        </label>
                        {type === "color" ? (
                          <Input type="color" value={teamForm?.[k] || "#000000"} onChange={(e) => setTeamForm({ ...teamForm, [k]: e.target.value })} className="h-10 bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                        ) : type === "image-upload" || type === "pdf-upload" ? (
                          <div className="space-y-1">
                            <Input
                              type="file"
                              accept={type === "image-upload" ? "image/png,image/jpeg,image/webp" : "application/pdf"}
                              disabled={uploading[k]}
                              onChange={(e) => handleFileUpload(k, type === "image-upload" ? "team-logo" : "team-organigramma", e.target.files?.[0])}
                              className="bg-[color:var(--bg-main)] border-[color:var(--border)]"
                            />
                            {uploading[k] && <div className="text-xs text-[color:var(--gold)]">Caricamento…</div>}
                          </div>
                        ) : type === "money" ? (
                          <Input
                            type="number"
                            step="0.1"
                            value={teamForm?.[k] === "" || teamForm?.[k] == null ? "" : Number(teamForm[k]) / 1_000_000}
                            onChange={(e) => setTeamForm({ ...teamForm, [k]: e.target.value === "" ? "" : Number(e.target.value) * 1_000_000 })}
                            className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono"
                          />
                        ) : type === "decimal" ? (
                          <Input type="number" step="0.1" value={teamForm?.[k] ?? ""} onChange={(e) => setTeamForm({ ...teamForm, [k]: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                        ) : (
                          <Input type={type} value={teamForm?.[k] ?? ""} onChange={(e) => setTeamForm({ ...teamForm, [k]: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                        )}
                      </div>
                    ))}
                  </div>

                  {isPresident && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {PRESIDENT_TEAM_JSON_FIELDS.map(([k, label, isMoney]) => (
                        <Collapsible key={k} className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-main)] overflow-hidden">
                          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-left">
                            <span className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">{label}</span>
                            <CaretDownIcon size={14} className="shrink-0 text-[color:var(--text-muted)] transition-transform group-data-[state=open]:rotate-180" />
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="p-3 border-t border-[color:var(--border)]">
                              <JsonFieldEditor
                                value={teamForm?.[k]}
                                isMoney={isMoney}
                                onChange={(v) => setTeamForm({ ...teamForm, [k]: v })}
                              />
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      ))}
                    </div>
                  )}

                  <DialogFooter>
                    <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                      <FloppyDiskIcon size={16} className="mr-2" /> Salva
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          )}
          {/* Capitano e vice */}
          {showCaptainBtn && (
            <Button variant="outline" onClick={openCaptainDialog} className="border-[color:var(--border)]">
              <CrownIcon size={16} className="mr-2" /> {captainButtonLabel}
            </Button>
          )}
          <Dialog open={captainOpen} onOpenChange={setCaptainOpen}>
            <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
              <DialogHeader>
                <DialogTitle className="text-xl font-display">Capitano e vice capitano</DialogTitle>
              </DialogHeader>
              <form onSubmit={saveCaptainVice} className="space-y-4">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Capitano</label>
                  {captainMode === "vice-only" ? (
                    <div className="h-10 flex items-center px-3 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elev)] text-sm text-[color:var(--text-muted)]">
                      {nowPlayersById[captainIds.captain]?.name || "—"}
                    </div>
                  ) : (
                    <Select value={captainForm.captain_id} onValueChange={onCaptainSelect}>
                      <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue placeholder="Scegli capitano" /></SelectTrigger>
                      <SelectContent>
                        {eligibleCaptains.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Vice capitano</label>
                  {captainMode === "captain-only" && captainForm.captain_id !== captainIds.vice ? (
                    <div className="h-10 flex items-center px-3 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elev)] text-sm text-[color:var(--text-muted)]">
                      {nowPlayersById[captainIds.vice]?.name || "—"}
                    </div>
                  ) : (
                    <Select value={captainForm.vice_captain_id} onValueChange={(v) => setCaptainForm({ ...captainForm, vice_captain_id: v })}>
                      <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue placeholder="Scegli vice" /></SelectTrigger>
                      <SelectContent>
                        {eligibleCaptains.filter((p) => p.id !== captainForm.captain_id).map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <DialogFooter className="gap-2">
                  <Button type="button" variant="ghost" onClick={() => setCaptainOpen(false)}>Annulla</Button>
                  <Button type="submit" disabled={captainSaving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                    {captainSaving ? "Salvo…" : "Salva"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {/* Numeri di maglia */}
          {showJerseyBtn && (
            <Button variant="outline" onClick={openJersey} className="border-[color:var(--border)]">
              <TShirtIcon size={16} className="mr-2" /> Numeri di maglia
            </Button>
          )}
          <Dialog open={jerseyOpen} onOpenChange={setJerseyOpen}>
            <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-3xl max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Numeri di maglia</DialogTitle></DialogHeader>
              <form onSubmit={saveJerseyNumbers} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {[...jerseyPlayers]
                    .sort((a, b) => {
                      const av = jerseyDraft[a.id] === "" ? -1 : Number(jerseyDraft[a.id]);
                      const bv = jerseyDraft[b.id] === "" ? -1 : Number(jerseyDraft[b.id]);
                      return av - bv;
                    })
                    .map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-main)] p-3 w-full">
                      {/* Sezione immagine e nome (occupa tutto lo spazio rimanente) */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {p.image ? (
                          <img src={resolveImageUrl(p.image)} alt="" className="h-8 w-8 rounded object-cover shrink-0" />
                        ) : (
                          <div className="h-8 w-8 rounded bg-[color:var(--bg-elev)] flex items-center justify-center shrink-0 text-[color:var(--text-muted)]">
                            <UserIcon size={14} weight="fill" />
                          </div>
                        )}
                        <span className="text-sm font-medium leading-tight text-[color:var(--text-main)] truncate">
                          {p.name}
                        </span>
                      </div>
                      
                      {/* Selettore fisso a destra che non uscirà mai dal box */}
                      <select
                        value={jerseyDraft[p.id] ?? ""}
                        onChange={(e) => setJerseyDraft({ ...jerseyDraft, [p.id]: e.target.value })}
                        className="w-20 h-8 text-xs font-mono bg-[color:var(--bg-surface)] border border-[color:var(--border)] rounded px-2 shrink-0"
                      >
                        <option value="">-</option>
                        {Array.from({ length: 100 }, (_, i) => i).map((num) => {
                          const isUsedByOther = Object.entries(jerseyDraft).some(
                            ([playerId, val]) => Number(val) === num && playerId !== p.id
                          );
                          const isCurrent = Number(jerseyDraft[p.id]) === num;

                          if (isUsedByOther && !isCurrent) return null;

                          return (
                            <option key={num} value={num}>
                              {num}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  ))}
                </div>
                <DialogFooter className="gap-2">
                  <Button type="button" variant="ghost" onClick={() => setJerseyOpen(false)}>Annulla</Button>
                  <Button type="submit" disabled={jerseySaving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                    {jerseySaving ? "Salvo…" : "Salva"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>                    
        </div>
      </div>
      {/* Informazioni squadra */}
      {team && (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] mb-8">
          <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)] overflow-hidden">
            <CardContent className="p-0">
              <div className="flex flex-col sm:flex-row">
                <div className="h-48 w-full sm:h-auto sm:w-48 shrink-0 flex items-center justify-center p-4 border rounded-xl"
                  style={{
                  background: `linear-gradient(to bottom right, ${c1} 20%, ${c2} 80%)`,
                  borderColor: c3,
                  }}
                >
                  {team.image && (
                    <img src={assetUrl(team.image)} alt={`Stemma ${team.name}`} className="max-h-full max-w-full object-contain" />
                  )}
                </div>
                <div className="p-5 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-[color:var(--text-muted)]">
                    <MapPinIcon size={16} />
                    <span>{team.stadium_name || "Stadio non indicato"}{team.stadium_capacity ? ` · ${fmt(team.stadium_capacity)} posti` : ""}</span>
                    {canManageOwn && (
                      <Dialog open={stadiumWorkOpen} onOpenChange={setStadiumWorkOpen}>
                        <Button type="button" size="sm" variant="outline" onClick={() => setStadiumWorkOpen(true)} className="h-7 border-[color:var(--border)] text-xs">
                          Lavori allo stadio
                        </Button>
                        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-md">
                          <DialogHeader><DialogTitle>Avvia lavori allo stadio</DialogTitle></DialogHeader>
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elev)] p-3">
                              <div className="text-xs text-[color:var(--text-muted)]">Capienza attuale</div>
                              <div className="font-mono font-bold mt-1">{fmt(team.stadium_capacity)} posti</div>
                            </div>
                            <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elev)] p-3">
                              <div className="text-xs text-[color:var(--text-muted)]">Utili liberi</div>
                              <div className="font-mono font-bold mt-1">{fmtMillions(team.u_liberi)}</div>
                            </div>
                          </div>
                          {team.stadium_works_active ? (
                            <div className="rounded-md border border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 p-3 text-sm text-[color:var(--danger)]">
                              Non puoi avviare altri lavori: è già attivo un reminder per i lavori allo stadio di questa squadra.
                            </div>
                          ) : (
                            <form onSubmit={startStadiumWork} className="space-y-4">
                              <div>
                                <label className="text-xs uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Variazione capienza</label>
                                <Select value={String(stadiumWork)} onValueChange={(value) => setStadiumWork(Number(value))}>
                                  <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {STADIUM_WORK_OPTIONS.map((value) => (
                                      <SelectItem key={value} value={String(value)} disabled={value === 0}>
                                        {value > 0 ? `+${fmt(value)}` : fmt(value)} posti{value === 0 ? " (nessuna variazione)" : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <DialogFooter>
                                <Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Avvia lavori</Button>
                              </DialogFooter>
                            </form>
                          )}
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                  {team.motto && <p className="mt-5 text-lg italic">“{team.motto}”</p>}
                  <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    {team.manager_name && <div><span className="text-[color:var(--text-muted)]">Allenatore</span><br />{team.manager_name}</div>}
                    {team.president_name && <div><span className="text-[color:var(--text-muted)]">Presidente</span><br />{team.president_name}</div>}
                  </div>
                  {team.organigramma && <a href={assetUrl(team.organigramma)} target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 text-sm text-[color:var(--gold)] hover:underline"><FilePdfIcon size={18} /> Apri organigramma</a>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 border-t border-[color:var(--border)] p-5">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">Giocatori ingaggiati</div>
                  <div className="font-mono text-lg font-bold text-white mt-1">{rosterStats.contracted_players}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">Valore mercato Academy</div>
                  <div className="font-mono text-lg font-bold text-white mt-1">{fmtValue(rosterStats.academy_market_value)}M</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            {[['Valore Società', team.vs, team.aspettativa_stagionale], ['Budget trasferimenti', team.bdg_trasferimenti], ['Budget stipendi', team.bdg_stipendi], ['Utili liberi', team.u_liberi], ['Valore rosa', team.roster_value_current]].filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value, expectation]) => (
              <div key={label} className="border border-[color:var(--border)] rounded-xl p-4 bg-[color:var(--bg-surface)]">
                <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">{label}</div>
                {label !== "Valore rosa" && (<div className="font-mono text-lg font-bold text-white mt-1">{fmtMillions(value, label !== "Valore rosa")}</div>)}
                {label === "Valore rosa" && (<div className="font-mono text-lg font-bold text-white mt-1">{fmtValue(value)}M</div>)}
                {label === "Valore Società" && expectation !== null && expectation !== undefined && expectation !== 0 && <div className="text-xs text-[color:var(--text-muted)] mt-1">Aspettativa: {expectation}</div>}
              </div>
            ))}
            <div className="border border-[color:var(--border)] rounded-xl p-4 bg-[color:var(--bg-surface)] flex flex-col justify-between">
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold">
                Monte Ingaggi
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[color:var(--border)]/40 pt-2">
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-[color:var(--text-muted)] font-semibold">
                    Maturato
                  </div>
                  <div className="font-mono text-base sm:text-lg font-bold text-white mt-0.5">
                    {fmtMillions(confirmedSalarySpend)}
                  </div>
                </div>
                <div className="border-l border-[color:var(--border)]/40 pl-2">
                  <div className="text-[9px] uppercase tracking-wider text-[color:var(--text-muted)] font-semibold">
                    Stimato Annuo
                  </div>
                  <div className="font-mono text-base sm:text-lg font-bold text-white mt-0.5">
                    {projectedAnnualSpend !== null ? fmtMillions(projectedAnnualSpend) : "??"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
      {/* Squadra effettiva se c'è */}
      {(Object.values(roster).every(lst => lst.length === 0)) ? (
        <div className="border border-[color:var(--border)] rounded-xl p-4 bg-[color:var(--bg-surface)] flex flex-col justify-between">
          <div className="p-10 text-center text-[color:var(--text-muted)] text-sm">Nessun giocatore in questa squadra.</div>
        </div>
      ) : (
        <>
        <Tabs key={teamId} defaultValue={ROSTER_SECTIONS.find(([section]) => (roster[section] || []).length > 0)?.[0]} className="w-full">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]">
              <TabsList className="bg-[color:var(--bg-surface)] border border-[color:var(--border)] p-1 flex-nowrap w-max">
                {ROSTER_SECTIONS.map(([section, label]) => (
                  ((roster[section] || []).length !== 0) && (
                  <TabsTrigger
                    key={section}
                    value={section}
                    className="data-[state=active]:bg-[color:var(--primary)] data-[state=active]:text-white text-xs sm:text-sm whitespace-nowrap"
                  >
                    {label} ({(roster[section] || []).length})
                  </TabsTrigger>
                  )
                ))}
              </TabsList>
            </div>
            {canManageOwn && (
              <Button type="button" variant="outline" onClick={openComposition} className="border-[color:var(--border)] shrink-0">
                Composizione rosa {nextComposition?.target || ""}
              </Button>
            )}
            {isPresident && (
              <Button type="button" variant="outline" onClick={openNowComposition} className="border-[color:var(--border)] shrink-0">
                Composizione rosa attuale
              </Button>
            )}
          </div>

          {ROSTER_SECTIONS.map(([section, label]) => (
            <TabsContent key={section} value={section}>
              <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
                <CardContent className="p-4 sm:p-5">
                  <div className="space-y-6">
                    {groupByRole(roster[section] || []).map(([role, rolePlayers]) => (
                      <div key={role}
                        className="p-4 rounded-xl mb-6"
                        style={{
                          background: `linear-gradient(0deg, ${ROLE_GRADIENT_COLORS[role]} 15%, var(--bg-surface) 85%)`,
                        }}
                      >
                        <div className="flex items-center gap-2 mb-3">
                          <span className={`text-xs font-mono font-bold border rounded px-2 py-0.5 ${ROLE_STYLES[role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>
                            {role} ({(rolePlayers || []).length})
                          </span>
                          <div className={`flex-1 h-px ${ROLE_STYLES[role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`} />
                        </div>
                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                          {rolePlayers.map((p) => {
                            const isCaptain = p.id === captainIds.captain;
                            const isViceCaptain = p.id === captainIds.vice;
                            return (
                              <button key={p.id} type="button" onClick={() => openPlayer(p)} className="text-left">
                                <Card className="bg-[color:var(--bg-main)] border-[color:var(--border)] card-lift h-full">
                                  <CardContent className="p-2 flex flex-col items-center text-center gap-2">
                                    {p.image ? (
                                      <img src={resolveImageUrl(p.image)} alt="" className="h-20 w-20 rounded-lg object-cover shadow-sm" />
                                    ) : (
                                      <div className="h-20 w-20 rounded-lg bg-[color:var(--bg-elev)] flex items-center justify-center text-[color:var(--text-muted)]">
                                        <UserIcon size={32} weight="fill" />
                                      </div>
                                    )}
                                    <div className="text-xs font-bold leading-tight line-clamp-2 flex items-center justify-center gap-1">
                                      {p.jersey_number !== null && p.jersey_number !== undefined ? `#${p.jersey_number} - ${p.name}` : p.name}
                                      {isCaptain && <CaptainBadge />}
                                      {isViceCaptain && <ViceCaptainBadge />}
                                    </div>
                                  </CardContent>
                                </Card>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>
        {/* Dialog composizione futura */}
        <Dialog open={compositionOpen} onOpenChange={setCompositionOpen}>
          <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-6xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Composizione rosa {nextComposition?.target || ""}</DialogTitle>
              {compositionDraft && (
                <p className="text-xs text-[color:var(--text-muted)] font-normal -mt-1">
                  Spesa stimata questo mese: <span className="font-mono text-[color:var(--gold)] font-bold">{fmtM(draftMonthlySpend)}</span>
                </p>
              )}
              <Button type="button" size="sm" variant="outline" onClick={copyCurrentComposition} className="border-[color:var(--border)] w-fit mt-1">
                Imposta come la composizione presente
              </Button>
            </DialogHeader>
            {nextComposition && compositionDraft && (
              <form onSubmit={saveComposition} className="space-y-6">
                <div className="grid grid-cols-1 gap-4">
                  {["prima_squadra", "primavera", "tribuna"].map((section) => {
                    const label = ROSTER_SECTIONS.find(([s]) => s === section)[1];
                    const ids = compositionDraft[section];
                    const isDragOver = dragOverSection === section;
                    return (
                      <div
                        key={section}
                        onDragOver={(e) => { e.preventDefault(); setDragOverSection(section); }}
                        onDragLeave={() => setDragOverSection((s) => (s === section ? null : s))}
                        onDrop={(e) => { e.preventDefault(); handleDrop(section); }}
                        className={`rounded-xl border-2 border-dashed p-3 min-h-[90px] transition-colors ${
                          isDragOver ? "border-[color:var(--gold)] bg-[color:var(--gold)]/5" : "border-[color:var(--border)] bg-[color:var(--bg-main)]"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-3 px-1">
                          <h3 className="font-display font-bold">{label}</h3>
                          <span className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-mono">{ids.length}</span>
                        </div>
                        {ids.length === 0 ? (
                          <div className="text-xs text-[color:var(--text-muted)] text-center py-6">Trascina qui i giocatori</div>
                        ) : (
                          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
                            {ids.map((playerId) => {
                              const player = nextPlayersById[playerId];
                              if (!player) return null;
                              const isCaptain = playerId === nextComposition.captain_id;
                              const isVice = playerId === nextComposition.vice_captain_id;
                              const isDragging = draggedPlayerId === playerId;
                              const isDropTarget = dragOverPlayerId === playerId;
                              return (
                                <div
                                  key={playerId}
                                  draggable
                                  onDragStart={() => setDraggedPlayerId(playerId)}
                                  onDragEnd={() => { setDraggedPlayerId(null); setDragOverSection(null); setDragOverPlayerId(null); }}
                                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSection(section); setDragOverPlayerId(playerId); }}
                                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(section, playerId); }}
                                  className={`flex flex-col gap-1 rounded-lg border p-1.5 cursor-grab active:cursor-grabbing transition-all ${
                                    isDragging ? "opacity-30" : ""
                                  } ${isDropTarget ? "border-[color:var(--gold)] bg-[color:var(--gold)]/10" : "border-[color:var(--border)] bg-[color:var(--bg-surface)]"}`}
                                >
                                  <div className="flex items-center gap-1.5" title={player.name}>
                                    {player.image ? (
                                      <img src={resolveImageUrl(player.image)} alt="" className="h-9 w-9 rounded object-cover shrink-0" />
                                    ) : (
                                      <div className="h-9 w-9 rounded bg-[color:var(--bg-elev)] flex items-center justify-center shrink-0 text-[color:var(--text-muted)]">
                                        <UserIcon size={16} weight="fill" />
                                      </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1">
                                        <span className={`text-[8px] font-mono font-bold border rounded px-1 shrink-0 ${ROLE_STYLES[player.role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>
                                          {player.role}
                                        </span>
                                        {isCaptain && <span className="text-[8px] font-mono font-bold text-amber-400">C</span>}
                                        {isVice && <span className="text-[8px] font-mono font-bold text-slate-300">VC</span>}
                                      </div>
                                      <div className="text-[10px] leading-tight line-clamp-1 mt-0.5">
                                        {player.name}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between gap-1">
                                    <span
                                      className={`text-[9px] font-mono font-bold rounded px-1 ${
                                        nextComposition.season_start_year && nextComposition.season_start_year - player.birth_year <= 23
                                          ? "bg-lime-300/80 text-lime-950"
                                          : "text-[color:var(--text-muted)]"
                                      }`}
                                      title="Anno di nascita"
                                    >
                                      {player.birth_year || "—"}
                                    </span>
                                    <div className="flex items-center gap-0.5" title="Stipendio effettivo">
                                      <CoinsIcon size={10} className="text-[color:var(--gold)] shrink-0" />
                                      <span className="text-[9px] font-mono text-[color:var(--gold)]">{fmtM(player.effective_salary)}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {["estero", "academy", "in_prestito"].some((s) => nextComposition.sections[s].length > 0) && (
                  <div className="border-t border-[color:var(--border)] pt-4">
                    <div className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold mb-3">Sezioni automatiche</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {ROSTER_SECTIONS.filter(([s]) => ["estero", "academy", "in_prestito"].includes(s)).map(([section, label]) => {
                        const players = nextComposition.sections[section];
                        if (players.length === 0) return null;
                        return (
                          <div key={section}>
                            <div className="text-xs font-bold mb-2">{label} <span className="text-[color:var(--text-muted)] font-normal">({players.length})</span></div>
                            <div className="space-y-1.5">
                              {sortAutoPlayers(players).map((player) => (
                                <div key={player.id} className="flex items-center gap-2 text-xs text-[color:var(--text-muted)]">
                                  <span className={`shrink-0 text-[9px] font-mono font-bold border rounded px-1 py-0.5 ${ROLE_STYLES[player.role] || "border-[color:var(--border)]"}`}>
                                    {player.role}
                                  </span>
                                  <span className="truncate">{player.name}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <DialogFooter>
                  <Button type="submit" disabled={compositionSaving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                    {compositionSaving ? "Salvataggio..." : "Salva composizione"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
        {/* Dialog composizione attuale */}
        <Dialog open={nowCompositionOpen} onOpenChange={setNowCompositionOpen}>
          <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-6xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Composizione rosa attuale</DialogTitle>
              {nowCompositionDraft && (
                <p className="text-xs text-[color:var(--text-muted)] font-normal -mt-1">
                  Spesa stimata questo mese: <span className="font-mono text-[color:var(--gold)] font-bold">{fmtM(nowdraftMonthlySpend)}</span>
                </p>
              )}
            </DialogHeader>
            {nowCompositionDraft && (
              <form onSubmit={saveNowComposition} className="space-y-6">
                <div className="grid grid-cols-1 gap-4">
                  {["prima_squadra", "primavera", "tribuna"].map((section) => {
                    const label = ROSTER_SECTIONS.find(([s]) => s === section)[1];
                    const ids = nowCompositionDraft[section];
                    const isDragOver = dragOverSection === section;
                    return (
                      <div
                        key={section}
                        onDragOver={(e) => { e.preventDefault(); setDragOverSection(section); }}
                        onDragLeave={() => setDragOverSection((s) => (s === section ? null : s))}
                        onDrop={(e) => { e.preventDefault(); handleDropNow(section); }}
                        className={`rounded-xl border-2 border-dashed p-3 min-h-[90px] transition-colors ${
                          isDragOver ? "border-[color:var(--gold)] bg-[color:var(--gold)]/5" : "border-[color:var(--border)] bg-[color:var(--bg-main)]"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-3 px-1">
                          <h3 className="font-display font-bold">{label}</h3>
                          <span className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-mono">{ids.length}</span>
                        </div>
                        {ids.length === 0 ? (
                          <div className="text-xs text-[color:var(--text-muted)] text-center py-6">Trascina qui i giocatori</div>
                        ) : (
                          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
                            {ids.map((playerId) => {
                              const player = nowPlayersById[playerId];
                              if (!player) return null;
                              const isCaptain = playerId === captainIds.captain;
                              const isVice = playerId === captainIds.vice;
                              const isDragging = draggedPlayerId === playerId;
                              const isDropTarget = dragOverPlayerId === playerId;
                              return (
                                <div
                                  key={playerId}
                                  draggable
                                  onDragStart={() => setDraggedPlayerId(playerId)}
                                  onDragEnd={() => { setDraggedPlayerId(null); setDragOverSection(null); setDragOverPlayerId(null); }}
                                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSection(section); setDragOverPlayerId(playerId); }}
                                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDropNow(section, playerId); }}
                                  className={`flex flex-col gap-1 rounded-lg border p-1.5 cursor-grab active:cursor-grabbing transition-all ${
                                    isDragging ? "opacity-30" : ""
                                  } ${isDropTarget ? "border-[color:var(--gold)] bg-[color:var(--gold)]/10" : "border-[color:var(--border)] bg-[color:var(--bg-surface)]"}`}
                                >
                                  <div className="flex items-center gap-1.5" title={player.name}>
                                    {player.image ? (
                                      <img src={resolveImageUrl(player.image)} alt="" className="h-9 w-9 rounded object-cover shrink-0" />
                                    ) : (
                                      <div className="h-9 w-9 rounded bg-[color:var(--bg-elev)] flex items-center justify-center shrink-0 text-[color:var(--text-muted)]">
                                        <UserIcon size={16} weight="fill" />
                                      </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1">
                                        <span className={`text-[8px] font-mono font-bold border rounded px-1 shrink-0 ${ROLE_STYLES[player.role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>
                                          {player.role}
                                        </span>
                                        {isCaptain && <span className="text-[8px] font-mono font-bold text-amber-400">C</span>}
                                        {isVice && <span className="text-[8px] font-mono font-bold text-slate-300">VC</span>}
                                      </div>
                                      <div className="text-[10px] leading-tight truncate mt-0.5">
                                        {player.name}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between gap-1">
                                    <span
                                      className={`text-[9px] font-mono font-bold rounded px-1 ${
                                        seasonStartYear - player.birth_year <= 23
                                          ? "bg-lime-300/80 text-lime-950"
                                          : "text-[color:var(--text-muted)]"
                                      }`}
                                      title="Anno di nascita"
                                    >
                                      {player.birth_year || "—"}
                                    </span>
                                    <div className="flex items-center gap-0.5" title="Stipendio effettivo">
                                      <CoinsIcon size={10} className="text-[color:var(--gold)] shrink-0" />
                                      <span className="text-[9px] font-mono text-[color:var(--gold)]">{fmtM(player.effective_salary)}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <DialogFooter>
                  <Button type="submit" disabled={nowCompositionSaving} className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">
                    {nowCompositionSaving ? "Salvataggio..." : "Salva composizione"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
        <PlayerDialog
          players={Object.values(roster).flat()}
          teams={teams}
          reminders={reminders}
          seasonStartYear={seasonStartYear}
          onPlayerDeleted={() => load(teamId)}
          seasonTeams={seasonTeams}
        />
        </>
      )}
    </div>
  );
}
