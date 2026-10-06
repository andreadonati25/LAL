import { useEffect, useState } from "react";
import { DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  ArrowRightIcon, CurrencyEurIcon, StarIcon, ScrollIcon,
  CheckCircleIcon, XCircleIcon, SealCheckIcon, PencilSimpleIcon,
  ArrowsLeftRightIcon, PackageIcon,
} from "@phosphor-icons/react";
import api, { formatApiError } from "@/lib/api";
import NewOfferForm from "@/components/NewOfferForm";

/* ─── helpers ─────────────────────────────────────────────────── */

const STATUS_BADGE = {
  proposto:    { label: "Proposto",    className: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  confermato:  { label: "Confermato",  className: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  convalidato: { label: "Convalidato", className: "bg-green-500/20 text-green-300 border-green-500/30" },
  eseguito:    { label: "Eseguito",    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  annullato:   { label: "Annullato",   className: "bg-red-500/20 text-red-400 border-red-500/30" },
};

const TIPO_LABEL = {
  definitivo:       "Definitivo",
  prestito_secco:   "Prestito secco",
  prestito_diritto: "Prestito con diritto di riscatto",
  prestito_obbligo: "Prestito con obbligo di riscatto",
};

const METRICA_LABEL = { gol: "Gol", assist: "Assist", presenze: "Presenze", bonus: "Bonus" };
const AMBITO_LABEL  = { stagione: "in stagione", totale: "in carriera" };
const MAGLIA_LABEL  = { fantasquadra: "ne LA Lega", generale: "in Serie A" };

function teamName(id, teamsMap) {
  return teamsMap?.[id]?.name ?? (id ? `(${id})` : "Svincolati");
}

function fmt(date) {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("it-IT", { day: "numeric", month: "numeric", year: "numeric" });
}

/* ─── sezioni ────────────────────────────────────────────────── */

function Section({ icon: Icon, title, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} weight="duotone" className="text-[color:var(--gold)] shrink-0" />
        <span className="text-xs font-bold uppercase tracking-widest text-[color:var(--text-muted)]">{title}</span>
      </div>
      {children}
    </div>
  );
}

function MovementsSection({ movements, teamsMap, playersMap }) {
  if (!movements?.length) return null;
  return (
    <Section icon={ArrowsLeftRightIcon} title="Movimenti calciatori">
      <div className="flex flex-col gap-2">
        {movements.map((m) => (
          <div key={m.id} className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-base)] p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-semibold">{playersMap[m.player_id]?.name ?? m.player_id}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--border)] text-[color:var(--text-muted)]">
                {TIPO_LABEL[m.tipo] ?? m.tipo}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[color:var(--text-secondary)] text-xs flex-wrap">
              <span className="font-medium text-[color:var(--text-primary)]">{teamName(m.from_team_id, teamsMap)}</span>
              <ArrowRightIcon size={12} />
              <span className="font-medium text-[color:var(--text-primary)]">{teamName(m.to_team_id, teamsMap)}</span>
            </div>
            {m.tipo === "definitivo" && m.purchase_price != null && (
              <div className="mt-1 text-xs text-[color:var(--text-muted)]">
                Cifra nominale: <span className="text-[color:var(--text-secondary)]">{m.purchase_price}M</span>
              </div>
            )}
            {m.cifra_riscatto != null && (
              <div className="text-xs text-[color:var(--text-muted)]">
                Cifra riscatto: <span className="text-[color:var(--text-secondary)]">{m.cifra_riscatto}M</span>
              </div>
            )}
            {m.loan_due_date && (
              <div className="text-xs text-[color:var(--text-muted)]">
                Scadenza prestito: <span className="text-[color:var(--text-secondary)]">{fmt(m.loan_due_date)}</span>
              </div>
            )}
            {m.paying_team_id && (
              <div className="text-xs text-[color:var(--text-muted)]">
                Pagante ingaggio: <span className="text-[color:var(--text-secondary)]">{teamName(m.paying_team_id, teamsMap)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function PaymentsSection({ payments, teamsMap }) {
  if (!payments?.length) return null;
  return (
    <Section icon={CurrencyEurIcon} title="Conguagli economici">
      <div className="flex flex-col gap-2">
        {payments.map((p) => (
          <div key={p.id} className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-base)] p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-bold text-[color:var(--gold)]">{p.amount}M</span>
              <span className="text-xs text-[color:var(--text-muted)]">
                {p.tipo === "now" ? "Alla convalida" : `Il ${fmt(p.due_date)}`}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-[color:var(--text-muted)] flex-wrap">
              <span className="font-medium text-[color:var(--text-secondary)]">{teamName(p.paid_by_team_id, teamsMap)}</span>
              <ArrowRightIcon size={11} />
              <span className="font-medium text-[color:var(--text-secondary)]">{teamName(p.paid_to_team_id, teamsMap)}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function BonusSection({ bonus, teamsMap, playersMap }) {
  if (!bonus?.length) return null;
  return (
    <Section icon={StarIcon} title="Bonus di rendimento">
      <div className="flex flex-col gap-2">
        {bonus.map((b) => (
          <div key={b.id} className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-base)] p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-bold text-[color:var(--gold)]">{b.amount}M</span>
              <span className="text-xs text-[color:var(--text-muted)]">
                {METRICA_LABEL[b.metrica] ?? b.metrica} ≥ {b.soglia} {AMBITO_LABEL[b.ambito]} {MAGLIA_LABEL[b.maglia]}
              </span>
            </div>
            <div className="mt-1 text-xs text-[color:var(--text-muted)]">
              Giocatore: <span className="text-[color:var(--text-secondary)]">{playersMap[b.player_id]?.name ?? b.player_id}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)] flex-wrap">
              <span className="font-medium text-[color:var(--text-secondary)]">{teamName(b.paid_by_team_id, teamsMap)}</span>
              <ArrowRightIcon size={11} />
              <span className="font-medium text-[color:var(--text-secondary)]">{teamName(b.paid_to_team_id, teamsMap)}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ClausoleSection({ clausole_libere }) {
  if (!clausole_libere?.length) return null;
  return (
    <Section icon={ScrollIcon} title="Clausole libere">
      <div className="flex flex-col gap-2">
        {clausole_libere.map((c) => (
          <div key={c.id} className="rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-base)] p-3 text-sm">
            <p className="text-[color:var(--text-primary)] leading-relaxed">{c.testo}</p>
            {c.due_date && (
              <p className="mt-1.5 text-xs text-[color:var(--text-muted)]">
                Verifica entro: <span className="text-[color:var(--text-secondary)]">{fmt(c.due_date)}</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ─── confirmations ──────────────────────────────────────────── */

function ConfirmationsSection({ transfer, teamsMap }) {
  const { confirmations, team_a_id, team_b_id } = transfer;
  if (!confirmations) return null;
  const teams = [team_a_id, team_b_id].filter(Boolean);
  return (
    <Section icon={CheckCircleIcon} title="Conferme">
      <div className="flex flex-col gap-1.5">
        {teams.map((tid) => {
          const confirmed = confirmations[tid];
          return (
            <div key={tid} className="flex items-center gap-2 text-sm">
              {confirmed
                ? <CheckCircleIcon size={16} weight="fill" className="text-green-400 shrink-0" />
                : <XCircleIcon size={16} weight="fill" className="text-[color:var(--text-muted)] shrink-0" />}
              <span className={confirmed ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"}>
                {teamName(tid, teamsMap)}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* ─── action buttons ─────────────────────────────────────────── */

function ActionButtons({ transfer, user, teamsMap, onConfirm, onValidate, onEdit, onCancel, busy }) {
  const isPresident = user?.role === "presidente";
  const { status, confirmations, team_a_id, team_b_id } = transfer;
  const myTeam = user?.team_id;
  const isInvolved = myTeam && (myTeam === team_a_id || myTeam === team_b_id);
  const isCancellable = status === "proposto" || status === "confermato";
  const alreadyConfirmed = myTeam && confirmations?.[myTeam];
  const canConfirm       = !isPresident && isInvolved && status === "proposto" && !alreadyConfirmed;
  const canCancel        = !isPresident && isInvolved && isCancellable;
  const canValidate      = isPresident && status === "confermato";
  const canCancelPresident = isPresident && isCancellable;
  const canConfirmA      = isPresident && status === "proposto" && team_a_id && !confirmations?.[team_a_id];
  const canConfirmB      = isPresident && status === "proposto" && !confirmations?.[team_b_id];
  const canEdit          = isPresident && (status === "proposto" || status === "confermato");

  const buttons = [];

  if (canConfirm) {
    buttons.push(
      <Button key="confirm" onClick={() => onConfirm()} disabled={busy} className="bg-green-600 hover:bg-green-700 text-white font-semibold">
        <CheckCircleIcon size={16} className="mr-1.5" /> Conferma offerta
      </Button>
    );
  }
  if (canConfirmA) {
    buttons.push(
      <Button key="confirm-a" variant="outline" onClick={() => onConfirm(team_a_id)} disabled={busy} className="border-green-500/50 text-green-400 hover:bg-green-500/10">
        <CheckCircleIcon size={16} className="mr-1.5" /> Conferma per {teamName(team_a_id, teamsMap)}
      </Button>
    );
  }
  if (canConfirmB) {
    buttons.push(
      <Button key="confirm-b" variant="outline" onClick={() => onConfirm(team_b_id)} disabled={busy} className="border-green-500/50 text-green-400 hover:bg-green-500/10">
        <CheckCircleIcon size={16} className="mr-1.5" /> Conferma per {teamName(team_b_id, teamsMap)}
      </Button>
    );
  }
  if (canValidate) {
    buttons.push(
      <Button key="validate" onClick={onValidate} disabled={busy} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
        <SealCheckIcon size={16} className="mr-1.5" /> Convalida
      </Button>
    );
  }
  if (canEdit) {
    buttons.push(
      <Button key="edit" variant="outline" onClick={onEdit} disabled={busy} className="border-[color:var(--border)]">
        <PencilSimpleIcon size={16} className="mr-1.5" /> Modifica
      </Button>
    );
  }
  if (canCancel || canCancelPresident) {
    buttons.push(
      <Button key="cancel" variant="outline" onClick={onCancel} disabled={busy} className="border-red-500/50 text-red-400 hover:bg-red-500/10">
        <XCircleIcon size={16} className="mr-1.5" /> Annulla trasferimento
      </Button>
    );
  }

  if (!buttons.length) return null;
  return <>{buttons}</>;
}

/* ─── main component ─────────────────────────────────────────── */

export default function TransferDetail({ transfer, teamsMap, user, onClose, onRefresh }) {
  const [playersMap, setPlayersMap] = useState({});
  const [isEditing, setIsEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Fetch dei giocatori coinvolti nel transfer (movimenti + bonus) */
  useEffect(() => {
    if (!transfer) return;
    const ids = [
      ...(transfer.movements ?? []).map((m) => m.player_id),
      ...(transfer.bonus ?? []).map((b) => b.player_id),
    ].filter(Boolean);
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    Promise.all(unique.map((id) => api.get(`/players/${id}`).catch(() => null)))
      .then((results) => {
        const map = {};
        results.forEach((r) => { if (r?.data) map[r.data.id] = r.data; });
        setPlayersMap(map);
      });
  }, [transfer]);

  if (!transfer) return null;

  const runAction = async (request, successMessage) => {
    setBusy(true);
    try {
      await request();
      toast.success(successMessage);
      await onRefresh?.();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  if (isEditing) {
    return (
      <NewOfferForm
        teams={Object.values(teamsMap)}
        user={user}
        initialTransfer={transfer}
        onClose={() => setIsEditing(false)}
        onSuccess={async () => {
          await onRefresh?.();
          setIsEditing(false);
        }}
      />
    );
  }

  const { team_a_id, team_b_id, status, created_at, updated_at, validated_at, executed_at } = transfer;
  const badge = STATUS_BADGE[status] ?? { label: status, className: "" };
  const isAssignment = !team_a_id; // team_a è null → assegnazione da Svincolati

  return (
    <>
      <DialogHeader className="pb-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <DialogTitle className="font-display text-xl leading-tight">
            {isAssignment ? (
              <>
                <PackageIcon size={20} weight="duotone" className="inline mr-2 text-[color:var(--text-muted)]" />
                Assegnazione a {teamName(team_b_id, teamsMap)}
              </>
            ) : (
              <>
                {teamName(team_a_id, teamsMap)}
                <span className="mx-2 text-[color:var(--text-muted)] font-normal">↔</span>
                {teamName(team_b_id, teamsMap)}
              </>
            )}
          </DialogTitle>
          <Badge className={`text-xs font-semibold border ${badge.className}`}>{badge.label}</Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-[color:var(--text-muted)] flex-wrap pt-1">
          <span>Proposto il {fmt(created_at)} {transfer.proposed_by_president ? "dal Presidente" : "da " + teamName(team_a_id, teamsMap)}</span>
          {validated_at && <span>· Convalidato il {fmt(validated_at)}</span>}
          {executed_at && <span>· Eseguito il {fmt(executed_at)}</span>}
        </div>
      </DialogHeader>

      <Separator className="bg-[color:var(--border)]" />

      {/* Corpo */}
      <div className="flex flex-col gap-5 py-2">
        <MovementsSection movements={transfer.movements} teamsMap={teamsMap} playersMap={playersMap} />
        <PaymentsSection payments={transfer.payments} teamsMap={teamsMap} />
        <BonusSection bonus={transfer.bonus} teamsMap={teamsMap} playersMap={playersMap} />
        <ClausoleSection clausole_libere={transfer.clausole_libere} />
        <ConfirmationsSection transfer={transfer} teamsMap={teamsMap} />
      </div>

      {/* Footer azioni */}
      <DialogFooter className="flex-wrap gap-2 pt-2 border-t border-[color:var(--border)]">
        <ActionButtons
          transfer={transfer}
          user={user}
          teamsMap={teamsMap}
          busy={busy}
          onConfirm={(teamId) => runAction(
            () => api.post(`/transfers/${transfer.id}/confirm`, null, { params: teamId ? { team_id: teamId } : undefined }),
            "Conferma registrata."
          )}
          onValidate={() => {
            if (window.confirm("Convalidare questo trasferimento? L'operazione potrebbe eseguire subito movimenti e pagamenti.")) {
              runAction(() => api.post(`/transfers/${transfer.id}/validate`), "Trasferimento convalidato.");
            }
          }}
          onEdit={() => setIsEditing(true)}
          onCancel={() => {
            if (window.confirm("Annullare questo trasferimento?")) {
              runAction(() => api.post(`/transfers/${transfer.id}/cancel`), "Trasferimento annullato.");
            }
          }}
        />
      </DialogFooter>
    </>
  );
}
