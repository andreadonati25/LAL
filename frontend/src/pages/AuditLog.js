import { useEffect, useState, useCallback, useRef } from "react";
import api from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ClockCounterClockwiseIcon, PlusCircleIcon, PencilSimpleIcon,
  TrashIcon, KeyIcon, UploadSimpleIcon, CircleIcon,
  CaretLeftIcon, CaretRightIcon,
} from "@phosphor-icons/react";
import { useAuth } from "@/context/AuthContext";
import { AUDIT } from "@/constants/testIds";

const PAGE_SIZE = 30;

const ACTION_META = {
  created: { color: "var(--success)", icon: PlusCircleIcon },
  updated: { color: "var(--gold)", icon: PencilSimpleIcon },
  deleted: { color: "var(--danger)", icon: TrashIcon },
  password_changed: { color: "var(--primary-hover)", icon: KeyIcon },
  upload: { color: "var(--primary-hover)", icon: UploadSimpleIcon },
};
const DEFAULT_META = { color: "var(--text-muted)", icon: CircleIcon };

const ENTITY_OPTIONS = [
  { value: "all", label: "Tutto" },
  { value: "team", label: "Squadre" },
  { value: "players_group", label: "Giocatori" },
  { value: "user", label: "Utenti" },
  { value: "reminders", label: "Scadenze" },
  { value: "season", label: "Stagione" },
];

export default function AuditLog() {
  const { user } = useAuth();
  const [logs, setLogs] = useState([]);
  const [entityFilter, setEntityFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [isPaginationStuck, setIsPaginationStuck] = useState(false);
  const paginationSentinelRef = useRef(null);

  const load = useCallback(async () => {
    if (!user) { setLogs([]); return; }
    const params = {};
    if (entityFilter !== "all" && entityFilter !== "players_group") params.entity = entityFilter;
    const { data } = await api.get("/audit", { params });
    setLogs(data);
  }, [entityFilter, user]);
  useEffect(() => { load(); }, [load]);

  const filtered = logs.filter((l) => {
    if (entityFilter === "players_group" && !["player", "players"].includes(l.entity)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (l.user_name || "").toLowerCase().includes(q) ||
      (l.action || "").toLowerCase().includes(q) ||
      (l.extra || "").toLowerCase().includes(q)
    );
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visibleLogs = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => { setCurrentPage(1); }, [query, entityFilter]);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  useEffect(() => {
    const sentinel = paginationSentinelRef.current;
    if (!sentinel) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      setIsPaginationStuck(!entry.isIntersecting);
    }, { rootMargin: "-64px 0px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [totalPages]);

  return (
    <div data-testid={AUDIT.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="mb-8">
        <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
          <ClockCounterClockwiseIcon size={44} weight="duotone" className="inline mr-3 text-[color:var(--primary-hover)]" />
          Registro Storico Cambiamenti.
        </h1>
        <p className="text-[color:var(--text-muted)] mt-2">Ogni variazione registrata: chi, cosa, quando.</p>
      </div>

      {!user && (
        <div className="mb-4 border border-[color:var(--border)] rounded-lg p-4 text-sm text-[color:var(--text-muted)] bg-[color:var(--bg-surface)]">
          Accedi per consultare lo storico completo dei cambiamenti ne LA Lega.
        </div>
      )}

      {user && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <Input placeholder="Cerca per utente, azione o descrizione…" value={query} onChange={(e) => setQuery(e.target.value)} className="bg-[color:var(--bg-surface)] border-[color:var(--border)]" />
            <Select value={entityFilter} onValueChange={setEntityFilter}>
              <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENTITY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {totalPages > 1 && (
            <>
              <div ref={paginationSentinelRef} className="h-px" aria-hidden="true" />
              <div className={`sticky top-16 z-30 mb-3 flex items-center justify-between gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-surface)]/95 shadow-lg backdrop-blur-sm transition-all duration-200 ${isPaginationStuck ? "mx-auto w-fit px-2 py-1" : "w-full px-4 py-2"}`}>
                <Button
                  type="button" size="icon" variant="outline"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  aria-label="Pagina precedente" title="Pagina precedente"
                  className="h-7 w-7 border-[color:var(--border)]"
                >
                  <CaretLeftIcon size={16} />
                </Button>
                <span className="text-[11px] text-[color:var(--text-muted)]">Pagina {currentPage} di {totalPages}</span>
                <Button
                  type="button" size="icon" variant="outline"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  aria-label="Pagina successiva" title="Pagina successiva"
                  className="h-7 w-7 border-[color:var(--border)]"
                >
                  <CaretRightIcon size={16} />
                </Button>
              </div>
            </>
          )}

          <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
            <CardContent className="p-6">
              {filtered.length === 0 && (
                <div className="p-8 text-center text-[color:var(--text-muted)]">Nessun cambiamento registrato.</div>
              )}
              {visibleLogs.length > 0 && (
                <div className="relative pl-6">
                  <div className="absolute left-[5px] top-2 bottom-2 w-px bg-[color:var(--border)]" />
                  {visibleLogs.map((l) => {
                    const meta = ACTION_META[l.action] || DEFAULT_META;
                    const Icon = meta.icon;
                    return (
                      <div key={l.id} className="relative pb-6 last:pb-0">
                        <div
                          className="absolute -left-6 top-0.5 h-3 w-3 rounded-full border-2 border-[color:var(--bg-surface)]"
                          style={{ background: meta.color }}
                        />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-mono text-xs text-[color:var(--gold)]">
                            {new Date(l.at).toLocaleString("it-IT")}
                          </span>
                          <span className="text-sm font-bold">{l.user_team || l.user_name}</span>
                          <span
                            className="flex items-center gap-1 text-[10px] uppercase tracking-widest font-bold"
                            style={{ color: meta.color }}
                          >
                            <Icon size={12} weight="bold" />
                            {l.action}
                          </span>
                        </div>
                        {l.extra && (
                          <div className="text-sm text-[color:var(--text-secondary)] mt-1">{l.extra}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}