import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { TRANSFER } from "@/constants/testIds";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HandshakeIcon, PlusIcon, ArrowsLeftRightIcon, PackageIcon, ClockCounterClockwiseIcon, CaretDownIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import NewOfferForm from "@/components/NewOfferForm";
import TransferDetail from "@/components/TransferDetail";

const STATUS_BADGE = {
  proposto:    { label: "Proposto",    className: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  confermato:  { label: "Confermato",  className: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  convalidato: { label: "Convalidato", className: "bg-green-500/20 text-green-300 border-green-500/30" },
  eseguito:    { label: "Eseguito",    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  annullato:   { label: "Annullato",   className: "bg-red-500/20 text-red-400 border-red-500/30" },
};

function contentSummary(t) {
  const parts = [];
  if (t.movements?.length)       parts.push(`${t.movements.length} calciator${t.movements.length === 1 ? "e" : "i"}`);
  if (t.payments?.length)        parts.push(`${t.payments.length} conguagli${t.payments.length === 1 ? "o" : ""}`);
  if (t.bonus?.length)           parts.push(`${t.bonus.length} bonus`);
  if (t.clausole_libere?.length) parts.push(`${t.clausole_libere.length} clausol${t.clausole_libere.length === 1 ? "a" : "e"}`);
  return parts.join(" · ") || "—";
}

export default function Transfer() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [seasonStartYear, setSeasonStartYear] = useState(null);
  const [open, setOpen] = useState(false);

  /* Il comunicato "aperto" non è uno stato locale: è derivato dall'id presente nell'URL. */
  const selectedId = searchParams.get("id");
  const selected = items.find((t) => t.id === selectedId) || null;

  const load = useCallback(async () => {
    const [{ data: t }, { data: team }, { data: playerList }, { data: season }] = await Promise.all([
      api.get("/transfers"),
      api.get("/teams"),
      api.get("/players", { params: { limit: null } }),
      api.get("/season/current"),
    ]);
    setItems(t);
    setTeams(team);
    setPlayers(playerList);
    setSeasonStartYear(season.season_start_year);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openTransfer = (t) => {
    const next = new URLSearchParams(searchParams);
    next.set("id", t.id);
    setSearchParams(next);
  };

  const closeTransfer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next);
  };

  const teamsMap = Object.fromEntries(teams.map((t) => [t.id, t]));
  const playersMap = Object.fromEntries(players.map((p) => [p.id, p]));
  const filtered = items.filter((t) => {
    return t.window_year === seasonStartYear
  });
  
  const hasPendingObligations = (t) => {
    const hasOpenBonus = (t.bonus ?? []).some((b) => b.stato === "aperta");
    const hasOpenClause = (t.clausole_libere ?? []).some((c) => c.stato === "aperta");
    const hasFuturePayment = (t.payments ?? []).some((p) => p.due_date && new Date(p.due_date) > new Date());
    return hasOpenBonus || hasOpenClause || hasFuturePayment;
  };

  const filtered_past = items.filter((t) => {
    return t.window_year !== seasonStartYear && hasPendingObligations(t);
  });

  const renderTransferCard = (t) => {
  const badge = STATUS_BADGE[t.status] ?? { label: t.status, className: "" };
  const isAssignment = !t.team_a_id;
  const myTeamPending = user?.team_id && t.confirmations?.[user.team_id] === false && (t.status === "proposto");
  const movementNames = (t.movements ?? []).map((movement) => (
    movement.name ?? playersMap[movement.player_id]?.name ?? movement.player_id
  ));
  const shownMovementNames = movementNames.slice(0, 3);
  return (
    <button key={t.id} type="button" onClick={() => openTransfer(t)} className="text-left w-full">
      <Card data-testid={TRANSFER.transferCard} className="bg-[color:var(--bg-surface)] border-[color:var(--border)] card-lift w-full">
        <CardContent className="p-4 sm:p-5 flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <Badge className={`text-[10px] font-semibold border px-2 py-0.5 ${badge.className}`}>{badge.label}</Badge>
            <span className="text-[10px] text-[color:var(--text-muted)] shrink-0">
              {new Date(t.created_at).toLocaleDateString("it-IT", { day: "numeric", month: "numeric", year: "numeric" })}
            </span>
          </div>
          {shownMovementNames.length > 0 && (
            <div className="flex items-center gap-1.5 text-[color:var(--gold)]">
              {shownMovementNames.join(" · ")}{movementNames.length > shownMovementNames.length ? ` · +${movementNames.length - shownMovementNames.length}` : ""}
            </div>
          )}
          {isAssignment ? (
            <div className="flex items-center gap-1.5">
              <PackageIcon size={13} weight="duotone" className="shrink-0 text-[color:var(--text-muted)]" />
              <span className="text-[10px] uppercase tracking-widest font-bold text-[color:var(--text-muted)] shrink-0">Assegnazione a</span>
              <span className="font-display font-semibold text-sm truncate">{teamsMap[t.team_b_id]?.name ?? "—"}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-display font-semibold text-sm truncate flex-1 min-w-0">{teamsMap[t.team_a_id]?.name ?? "—"}</span>
              <ArrowsLeftRightIcon size={14} className="shrink-0 text-[color:var(--text-muted)]" />
              <span className="font-display font-semibold text-sm truncate flex-1 min-w-0 text-right text-[color:var(--text-secondary)]">{teamsMap[t.team_b_id]?.name ?? "—"}</span>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-[10px] text-[color:var(--text-muted)]">{contentSummary(t)}</p>
            {myTeamPending && <span className="text-[10px] font-bold text-yellow-400 uppercase tracking-wider">· Conferma richiesta</span>}
          </div>
        </CardContent>
      </Card>
    </button>
  );
};

  return (
    <div data-testid={TRANSFER.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
            <HandshakeIcon size={44} weight="duotone" className="inline mr-3 text-[color:var(--primary-hover)]" />
            Trasferimenti ufficiali.
          </h1>
        </div>

        {(user?.team_id || user?.role === "presidente") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button data-testid={TRANSFER.newTransferBtn} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
                <PlusIcon size={16} className="mr-2" /> Nuova offerta
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-3xl max-h-[90vh] overflow-y-auto">
              {open && (
                <NewOfferForm
                  teams={teams}
                  user={user}
                  onClose={() => setOpen(false)}
                  onSuccess={() => {
                    setOpen(false);
                    load();
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
        )}
      </div>

      {filtered.length === 0 && (
        <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
          <CardContent className="p-12 text-center text-[color:var(--text-muted)]">
            Nessuna trattativa.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(renderTransferCard)}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && closeTransfer()}>
        <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl max-h-[90vh] overflow-y-auto">
          {selected && (
            <TransferDetail transfer={selected} teamsMap={teamsMap} user={user} onClose={closeTransfer} onRefresh={load} />
          )}
        </DialogContent>
      </Dialog>

      <Collapsible className="mt-8 overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-surface)]">
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-left sm:px-5">
          <span className="flex items-center gap-2 font-display text-lg font-bold">
            <ClockCounterClockwiseIcon size={20} weight="duotone" className="text-[color:var(--gold)]" />
            Stagioni passate
          </span>
          <CaretDownIcon size={16} className="shrink-0 text-[color:var(--text-muted)] transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-[color:var(--border)] bg-[color:var(--bg-main)] p-4 sm:p-5">
            {filtered_past.length === 0 ? (
              <p className="text-center text-sm text-[color:var(--text-muted)] py-8">Nessuna trattativa.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filtered_past.map(renderTransferCard)}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}