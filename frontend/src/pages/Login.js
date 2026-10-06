import { useState, useEffect } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { AUTH } from "@/constants/testIds";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const PRINCIPLES = [
  { numeral: "I", text: "LA Lega è una lega fondata sulla reciproca fiducia. Tra gli 8 fantallenatori, massima autonomia è concessa nella gestione della propria franchigia; massimo rigore viene applicato in caso di comportamenti scorretti." },
  { numeral: "II", text: "LA Lega è una lega fondata sull'agonismo. Ciascun fantallenatore partecipante s'impegna ad alimentare proattivamente il clima competitivo: tendendo ad anticipare le scadenze, partecipando con frequenza e vigore alle discussioni sul gruppo, privilegiando il folclore, sollevando tempestivamente eventuali dubbie questioni, rifuggendo da una conduzione improntata sull'inerzia e adoperandosi continuamente per tenere alti i colori della propria società." },
  { numeral: "III", text: "LA Lega è una lega fondata sul rispetto. Rispetto reciproco tra i fantallenatori, per il ruolo del presidente, per le tempistiche, per il sano sviluppo della lega. Rispetto per il regolamento." },
  { numeral: "IV", text: "LA Lega è una lega fondata sul divertimento. Il suo ordinamento è tutt'altro che rigido: con l'obiettivo ultimo della godibilità della lega, ciascun suo aspetto può essere modificato o riadattato alle nuove esigenze degli 8 fantallenatori, unici attori del processo decisionale. Il buon senso, un dialogo trasparente e democratico, in sinergia con le procedure previste dal regolamento ufficiale, costituiscono le sole bussole per l'approvazione di riforme definitive, deroghe temporanee, per rimediare ad eventuali buchi di regolamento e per la risoluzione di controversie. Il regolamento ha senso solo in quanto espressione somma e sintetica della presente volontà degli 8 componenti." },
  { numeral: "V", text: "LA Lega è una lega continuata che unisce ad una dimensione classica di gestione della rosa una dimensione di gestione finanziaria. La rosa si compone di Prima squadra, Primavera e Tribuna. La struttura finanziaria si compone di Valore Società, BDG Trasferimenti, BDG Stipendi, U Liberi e U Maturati da destinare. Ciascun fantallenatore è tenuto ad assumere una visione a lungo termine rispetto alla propria gestione societaria e a salvaguardare la natura continuata della competizione per gli anni a venire." },
  { numeral: "VI", text: "LA Lega è una lega il cui funzionamento è garantito dal presidente. La figura del presidente, forte delle responsabilità ad essa connesse, ha la funzione esclusiva di agevolare il processo decisionale e di curare l'integrità della lega, incarnandone la gestione e il funzionamento ordinari. La carica di presidente si basa sulla propria autorevolezza, mantenuta dando continua prova della propria adeguatezza. Dovesse, in qualsiasi momento, venir meno tale riconoscimento, la carica passerebbe necessariamente di mano." },
  { numeral: "VII", text: "Aderendo alla lega, ciascun fantallenatore sottoscrive implicitamente il presente regolamento, sposandone in primo luogo i principi e accettando di sottostare ad esso in prima persona entro i confini de LA Lega." },
];

/* Componente Login che mostra la pagina di login per gli utenti. */

export default function Login() {
  const { user, login, error } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [season, setSeason] = useState(null);
  useEffect(() => {
    api.get("/season/current").then(({ data }) => setSeason(data)).catch(() => {});
  }, []);
  const seasonLabel = season ? `${season.season_start_year}-${String(season.season_end_year).slice(-2)}` : "";

  /* Se l'utente è già loggato, reindirizza alla dashboard */
  if (user) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const ok = await login(email, password);
    setLoading(false);
    if (ok) nav("/");
  };

  return (
    <div className="min-h-screen flex w-full">
      <div className="flex items-center justify-center p-6 sm:p-12 w-full lg:w-[45%]">
        <div className="w-full max-w-md">
          <Link to="/" data-testid={AUTH.logoHome} className="mb-8 flex items-center gap-3 group">
            <img src="/logo.png" alt="LA Lega" className="h-12 w-12 object-contain drop-shadow-[0_0_16px_rgba(212,175,55,0.35)] transition-transform group-hover:scale-105" />
            <div>
              <div className="font-display text-2xl font-bold gradient-text">LA LEGA</div>
              <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--text-muted)]">
                {seasonLabel ? `Stagione ${seasonLabel}` : "Stagione"}
              </div>
            </div>
          </Link>

          <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--gold)] mb-2">
            Accedi
          </div>
          <h2 className="font-display text-4xl font-bold mb-2">Bentornato.</h2>
          <p className="text-[color:var(--text-muted)] mb-8">
            Inserisci le tue credenziali.
          </p>

          <form onSubmit={submit} className="space-y-5">
            <div>
              <label className="text-[10px] uppercase tracking-[0.25em] font-bold text-[color:var(--text-muted)] block mb-2">
                Email
              </label>
              <Input
                data-testid={AUTH.emailInput}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="presidente@lalega.it"
                required
                className="h-12 bg-[color:var(--bg-surface)] border-[color:var(--border)]"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.25em] font-bold text-[color:var(--text-muted)] block mb-2">
                Password
              </label>
              <Input
                data-testid={AUTH.passwordInput}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="h-12 bg-[color:var(--bg-surface)] border-[color:var(--border)]"
              />
            </div>

            {error && (
              <div
                data-testid={AUTH.errorAlert}
                className="text-sm text-[color:var(--danger)] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 rounded-lg px-4 py-3"
              >
                {error}
              </div>
            )}

            <Button
              data-testid={AUTH.submitButton}
              type="submit"
              disabled={loading}
              className="w-full h-12 rounded-full bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)] text-white font-bold btn-pulse"
            >
              {loading ? "Accesso in corso…" : "Entra nella Lega"}
            </Button>
          </form>

          <div className="mt-8 pt-6 border-t border-[color:var(--border)] text-xs text-[color:var(--text-muted)] flex items-center justify-between">
            <span>Non hai le credenziali? Contatta il Presidente della Lega.</span>
            <Link to="/" data-testid={AUTH.backHome} className="text-[color:var(--gold)] hover:underline font-bold">
              ← Torna alla home
            </Link>
          </div>
        </div>
      </div>

      <div className="relative hidden lg:block lg:w-[55%] overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto px-4 py-4">
          <div className="space-y-3 mx-auto">
            {PRINCIPLES.map((p) => (
              <div key={p.numeral} className="text-center">
                <div className="font-display text-[color:var(--gold)] text-lg">
                  {p.numeral}
                </div>
                <p className="text-[color:var(--text-secondary)] text-xs">{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
