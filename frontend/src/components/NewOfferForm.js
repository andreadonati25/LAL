import { useEffect, useMemo, useState } from "react";
import api, { formatApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { HandshakeIcon, PlusIcon, TrashIcon, CoinsIcon, UserIcon, CrownIcon, FileTextIcon, SpinnerGapIcon } from "@phosphor-icons/react";

const ROLE_STYLES = {
  P: "border-orange-300/90 bg-orange-400/35 text-orange-100",
  D: "border-sky-300/90 bg-sky-400/35 text-sky-100",
  C: "border-emerald-300/90 bg-emerald-400/35 text-emerald-100",
  A: "border-red-300/90 bg-red-400/35 text-red-100",
};

const ACTIVE_TRANSFER_STATUSES = new Set(["proposto", "confermato", "convalidato"]);
const LOAN_TYPES = new Set(["prestito_secco", "prestito_diritto", "prestito_obbligo"]);

const genKey = () => Math.random().toString(36).slice(2, 9);

const dateInputValue = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function futureDateMinimum() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minimumLoanDate() {
  const today = new Date();
  const targetMonth = new Date(today.getFullYear(), today.getMonth() + 6, 1);
  const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
  targetMonth.setDate(Math.min(today.getDate(), lastDay));
  return `${targetMonth.getFullYear()}-${String(targetMonth.getMonth() + 1).padStart(2, "0")}-${String(targetMonth.getDate()).padStart(2, "0")}`;
}

export default function NewOfferForm({ teams, user, onClose, onSuccess, initialTransfer = null }) {
  const isPresident = user?.role === "presidente";
  const myTeamId = user?.team_id;

  const [teamAId, setTeamAId] = useState(() => initialTransfer ? (initialTransfer.team_a_id || "__free__") : (isPresident ? "" : (myTeamId || "")));
  const [teamBId, setTeamBId] = useState(() => initialTransfer?.team_b_id || "");
  const [movements, setMovements] = useState(() => (initialTransfer?.movements ?? []).map((m) => ({
    ...m,
    _id: m.id || genKey(),
    direction: m.from_team_id === initialTransfer.team_b_id ? "b_to_a" : "a_to_b",
    paying_team_id: m.paying_team_id === m.from_team_id ? "from" : "to",
    loan_due_date: dateInputValue(m.loan_due_date),
  })));
  const [payments, setPayments] = useState(() => (initialTransfer?.payments ?? []).map((p) => ({
    ...p,
    _id: p.id || genKey(),
    direction: p.paid_by_team_id === initialTransfer.team_b_id ? "b_to_a" : "a_to_b",
    due_date: dateInputValue(p.due_date),
  })));
  const [bonus, setBonus] = useState(() => (initialTransfer?.bonus ?? []).map((b) => ({
    ...b,
    _id: b.id || genKey(),
    direction: b.paid_by_team_id === initialTransfer.team_b_id ? "b_to_a" : "a_to_b",
  })));
  const [clauses, setClauses] = useState(() => (initialTransfer?.clausole_libere ?? []).map((c) => ({
    ...c,
    _id: c.id || genKey(),
    due_date: dateInputValue(c.due_date),
  })));
  const [activeTab, setActiveTab] = useState("movements");

  const [players, setPlayers] = useState([]);
  const [playersWithActiveTransfer, setPlayersWithActiveTransfer] = useState(() => new Set());
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setLoadingPlayers(true);
    api.get("/players", { params: { limit: null } })
      .then(({ data }) => {
        if (isMounted) setPlayers(data);
      })
      .catch((err) => toast.error(formatApiError(err.response?.data?.detail)))
      .finally(() => {
        if (isMounted) setLoadingPlayers(false);
      });
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    let isMounted = true;
    api.get("/transfers")
      .then(({ data }) => {
        if (!isMounted) return;
        const playerIds = data
          .filter((transfer) => transfer.id !== initialTransfer?.id && ACTIVE_TRANSFER_STATUSES.has(transfer.status))
          .flatMap((transfer) => (transfer.movements ?? []).map((movement) => movement.player_id));
        setPlayersWithActiveTransfer(new Set(playerIds));
      })
      .catch((err) => toast.error(formatApiError(err.response?.data?.detail)))
    return () => { isMounted = false; };
  }, [initialTransfer?.id]);

  const teamsMap = useMemo(() => Object.fromEntries(teams.map((t) => [t.id, t])), [teams]);

  const isFreeA = teamAId === "__free__";
  const teamAName = isFreeA ? "Svincolati" : (teamsMap[teamAId]?.name || "Squadra A");
  const teamBName = teamsMap[teamBId]?.name || "Squadra B";

  const teamAPlayers = useMemo(() => {
    if (isFreeA) {
      return players.filter((p) => !p.fanta_team_id);
    }
    return teamAId ? players.filter((p) => p.fanta_team_id === teamAId) : [];
  }, [players, teamAId, isFreeA]);

  const teamBPlayers = useMemo(() => {
    return teamBId ? players.filter((p) => p.fanta_team_id === teamBId) : [];
  }, [players, teamBId]);

  const allEligiblePlayers = useMemo(() => {
    const pool = [];
    const seen = new Set();
    const add = (p) => {
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        pool.push(p);
      }
    };
    teamAPlayers.forEach(add);
    teamBPlayers.forEach(add);
    return pool;
  }, [teamAPlayers, teamBPlayers]);

  const movementPlayerIds = new Set(movements.map((movement) => movement.player_id).filter(Boolean));
  const bonusEligiblePlayers = allEligiblePlayers.filter((player) => movementPlayerIds.has(player.id));

  const handleTeamAChange = (val) => {
    setTeamAId(val);
    setMovements([]);
    setPayments([]);
    setBonus([]);
    setClauses([]);
  };

  const handleTeamBChange = (val) => {
    setTeamBId(val);
    setMovements([]);
    setPayments([]);
    setBonus([]);
    setClauses([]);
  };

  const addMovement = () => {
    if (!teamBId) {
      toast.error("Seleziona prima la squadra destinataria in alto");
      return;
    }
    setMovements((prev) => [
      ...prev,
      {
        _id: genKey(),
        direction: "a_to_b",
        player_id: "",
        tipo: "definitivo",
        purchase_price: 0,
        cifra_riscatto: "",
        paying_team_id: "to",
        loan_due_date: "",
      },
    ]);
  };

  const updateMovement = (id, patch) => {
    setMovements((prev) =>
      prev.map((m) => {
        if (m._id !== id) return m;
        const next = { ...m, ...patch };
        if (patch.direction && patch.direction !== m.direction) {
          next.player_id = "";
        }
        return next;
      })
    );
  };

  const removeMovement = (id) => {
    setMovements((prev) => prev.filter((m) => m._id !== id));
  };

  const addPayment = () => {
    if (!teamBId) {
      toast.error("Seleziona prima la squadra destinataria in alto");
      return;
    }
    if (isFreeA) {
      toast.error("Non è possibile inserire conguagli per operazioni con gli Svincolati");
      return;
    }
    setPayments((prev) => [
      ...prev,
      {
        _id: genKey(),
        direction: "a_to_b",
        amount: "",
        tipo: "now",
        due_date: "",
      },
    ]);
  };

  const updatePayment = (id, patch) => {
    setPayments((prev) => prev.map((p) => (p._id === id ? { ...p, ...patch } : p)));
  };

  const removePayment = (id) => {
    setPayments((prev) => prev.filter((p) => p._id !== id));
  };

  const addBonus = () => {
    if (!teamBId) {
      toast.error("Seleziona prima la squadra destinataria in alto");
      return;
    }
    if (isFreeA) {
      toast.error("Non è possibile inserire bonus per operazioni con gli Svincolati");
      return;
    }
    setBonus((prev) => [
      ...prev,
      {
        _id: genKey(),
        player_id: "",
        direction: "a_to_b",
        amount: "",
        metrica: "gol",
        soglia: "",
        ambito: "stagione",
        maglia: "fantasquadra",
      },
    ]);
  };

  const updateBonus = (id, patch) => {
    setBonus((prev) => prev.map((b) => (b._id === id ? { ...b, ...patch } : b)));
  };

  const removeBonus = (id) => {
    setBonus((prev) => prev.filter((b) => b._id !== id));
  };

  const addClause = () => {
    if (isFreeA) {
      toast.error("Non è possibile inserire clausole per operazioni con gli Svincolati");
      return;
    }
    setClauses((prev) => [
      ...prev,
      {
        _id: genKey(),
        testo: "",
        due_date: "",
      },
    ]);
  };

  const updateClause = (id, patch) => {
    setClauses((prev) => prev.map((c) => (c._id === id ? { ...c, ...patch } : c)));
  };

  const removeClause = (id) => {
    setClauses((prev) => prev.filter((c) => c._id !== id));
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();

    const realTeamA = isFreeA || !teamAId ? null : teamAId;
    const realTeamB = teamBId;

    if (!realTeamB) {
      toast.error("Seleziona la squadra destinataria della trattativa.");
      return;
    }

    if (isPresident && !teamAId) {
      toast.error("Seleziona la squadra cedente oppure Svincolati.");
      return;
    }

    if (realTeamA && realTeamA === realTeamB) {
      toast.error("La squadra cedente e la squadra destinataria devono essere diverse.");
      return;
    }

    if (!isPresident && !realTeamA) {
      toast.error("Solo il presidente può proporre operazioni dagli Svincolati.");
      return;
    }

    const hasAnyItem = movements.length > 0 || payments.length > 0 || bonus.length > 0 || clauses.length > 0;
    if (!hasAnyItem) {
      toast.error("La trattativa è vuota: inserisci almeno un calciatore, conguaglio, bonus o clausola.");
      return;
    }

    if (movements.length === 0 && !realTeamA) {
      toast.error("Un trasferimento dagli Svincolati deve contenere almeno un calciatore.");
      return;
    }

    for (let i = 0; i < movements.length; i++) {
      const m = movements[i];
      if (!m.player_id) {
        setActiveTab("movements");
        toast.error(`Seleziona il calciatore nel movimento #${i + 1}.`);
        return;
      }
      if (["prestito_diritto", "prestito_obbligo"].includes(m.tipo)) {
        if (m.cifra_riscatto === "" || !Number.isFinite(Number(m.cifra_riscatto)) || Number(m.cifra_riscatto) <= 0) {
          setActiveTab("movements");
          toast.error(`Inserisci una cifra di riscatto positiva per il movimento #${i + 1}.`);
          return;
        }
      }
      if (m.tipo === "definitivo" && (!Number.isInteger(Number(m.purchase_price)) || Number(m.purchase_price) < 0)) {
        setActiveTab("movements");
        toast.error(`La cifra nominale del movimento #${i + 1} deve essere un intero maggiore o uguale a 0.`);
        return;
      }
      const fromTeamId = m.direction === "b_to_a" ? realTeamB : realTeamA;
      const toTeamId = m.direction === "b_to_a" ? realTeamA : realTeamB;
      const movedPlayer = players.find((player) => player.id === m.player_id);
      if (
        m.tipo === "definitivo" &&
        movedPlayer?.current_team_id &&
        movedPlayer.current_team_id !== movedPlayer.fanta_team_id &&
        movedPlayer.current_team_id === toTeamId
      ) {
        setActiveTab("movements");
        toast.error(`Il giocatore in prestito del movimento #${i + 1} non può essere ceduto alla squadra che lo detiene.`);
        return;
      }
      if (m.tipo !== "definitivo" && !m.loan_due_date) {
        setActiveTab("movements");
        toast.error(`Inserisci la data termine del prestito per il movimento #${i + 1}.`);
        return;
      }
      if (m.tipo !== "definitivo" && m.loan_due_date < minimumLoanDate()) {
        setActiveTab("movements");
        toast.error(`Il prestito del movimento #${i + 1} deve durare almeno 6 mesi.`);
        return;
      }
    }

    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!p.amount || !Number.isFinite(Number(p.amount)) || Number(p.amount) <= 0) {
        setActiveTab("payments");
        toast.error(`Inserisci un importo valido (> 0) nel conguaglio #${i + 1}.`);
        return;
      }
      if (p.tipo === "data" && !p.due_date) {
        setActiveTab("payments");
        toast.error(`Inserisci la data di scadenza per il conguaglio differito #${i + 1}.`);
        return;
      }
      if (p.tipo === "data" && p.due_date < futureDateMinimum()) {
        setActiveTab("payments");
        toast.error(`La data del conguaglio #${i + 1} deve essere futura.`);
        return;
      }
    }

    for (let i = 0; i < bonus.length; i++) {
      const b = bonus[i];
      if (!b.player_id) {
        setActiveTab("bonus");
        toast.error(`Seleziona il calciatore nel bonus #${i + 1}.`);
        return;
      }
      if (!b.amount || !Number.isFinite(Number(b.amount)) || Number(b.amount) <= 0) {
        setActiveTab("bonus");
        toast.error(`Inserisci un importo valido (> 0) nel bonus #${i + 1}.`);
        return;
      }
      if (!movementPlayerIds.has(b.player_id)) {
        setActiveTab("bonus");
        toast.error(`Il giocatore del bonus #${i + 1} deve essere coinvolto in un movimento.`);
        return;
      }
      if (!b.soglia || !Number.isInteger(Number(b.soglia)) || Number(b.soglia) <= 0) {
        setActiveTab("bonus");
        toast.error(`Inserisci una soglia intera positiva nel bonus #${i + 1}.`);
        return;
      }
    }

    for (let i = 0; i < clauses.length; i++) {
      const c = clauses[i];
      if (!c.testo.trim()) {
        setActiveTab("clauses");
        toast.error(`Inserisci il testo della clausola #${i + 1}.`);
        return;
      }
      if (c.due_date && c.due_date < futureDateMinimum()) {
        setActiveTab("clauses");
        toast.error(`La data della clausola #${i + 1} deve essere futura.`);
        return;
      }
    }

    const toIso = (d) => {
      if (!d) return null;
      const cleanDate = d.includes("T") ? d.split("T")[0] : d;
      return new Date(`${cleanDate}T00:01:00`).toISOString();
    };

    const payload = {
      team_a_id: realTeamA,
      team_b_id: realTeamB,
      movements: movements.map((m) => {
        const fromTeam = m.direction === "b_to_a" ? realTeamB : realTeamA;
        const toTeam = m.direction === "b_to_a" ? realTeamA : realTeamB;
        const isLoan = m.tipo !== "definitivo";
        return {
          player_id: m.player_id,
          from_team_id: fromTeam,
          to_team_id: toTeam,
          tipo: m.tipo,
          purchase_price: !isLoan ? Number(m.purchase_price || 0) : 0,
          cifra_riscatto: ["prestito_diritto", "prestito_obbligo"].includes(m.tipo) ? Number(m.cifra_riscatto) : null,
          paying_team_id: isLoan ? (m.paying_team_id === "from" ? fromTeam : toTeam) : null,
          loan_due_date: isLoan ? toIso(m.loan_due_date) : null,
        };
      }),
      payments: payments.map((p) => {
        const paidBy = p.direction === "b_to_a" ? realTeamB : realTeamA;
        const paidTo = p.direction === "b_to_a" ? realTeamA : realTeamB;
        return {
          paid_by_team_id: paidBy,
          paid_to_team_id: paidTo,
          amount: Number(p.amount),
          tipo: p.tipo,
          due_date: p.tipo === "data" ? toIso(p.due_date) : null,
        };
      }),
      bonus: bonus.map((b) => {
        const paidBy = b.direction === "b_to_a" ? realTeamB : realTeamA;
        const paidTo = b.direction === "b_to_a" ? realTeamA : realTeamB;
        return {
          player_id: b.player_id,
          paid_by_team_id: paidBy,
          paid_to_team_id: paidTo,
          amount: Number(b.amount),
          metrica: b.metrica,
          soglia: parseInt(b.soglia, 10),
          ambito: b.ambito,
          maglia: b.maglia,
        };
      }),
      clausole_libere: clauses.map((c) => ({
        testo: c.testo.trim(),
        due_date: c.due_date ? toIso(c.due_date) : null,
      })),
    };

    setSubmitting(true);
    try {
      if (initialTransfer) {
        await api.patch(`/transfers/${initialTransfer.id}`, payload);
      } else {
        await api.post("/transfers", payload);
      }
      toast.success(initialTransfer ? "Offerta modificata con successo! Le squadre dovranno confermarla di nuovo." : "Offerta di trasferimento proposta con successo!");
      onSuccess();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 py-1">
      <DialogHeader>
        <DialogTitle className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <HandshakeIcon size={26} weight="duotone" className="text-[color:var(--gold)]" />
          {initialTransfer ? "Modifica offerta di trasferimento" : "Nuova offerta di trasferimento"}
        </DialogTitle>
      </DialogHeader>

      {/* Selezione Squadre */}
      <Card className="bg-[color:var(--bg-main)] border-[color:var(--border)]">
        <CardContent className="p-4 space-y-3">
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--gold)] font-bold">
            Squadre coinvolte nella trattativa
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-[color:var(--text-muted)] block mb-1">
                {isPresident ? "Squadra A" : "La tua squadra"}
              </Label>
              {isPresident ? (
                <Select value={teamAId || undefined} onValueChange={handleTeamAChange} disabled={Boolean(initialTransfer)}>
                  <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] text-xs">
                    <SelectValue placeholder="Seleziona squadra A..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__free__">Svincolati (Assegnazione)</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="px-3 py-2 rounded-md bg-[color:var(--bg-surface)] border border-[color:var(--border)] text-xs font-semibold">
                  {teamsMap[myTeamId]?.name || "La tua squadra"}
                </div>
              )}
            </div>

            <div>
              <Label className="text-xs text-[color:var(--text-muted)] block mb-1">
                Squadra B
              </Label>
              <Select value={teamBId || undefined} onValueChange={handleTeamBChange} disabled={Boolean(initialTransfer)}>
                <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] text-xs">
                  <SelectValue placeholder="Seleziona squadra B..." />
                </SelectTrigger>
                <SelectContent>
                  {teams
                    .filter((t) => t.id !== teamAId && t.id !== myTeamId)
                    .map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs Sezioni */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-4 w-full bg-[color:var(--bg-main)] h-11 p-1">
          <TabsTrigger value="movements" className="text-xs flex items-center gap-1.5 data-[state=active]:bg-[color:var(--bg-surface)]">
            <UserIcon size={14} />
            <span>Calciatori</span>
            {movements.length > 0 && (
              <span className="px-1.5 py-0.2 bg-[color:var(--gold)] text-black font-bold rounded-full text-[10px]">
                {movements.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="payments"
            disabled={isFreeA}
            className="text-xs flex items-center gap-1.5 data-[state=active]:bg-[color:var(--bg-surface)]"
          >
            <CoinsIcon size={14} />
            <span>Conguagli</span>
            {payments.length > 0 && (
              <span className="px-1.5 py-0.2 bg-[color:var(--gold)] text-black font-bold rounded-full text-[10px]">
                {payments.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="bonus"
            disabled={isFreeA}
            className="text-xs flex items-center gap-1.5 data-[state=active]:bg-[color:var(--bg-surface)]"
          >
            <CrownIcon size={14} />
            <span>Bonus</span>
            {bonus.length > 0 && (
              <span className="px-1.5 py-0.2 bg-[color:var(--gold)] text-black font-bold rounded-full text-[10px]">
                {bonus.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="clauses" disabled={isFreeA} className="text-xs flex items-center gap-1.5 data-[state=active]:bg-[color:var(--bg-surface)]">
            <FileTextIcon size={14} />
            <span>Clausole</span>
            {clauses.length > 0 && (
              <span className="px-1.5 py-0.2 bg-[color:var(--gold)] text-black font-bold rounded-full text-[10px]">
                {clauses.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tab Calciatori */}
        <TabsContent value="movements" className="space-y-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[color:var(--text-muted)]">
              {isFreeA
                ? "Per un'assegnazione da Svincolati, la cifra nominale sarà l'importo detratto dal budget trasferimenti della società destinataria."
                : "La cifra nominale fissa solo il nuovo prezzo d'acquisto storico: non trasferisce denaro tra le squadre (usa i Conguagli)."}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={addMovement}
              disabled={loadingPlayers}
              className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-semibold text-xs h-8"
            >
              <PlusIcon size={14} className="mr-1.5" /> Aggiungi calciatore
            </Button>
          </div>

          {movements.length === 0 ? (
            <div className="p-8 text-center text-xs text-[color:var(--text-muted)] border border-dashed border-[color:var(--border)] rounded-lg">
              Nessun calciatore inserito nella trattativa. Clicca &quot;Aggiungi calciatore&quot; per iniziare.
            </div>
          ) : (
            <div className="space-y-3">
              {movements.map((m, idx) => {
                const selectedPlayer = players.find((player) => player.id === m.player_id);
                const selectedPlayerIsLoaned = Boolean(selectedPlayer?.current_team_id && selectedPlayer.current_team_id !== selectedPlayer.fanta_team_id);
                const movementToTeamId = m.direction === "b_to_a" ? teamAId : teamBId;
                const isLoanSaleToCurrentTeam = (player) => (
                  m.tipo === "definitivo" &&
                  player.current_team_id &&
                  player.current_team_id !== player.fanta_team_id &&
                  player.current_team_id === movementToTeamId
                );
                const availablePlayers = (m.direction === "a_to_b" ? teamAPlayers : teamBPlayers).filter((player) => (
                  (!playersWithActiveTransfer.has(player.id) || player.id === m.player_id) &&
                  (!movementPlayerIds.has(player.id) || player.id === m.player_id) &&
                  (!LOAN_TYPES.has(m.tipo) || !player.current_team_id || player.current_team_id === player.fanta_team_id) &&
                  (!isLoanSaleToCurrentTeam(player) || player.id === m.player_id)
                ));
                return (
                  <div
                    key={m._id}
                    className="p-4 rounded-lg bg-[color:var(--bg-main)] border border-[color:var(--border)] space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs font-semibold">
                          Calciatore #{idx + 1}
                        </Badge>
                        <span className="text-xs font-medium text-[color:var(--gold)]">
                          {m.direction === "b_to_a" ? `${teamBName} ➔ ${teamAName}` : `${teamAName} ➔ ${teamBName}`}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-[color:var(--text-muted)] hover:text-red-400"
                        onClick={() => removeMovement(m._id)}
                      >
                        <TrashIcon size={15} />
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {!isFreeA && (
                        <div>
                          <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                            Direzione trasferimento
                          </Label>
                          <Select
                            value={m.direction}
                            onValueChange={(val) => updateMovement(m._id, { direction: val })}
                          >
                            <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="a_to_b">{teamAName} ➔ {teamBName}</SelectItem>
                              <SelectItem value="b_to_a">{teamBName} ➔ {teamAName}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      <div className={isFreeA ? "sm:col-span-2" : ""}>
                        <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                          Calciatore
                        </Label>
                        <Select
                          value={m.player_id || undefined}
                          onValueChange={(val) => updateMovement(m._id, { player_id: val })}
                        >
                          <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                            <SelectValue placeholder="Seleziona calciatore..." />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            {availablePlayers.length === 0 ? (
                                <div className="p-2 text-xs text-center text-[color:var(--text-muted)]">
                                Nessun calciatore disponibile per questa operazione
                              </div>
                            ) : (
                              availablePlayers.map((p) => (
                                <SelectItem key={p.id} value={p.id} className="cursor-pointer">
                                  <div className="flex items-center gap-2">
                                    <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border ${ROLE_STYLES[p.role] || ""}`}>
                                      {p.role}
                                    </span>
                                    <span className="font-medium group-focus:text-neutral-950 group-hover:text-neutral-950 group-data-[highlighted]:text-neutral-950">
                                      {p.name}
                                    </span>
                                    <span className="text-[10px] text-[color:var(--text-muted)] group-focus:text-neutral-900 group-hover:text-neutral-900 group-data-[highlighted]:text-neutral-900 font-medium transition-colors">
                                      ({p.real_club || "Svincolato"} - {p.cartellino || p.fantavalore || 0}M)
                                    </span>
                                  </div>
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {selectedPlayer && isLoanSaleToCurrentTeam(selectedPlayer) && (
                      <p className="text-xs text-red-400">
                        Un giocatore in prestito non può essere ceduto alla squadra che lo detiene.
                      </p>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                          Formula
                        </Label>
                        <Select
                          value={m.tipo}
                          onValueChange={(val) => updateMovement(m._id, { tipo: val })}
                        >
                          <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="definitivo">Titolo Definitivo</SelectItem>
                            {(teamAId !== "__free__") && (
                              <>
                              <SelectItem value="prestito_secco" disabled={selectedPlayerIsLoaned}>Prestito Secco</SelectItem>
                              <SelectItem value="prestito_diritto" disabled={selectedPlayerIsLoaned}>Prestito con Diritto di Riscatto</SelectItem>
                              <SelectItem value="prestito_obbligo" disabled={selectedPlayerIsLoaned}>Prestito con Obbligo di Riscatto</SelectItem>
                              </>
                            )}
                          </SelectContent>
                        </Select>
                      </div>

                      {m.tipo === "definitivo" ? (
                        <div>
                          <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                            Cifra Nominale (M)
                          </Label>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            value={m.purchase_price}
                            onChange={(e) => updateMovement(m._id, { purchase_price: e.target.value })}
                            className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                            placeholder="0"
                          />
                        </div>
                      ) : (
                        ["prestito_diritto", "prestito_obbligo"].includes(m.tipo) && (
                          <div>
                            <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                              Cifra Riscatto (M)
                            </Label>
                            <Input
                              type="number"
                              step="0.1"
                              min="0.1"
                              value={m.cifra_riscatto}
                              onChange={(e) => updateMovement(m._id, { cifra_riscatto: e.target.value })}
                              className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                              placeholder="Es. 10"
                            />
                          </div>
                        )
                      )}
                    </div>

                    {m.tipo !== "definitivo" && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-[color:var(--border)]/40">
                        <div>
                          <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                            Termine Prestito
                          </Label>
                          <Input
                            type="date"
                            value={m.loan_due_date}
                            min={minimumLoanDate()}
                            onChange={(e) => updateMovement(m._id, { loan_due_date: e.target.value })}
                            className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                            Stipendio a carico di
                          </Label>
                          <Select
                            value={m.paying_team_id || "to"}
                            onValueChange={(val) => updateMovement(m._id, { paying_team_id: val })}
                          >
                            <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="to">Destinatario (squadra ospitante)</SelectItem>
                              <SelectItem value="from">Cedente (squadra proprietaria)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Tab Conguagli */}
        <TabsContent value="payments" className="space-y-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[color:var(--text-muted)]">
              Conguagli economici a cifra fissa, con versamento immediato alla convalida oppure differito a una data prestabilita.
            </div>
            <Button
              type="button"
              size="sm"
              onClick={addPayment}
              className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-semibold text-xs h-8"
            >
              <PlusIcon size={14} className="mr-1.5" /> Aggiungi conguaglio
            </Button>
          </div>

          {payments.length === 0 ? (
            <div className="p-8 text-center text-xs text-[color:var(--text-muted)] border border-dashed border-[color:var(--border)] rounded-lg">
              Nessun conguaglio economico inserito. Clicca &quot;Aggiungi conguaglio&quot; per definire pagamenti immediati o differiti.
            </div>
          ) : (
            <div className="space-y-3">
              {payments.map((p, idx) => (
                <div
                  key={p._id}
                  className="p-4 rounded-lg bg-[color:var(--bg-main)] border border-[color:var(--border)] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs font-semibold">
                        Conguaglio #{idx + 1}
                      </Badge>
                      <span className="text-xs font-medium text-[color:var(--gold)]">
                        {p.direction === "b_to_a" ? `${teamBName} ➔ ${teamAName}` : `${teamAName} ➔ ${teamBName}`}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-[color:var(--text-muted)] hover:text-red-400"
                      onClick={() => removePayment(p._id)}
                    >
                      <TrashIcon size={15} />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Flusso Denaro
                      </Label>
                      <Select
                        value={p.direction}
                        onValueChange={(val) => updatePayment(p._id, { direction: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="a_to_b">{teamAName} paga a {teamBName}</SelectItem>
                          <SelectItem value="b_to_a">{teamBName} paga a {teamAName}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Importo (M)
                      </Label>
                      <Input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={p.amount}
                        onChange={(e) => updatePayment(p._id, { amount: e.target.value })}
                        placeholder="Es. 10"
                        className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                      />
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Modalità
                      </Label>
                      <Select
                        value={p.tipo}
                        onValueChange={(val) => updatePayment(p._id, { tipo: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="now">Immediato (alla convalida)</SelectItem>
                          <SelectItem value="data">Differito a data fissa</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {p.tipo === "data" && (
                    <div className="pt-1">
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Data Pagamento
                      </Label>
                      <Input
                        type="date"
                        value={p.due_date}
                          min={futureDateMinimum()}
                        onChange={(e) => updatePayment(p._id, { due_date: e.target.value })}
                        className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs max-w-xs"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Tab Bonus */}
        <TabsContent value="bonus" className="space-y-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[color:var(--text-muted)]">
              Bonus di rendimento calcolati a partire dalla convalida (gol, assist, presenze). Per condizioni o accordi speciali, utilizzare la sezione Clausole.
            </div>
            <Button
              type="button"
              size="sm"
              onClick={addBonus}
              className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-semibold text-xs h-8"
            >
              <PlusIcon size={14} className="mr-1.5" /> Aggiungi bonus
            </Button>
          </div>

          {bonus.length === 0 ? (
            <div className="p-8 text-center text-xs text-[color:var(--text-muted)] border border-dashed border-[color:var(--border)] rounded-lg">
              Nessun bonus prestazionale inserito. Clicca &quot;Aggiungi bonus&quot; per legare premi a gol, assist o presenze.
            </div>
          ) : (
            <div className="space-y-3">
              {bonus.map((b, idx) => (
                <div
                  key={b._id}
                  className="p-4 rounded-lg bg-[color:var(--bg-main)] border border-[color:var(--border)] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs font-semibold">
                        Bonus #{idx + 1}
                      </Badge>
                      <span className="text-xs font-medium text-[color:var(--gold)]">
                        {b.direction === "b_to_a" ? `${teamBName} paga ${teamAName}` : `${teamAName} paga ${teamBName}`}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-[color:var(--text-muted)] hover:text-red-400"
                      onClick={() => removeBonus(b._id)}
                    >
                      <TrashIcon size={15} />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Calciatore
                      </Label>
                      <Select
                        value={b.player_id || undefined}
                        onValueChange={(val) => updateBonus(b._id, { player_id: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue placeholder="Scegli calciatore..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-60">
                            {bonusEligiblePlayers.map((p) => (
                            <SelectItem key={p.id} value={p.id} className="cursor-pointer">
                              <span className="font-medium group-focus:text-neutral-950 group-hover:text-neutral-950 group-data-[highlighted]:text-neutral-950">
                                {p.name}
                              </span>{" "}
                              <span className="text-[10px] text-[color:var(--text-muted)] group-focus:text-neutral-900 group-hover:text-neutral-900 group-data-[highlighted]:text-neutral-900 font-medium transition-colors">
                                ({teamsMap[p.fanta_team_id]?.name || "Svincolato"})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Chi Versa
                      </Label>
                      <Select
                        value={b.direction}
                        onValueChange={(val) => updateBonus(b._id, { direction: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="a_to_b">{teamAName} paga a {teamBName}</SelectItem>
                          <SelectItem value="b_to_a">{teamBName} paga a {teamAName}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Cifra Bonus (M)
                      </Label>
                      <Input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={b.amount}
                        onChange={(e) => updateBonus(b._id, { amount: e.target.value })}
                        placeholder="Es. 2.0"
                        className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Metrica
                      </Label>
                      <Select
                        value={b.metrica}
                        onValueChange={(val) => updateBonus(b._id, { metrica: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gol">Gol</SelectItem>
                          <SelectItem value="assist">Assist</SelectItem>
                          <SelectItem value="bonus">Bonus totali</SelectItem>
                          <SelectItem value="presenze">Presenze</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Soglia
                      </Label>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={b.soglia}
                        onChange={(e) => updateBonus(b._id, { soglia: e.target.value })}
                        placeholder="Es. 10"
                        className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs"
                      />
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Ambito
                      </Label>
                      <Select
                        value={b.ambito}
                        onValueChange={(val) => updateBonus(b._id, { ambito: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stagione">Stagione in corso</SelectItem>
                          <SelectItem value="totale">Storico totale</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                        Maglia
                      </Label>
                      <Select
                        value={b.maglia}
                        onValueChange={(val) => updateBonus(b._id, { maglia: val })}
                      >
                        <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fantasquadra">FantaSquadra</SelectItem>
                          <SelectItem value="generale">Serie A</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Tab Clausole Libere */}
        <TabsContent value="clauses" className="space-y-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[color:var(--text-muted)]">
              Accordi speciali, condizioni accessorie personalizzati tra le società, con data di scadenza.
            </div>
            <Button
              type="button"
              size="sm"
              onClick={addClause}
              disabled={isFreeA}
              className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-semibold text-xs h-8"
            >
              <PlusIcon size={14} className="mr-1.5" /> Aggiungi clausola
            </Button>
          </div>

          {clauses.length === 0 ? (
            <div className="p-8 text-center text-xs text-[color:var(--text-muted)] border border-dashed border-[color:var(--border)] rounded-lg">
              Nessuna clausola libera inserita. Clicca &quot;Aggiungi clausola&quot; per descrivere patti speciali tra le società.
            </div>
          ) : (
            <div className="space-y-3">
              {clauses.map((c, idx) => (
                <div
                  key={c._id}
                  className="p-4 rounded-lg bg-[color:var(--bg-main)] border border-[color:var(--border)] space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="text-xs font-semibold">
                      Clausola #{idx + 1}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-[color:var(--text-muted)] hover:text-red-400"
                      onClick={() => removeClause(c._id)}
                    >
                      <TrashIcon size={15} />
                    </Button>
                  </div>

                  <div>
                    <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                      Testo Clausola
                    </Label>
                    <Textarea
                      value={c.testo}
                      onChange={(e) => updateClause(c._id, { testo: e.target.value })}
                      placeholder="Descrivi la clausola"
                      rows={2}
                      className="bg-[color:var(--bg-surface)] border-[color:var(--border)] text-xs"
                    />
                  </div>

                  <div>
                    <Label className="text-[11px] uppercase tracking-wider text-[color:var(--text-muted)] block mb-1">
                      Data di scadenza
                    </Label>
                    <Input
                      type="date"
                      value={c.due_date}
                      min={futureDateMinimum()}
                      onChange={(e) => updateClause(c._id, { due_date: e.target.value })}
                      className="bg-[color:var(--bg-surface)] border-[color:var(--border)] h-9 text-xs max-w-xs"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Footer Riepilogo e Azioni */}
      <DialogFooter className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t border-[color:var(--border)]">
        <div className="text-[11px] text-[color:var(--text-muted)]">
          Riepilogo: <strong className="text-[color:var(--text-main)]">{movements.length}</strong> calciatori,{" "}
          <strong className="text-[color:var(--text-main)]">{payments.length}</strong> conguagli,{" "}
          <strong className="text-[color:var(--text-main)]">{bonus.length}</strong> bonus,{" "}
          <strong className="text-[color:var(--text-main)]">{clauses.length}</strong> clausole
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            className="text-xs border-[color:var(--border)]"
          >
            Annulla
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold text-xs"
          >
            {submitting ? (
              <>
                <SpinnerGapIcon size={14} className="mr-1.5 animate-spin" /> Inviando...
              </>
            ) : (
              "Invia proposta"
            )}
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}
