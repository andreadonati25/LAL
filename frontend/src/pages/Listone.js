import { useEffect, useState, useRef } from "react";
import api, { formatApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import PlayerDialog from "@/components/PlayerDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { LISTONE } from "@/constants/testIds";
import {
  UploadSimpleIcon, UsersIcon, PlusIcon, ArrowsDownUpIcon, CaretUpIcon,
  CaretDownIcon, CaretLeftIcon, CaretRightIcon, SpinnerGapIcon, UserIcon,
} from "@phosphor-icons/react";
import { useSearchParams } from "react-router-dom";

const fmt = (n) => new Intl.NumberFormat("it-IT").format(Math.round(n || 0));
const fmtValue = (n) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(Number(n || 0));

const resolveImageUrl = (image) =>
  !image ? "" : /^https?:\/\//.test(image) ? image : `${process.env.REACT_APP_BACKEND_URL}/data/${image}`;

const ROLES = ["P", "D", "C", "A"];
const PAGE_SIZE = 20;
const ROLE_ORDER = { P: 0, D: 1, C: 2, A: 3 };
const ROLE_STYLES = {
  P: "border-orange-300/90 bg-orange-400/35 text-orange-100",
  D: "border-sky-300/90 bg-sky-400/35 text-sky-100",
  C: "border-emerald-300/90 bg-emerald-400/35 text-emerald-100",
  A: "border-red-300/90 bg-red-400/35 text-red-100",
};
const INITIAL_FORM = {
  name: "", role: "", birth_year: "", tier: "utilizzabile", image: "",
  fanta_team_id: "none", real_club: "Svincolato",
  salary: 0, purchase_price: 0,
  transfermarkt_value: 0.1, fantavalore: 1,
};

export default function Listone() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [players, setPlayers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [seasonTeams, setSeasonTeams] = useState([]);
  const [seasonStartYear, setSeasonStartYear] = useState(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("all");
  const [sortConfig, setSortConfig] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(INITIAL_FORM);
  const [isUploading, setIsUploading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const paginationSentinelRef = useRef(null);
  const fileRef = useRef(null);
  const [reminders, setReminders] = useState([]);
  const [uploadingNewImage, setUploadingNewImage] = useState(false);

  const load = async () => {
    const [{ data: pl }, { data: ts }, { data: season }, { data: rems}] = await Promise.all([
      api.get("/players", { params: { limit: null } }),
      api.get("/teams"),
      api.get("/season/current"),
      api.get("/reminders", { params: { limit: null } }),
    ]);
    setPlayers(pl); setTeams(ts); setSeasonTeams(season.squadre_serie_a || []); setSeasonStartYear(season.season_start_year); setReminders(rems)
  };
  useEffect(() => { load(); }, []);

  const isPresident = user?.role === "presidente";
  const teamsMap = Object.fromEntries(teams.map((t) => [t.id, t]));
  const filtered = players.filter((p) => {
    if (p.tier === "altrove" && !p.fanta_team_id && teamFilter !== "freeEstero") return false;
    if (roleFilter !== "all" && p.role !== roleFilter) return false;
    if (teamFilter === "free" && (p.fanta_team_id || p.tier === "altrove")) return false;
    if (teamFilter === "freeEstero" && (p.fanta_team_id || p.tier !== "altrove")) return false;
    if (teamFilter !== "all" && teamFilter !== "free" && teamFilter !== "freeEstero" && p.fanta_team_id !== teamFilter) return false;
    if (query && !p.name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
    const sortedPlayers = sortConfig ? [...filtered].sort((first, second) => {
    const firstValue = sortConfig.key === "team"
      ? teamsMap[first.fanta_team_id]?.name || ""
      : sortConfig.key === "role"
      ? ROLE_ORDER[first.role] ?? 99
      : first[sortConfig.key];
    const secondValue = sortConfig.key === "team"
      ? teamsMap[second.fanta_team_id]?.name || ""
      : sortConfig.key === "role"
      ? ROLE_ORDER[second.role] ?? 99
      : second[sortConfig.key];
    if (firstValue == null || firstValue === "") return secondValue == null || secondValue === "" ? 0 : 1;
    if (secondValue == null || secondValue === "") return -1;
    const firstComparable = typeof firstValue === "string" ? firstValue.toLocaleLowerCase() : firstValue;
    const secondComparable = typeof secondValue === "string" ? secondValue.toLocaleLowerCase() : secondValue;
    if (firstComparable === secondComparable) return 0;
    const result = firstComparable > secondComparable ? 1 : -1;
    return sortConfig.direction === "asc" ? result : -result;
  }) : filtered;

  const sortBy = (key) => setSortConfig((current) => ({
    key,
    direction: current?.key === key && current.direction === "asc" ? "desc" : "asc",
  }));
  const sortIcon = (key) => !sortConfig || sortConfig.key !== key
    ? <ArrowsDownUpIcon size={13} />
    : sortConfig.direction === "asc" ? <CaretUpIcon size={13} /> : <CaretDownIcon size={13} />;

  const totalPages = Math.max(1, Math.ceil(sortedPlayers.length / PAGE_SIZE));
  const visiblePlayers = sortedPlayers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  useEffect(() => { setCurrentPage(1); }, [query, roleFilter, teamFilter, sortConfig]);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  const [isPaginationStuck, setIsPaginationStuck] = useState(false);
  useEffect(() => {
    const sentinel = paginationSentinelRef.current;
    if (!sentinel) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      setIsPaginationStuck(!entry.isIntersecting);
    }, { rootMargin: "-64px 0px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [totalPages]);

  const openPlayer = (p) => {
    const next = new URLSearchParams(searchParams);
    next.set("player", p.id);
    setSearchParams(next);
  };

  const upload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const uploadToastId = "listone-upload";
    setIsUploading(true);
    toast.loading("Non toccare nulla: ti avviso quando ho finito di caricare i dati.", { id: uploadToastId });
    try {
      const { data } = await api.post("/players/upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success(`Listone caricato: ${data.created_num} nuovi, ${data.error_num} errori, ${data.skipped_num} saltati`, { id: uploadToastId });
      load();
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail), { id: uploadToastId });
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleNewImageUpload = async (file) => {
    if (!file) return;
    setUploadingNewImage(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/uploads", fd, {
        params: { category: "player-image" },
        headers: { "Content-Type": "multipart/form-data" },
      });
      setForm((f) => ({ ...f, image: data.filename }));
      toast.success("Immagine caricata");
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally { setUploadingNewImage(false); }
  };

  const createOne = async (e) => {
    e.preventDefault();
    try {
      const integerFields = ["birth_year", "purchase_price", "fantavalore"];
      const numericFields = ["salary", "transfermarkt_value", ...integerFields];
      const values = Object.fromEntries(numericFields.map((field) => [field, Number(form[field])]));
      const realClub = !form.real_club.trim() || form.real_club.trim().toLowerCase() === "svincolato"
        ? "Svincolato"
        : form.real_club.trim();
      if (!form.name.trim()) throw new Error("Inserisci il nome del giocatore");
      if (!ROLES.includes(form.role)) throw new Error("Seleziona un ruolo valido");
      if (form.tier === "utilizzabile" && (realClub === "Svincolato" || !seasonTeams.includes(realClub))) throw new Error("Seleziona un Club Reale presente nella stagione corrente");
      if (!Number.isInteger(values.birth_year) || values.birth_year < 1950) throw new Error("L'anno di nascita deve essere almeno 1950");
      if (numericFields.some((field) => !Number.isFinite(values[field]))) throw new Error("I valori numerici devono essere validi");
      if (values.salary < 0 || values.transfermarkt_value < 0.1 || values.fantavalore < 1 || values.purchase_price < 0) {
        throw new Error("Controlla i valori numerici inseriti");
      }
      if (form.tier === "academy") {
        if (form.fanta_team_id === "none" || values.purchase_price !== 0) {
          throw new Error("Un giocatore Academy deve avere una FantaSquadra e non può avere prezzo");
        }
        if (seasonStartYear && seasonStartYear - values.birth_year > 20) {
          throw new Error("Un giocatore Academy deve avere 20 anni o meno nella stagione corrente");
        }
      }
      const fantaTeamId = form.fanta_team_id === "none" ? null : form.fanta_team_id;
      await api.post("/players", {
        name: form.name.toUpperCase(),
        role: form.role,
        birth_year: values.birth_year,
        image: form.image || null,
        tier: form.tier,
        fanta_team_id: fantaTeamId,
        current_team_id: fantaTeamId,
        paying_team_id: fantaTeamId,
        jersey_number: null,
        real_club: realClub,
        salary: values.salary,
        renewal_count: 0,
        purchase_price: values.purchase_price,
        transfermarkt_value: values.transfermarkt_value,
        fantavalore: values.fantavalore,
        contract_years: 0,
        contract_start: null,
        contract_end: null,
        first_contract_start: null,
      });
      toast.success("Giocatore aggiunto al listone");
      setNewOpen(false);
      setForm(INITIAL_FORM);
      load();
    } catch (e) { toast.error(e.response ? formatApiError(e.response?.data?.detail) : e.message); }
  };

  const pIngaggiati = players.filter((p) => p.fanta_team_id && p.tier != "academy").length;
  const pAcademy = players.filter((p) => p.tier === "academy").length;
  const pSvincolati = players.filter((p) => !p.fanta_team_id && p.tier !== "altrove").length;
  const pSvincolatiEstero = players.filter((p) => !p.fanta_team_id && p.tier == "altrove").length;

  return (
    <div data-testid={LISTONE.container} className="mx-auto max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">Database centrale</div>
          <h1 className="font-display text-4xl lg:text-5xl font-bold tracking-tighter">
            <UsersIcon size={44} className="inline mr-3 text-[color:var(--primary-hover)]" />
            Listone Giocatori
          </h1>
          <p className="text-[color:var(--text-muted)] mt-2">
            {pIngaggiati} ingaggiati · {pAcademy} academy · {pSvincolati} svincolati {(isPresident) && (`· ${pSvincolatiEstero} svincolati extra`)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isPresident && (
            <>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={upload} className="hidden" data-testid={LISTONE.fileInput} />
          <Button data-testid={LISTONE.uploadBtn} disabled={isUploading} onClick={() => fileRef.current?.click()} className="bg-[color:var(--gold)] text-black hover:bg-[color:var(--gold)]/90 font-bold">
            <UploadSimpleIcon size={16} className="mr-2" /> Carica listone (.xlsx/.csv)
          </Button>
          <Dialog open={newOpen} onOpenChange={setNewOpen}>
            <DialogTrigger asChild>
              <Button data-testid={LISTONE.newBtn} disabled={isUploading} variant="outline" className="border-[color:var(--border)]">
                <PlusIcon size={16} className="mr-2" /> Aggiungi manuale
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-[color:var(--bg-surface)] border-[color:var(--border)] max-w-2xl">
              <DialogHeader><DialogTitle>Aggiungi giocatore al listone</DialogTitle></DialogHeader>
              <form onSubmit={createOne} className="grid grid-cols-2 gap-3 max-h-[75vh] overflow-y-auto pr-1">
                <div className="col-span-2">
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Nome</label>
                  <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] uppercase" />
                </div>
                <div className="col-span-2 space-y-2">
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Immagine</label>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <Input
                      placeholder="Incolla un URL esterno…"
                      value={form.image}
                      onChange={(e) => setForm({ ...form, image: e.target.value })}
                      className="flex-1 bg-[color:var(--bg-main)] border-[color:var(--border)]"
                    />
                    <span className="text-[10px] text-[color:var(--text-muted)] uppercase tracking-widest shrink-0">oppure</span>
                    <Input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={uploadingNewImage}
                      onChange={(e) => handleNewImageUpload(e.target.files?.[0])}
                      className="flex-1 bg-[color:var(--bg-main)] border-[color:var(--border)]"
                    />
                  </div>
                  {form.image && (
                    <a href={resolveImageUrl(form.image)} target="_blank" rel="noreferrer" className="text-xs text-[color:var(--gold)] hover:underline inline-block">
                      Anteprima attuale (apri)
                    </a>
                  )}
                  {uploadingNewImage && <div className="text-xs text-[color:var(--gold)]">Caricamento…</div>}
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Anno di nascita</label>
                  <Input
                    required
                    type="number"
                    inputMode="numeric"
                    min="1950"
                    max={seasonStartYear || undefined}
                    step="1"
                    value={form.birth_year}
                    onChange={(e) => setForm({ ...form, birth_year: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                    className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Ruolo</label>
                  <Select value={form.role || undefined} onValueChange={(v) => setForm({ ...form, role: v })}>
                    <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue placeholder="Seleziona ruolo" /></SelectTrigger>
                    <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Tier</label>
                  <Select value={form.tier} onValueChange={(v) => setForm({ ...form, tier: v, real_club: v === "utilizzabile" && seasonTeams.includes(form.real_club) ? form.real_club : "" })}>
                    <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="utilizzabile">Utilizzabile</SelectItem><SelectItem value="academy">Academy</SelectItem><SelectItem value="altrove">Altrove</SelectItem></SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Club Reale</label>
                  {form.tier !== "utilizzabile" ? (
                    <Input value={form.real_club} onChange={(e) => setForm({ ...form, real_club: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)]" />
                  ) : (
                    <Select value={form.real_club || undefined} onValueChange={(v) => setForm({ ...form, real_club: v })}>
                      <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue placeholder="Seleziona club" /></SelectTrigger>
                      <SelectContent>{seasonTeams.map((club) => <SelectItem key={club} value={club}>{club}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">FantaSquadra</label>
                  <Select value={form.fanta_team_id} onValueChange={(v) => setForm({ ...form, fanta_team_id: v })}>
                    <SelectTrigger className="bg-[color:var(--bg-main)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">Svincolato</SelectItem>{teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Stipendio</label>
                  <Input type="number" min="0" step="0.1" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Valore</label>
                  <Input required type="number" min="0.1" step="0.1" value={form.transfermarkt_value} onChange={(e) => setForm({ ...form, transfermarkt_value: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">FantaValore</label>
                  <Input type="number" min="1" step="1" value={form.fantavalore} onChange={(e) => setForm({ ...form, fantavalore: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] font-bold block mb-1">Prezzo</label>
                  <Input type="number" min="0" step="1" value={form.purchase_price} onChange={(e) => setForm({ ...form, purchase_price: e.target.value })} className="bg-[color:var(--bg-main)] border-[color:var(--border)] font-mono" />
                </div>
                <DialogFooter className="col-span-2"><Button type="submit" className="bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)]">Salva</Button></DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
            </>
          )}
        </div>
      </div>

      {isPresident && <Collapsible className="mb-6 overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-surface)]">
        <CollapsibleTrigger className="group flex w-full items-center justify-between border-b border-[color:var(--border)] px-4 py-3 text-left sm:px-5">
          <span>
            <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[color:var(--gold)]">
              <UploadSimpleIcon size={14} /> Formato listone
            </span>
            <span className="mt-1 block text-xs text-[color:var(--text-muted)]">Usa i nomi delle colonne qui sotto per importare il file senza errori.</span>
          </span>
          <CaretDownIcon size={16} className="shrink-0 text-[color:var(--text-muted)] transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.3fr)] sm:px-5">
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--text-muted)]">Obbligatorie</div>
            <div className="flex flex-wrap gap-2">
              {["Nome", "Anno", "Ruolo"].map((column) => <span key={column} className="rounded-md border border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 px-2.5 py-1 font-mono text-xs text-[color:var(--gold)]">{column}</span>)}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--text-muted)]">Opzionali</div>
            <div className="flex flex-wrap gap-2">
              {["Squadra", "FantaSquadra", "Stipendio Base", "Numero Rinnovo", "Prezzo", "Valore", "FantaValore", "Numero", "Anni di Contratto", "Scadenza di Contratto", "Tier", "Immagine",].map((column) => <span key={column} className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-main)] px-2.5 py-1 font-mono text-xs text-[color:var(--text-muted)]">{column}</span>)}
            </div>
          </div>
          </div>
          <div className="border-t border-[color:var(--border)] bg-[color:var(--bg-main)] px-4 py-3 text-xs text-[color:var(--text-muted)] sm:px-5">
            <span className="font-bold text-[color:var(--text)]">Duplicati:</span> le righe con lo stesso nome e anno di nascita vengono saltate.
          </div>
        </CollapsibleContent>
      </Collapsible>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Input placeholder="Cerca giocatore…" value={query} onChange={(e) => setQuery(e.target.value)} className="bg-[color:var(--bg-surface)] border-[color:var(--border)]" />
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutti i ruoli</SelectItem>
            {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={teamFilter} onValueChange={setTeamFilter}>
          <SelectTrigger className="bg-[color:var(--bg-surface)] border-[color:var(--border)]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tutte le squadre</SelectItem>
            <SelectItem value="free">Svincolati</SelectItem>
            {(isPresident) && (<SelectItem value="freeEstero">Svincolati extra</SelectItem>)}
            {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {totalPages > 1 && (
        <>
        <div ref={paginationSentinelRef} className="h-px" aria-hidden="true" />
        <div className={`sticky top-16 z-30 mb-3 flex items-center justify-between gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-surface)]/95 shadow-lg backdrop-blur-sm transition-all duration-200 ${isPaginationStuck ? "mx-auto w-fit px-2 py-1" : "w-full px-4 py-2"}`}>
          <Button type="button" size="icon" variant="outline" disabled={currentPage === 1} onClick={() => setCurrentPage((page) => page - 1)} aria-label="Pagina precedente" title="Pagina precedente" className="h-7 w-7 border-[color:var(--border)]">
            <CaretLeftIcon size={16} />
          </Button>
          <span className="text-[11px] text-[color:var(--text-muted)]">Pagina {currentPage} di {totalPages}</span>
          <Button type="button" size="icon" variant="outline" disabled={currentPage === totalPages} onClick={() => setCurrentPage((page) => page + 1)} aria-label="Pagina successiva" title="Pagina successiva" className="h-7 w-7 border-[color:var(--border)]">
            <CaretRightIcon size={16} />
          </Button>
        </div>
        </>
      )}

      <Card className="bg-[color:var(--bg-surface)] border-[color:var(--border)]">
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--bg-surface)]">
              <tr className="text-center text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] border-b border-[color:var(--border)]">
                {[
                  ["image", "", false, ""],
                  ["role", "Ruolo", true, ""],
                  ["name", "Nome", true, ""],
                  ["team", "FantaSquadra", false, "hidden md:table-cell"],
                  ["transfermarkt_value", "Valore", true, "hidden md:table-cell"],
                  ["fantavalore", "FantaValore", true, "hidden md:table-cell"],
                  ["cartellino", "Cartellino", true, "hidden md:table-cell"],
                  ["birth_year", "Anno", true, "hidden md:table-cell"],
                ].map(([key, label, sortable, visibility]) => (
                  <th key={key} className={`bg-[color:var(--bg-surface)] p-3 ${visibility}`}>
                    {sortable ? (
                      <button type="button" onClick={() => sortBy(key)} className="inline-flex items-center gap-1 font-inherit uppercase tracking-inherit hover:text-[color:var(--text)]">
                        {label} {sortIcon(key)}
                      </button>
                    ) : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="p-10 text-center text-[color:var(--text-muted)]">Nessun giocatore.</td></tr>
              )}
              {visiblePlayers.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => openPlayer(p)}
                  className="cursor-pointer border-b border-[color:var(--border)] last:border-b-0 hover:bg-[color:var(--bg-elev)] transition-colors"
                >
                  <td className="p-3 text-center align-middle">
                    {p.image ? (
                      <img src={resolveImageUrl(p.image)} alt="" className="h-10 w-10 rounded object-cover mx-auto" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-[color:var(--bg-elev)] flex items-center justify-center mx-auto text-[color:var(--text-muted)]">
                        <UserIcon size={18} weight="fill" />
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-center align-middle"><span className={`inline-flex min-w-8 justify-center rounded border px-2 py-1 font-mono font-bold ${ROLE_STYLES[p.role] || "border-[color:var(--border)] text-[color:var(--text-muted)]"}`}>{p.role}</span></td>
                  <td className="p-3 text-center align-middle font-medium">{p.jersey_number !== null && p.jersey_number !== undefined ? `#${p.jersey_number} - ${p.name}` : p.name}</td>
                  <td className="hidden md:table-cell p-3 text-center align-middle">
                    {p.fanta_team_id ? (
                      <span className="text-[color:var(--primary-text)]">{teamsMap[p.fanta_team_id]?.name || "?"}</span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-widest text-[color:var(--text-muted)] border border-[color:var(--border)] rounded px-2 py-0.5">Svincolato</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell p-3 text-center align-middle font-mono">{fmtValue(p.transfermarkt_value)}</td>
                  <td className="hidden md:table-cell p-3 text-center align-middle font-mono">{fmt(p.fantavalore)}</td>
                  <td className="hidden md:table-cell p-3 text-center align-middle font-mono">{fmt(p.cartellino)}</td>
                  <td className="hidden md:table-cell p-3 text-center align-middle font-mono">
                    <span className={seasonStartYear && seasonStartYear - p.birth_year <= 23 ? "inline-flex min-w-8 justify-center rounded border border-lime-200/90 bg-lime-300/80 px-2 py-1 font-bold text-lime-950" : ""}>
                      {p.birth_year || "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {isUploading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm" role="status" aria-live="polite">
          <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-surface)] px-8 py-7 text-center shadow-2xl">
            <SpinnerGapIcon size={30} className="animate-spin text-[color:var(--gold)]" />
            <div>
              <p className="font-display text-lg font-bold text-[color:var(--text)]">Sto caricando il listone</p>
              <p className="mt-1 text-sm text-[color:var(--text-muted)]">Non toccare nulla: ti avviso quando ho finito di caricare i dati.</p>
            </div>
          </div>
        </div>
      )}

      <PlayerDialog players={players} teams={teams} reminders={reminders} seasonStartYear={seasonStartYear} onPlayerDeleted={load} seasonTeams={seasonTeams}/>
    </div>
  );
}