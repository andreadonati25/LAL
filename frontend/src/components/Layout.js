import { useState, useEffect, useCallback } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { NAV, AUTH } from "@/constants/testIds";
import api from "@/lib/api";
import {
  BellIcon, ListIcon, XIcon, UsersIcon, NewspaperIcon,
  ShieldStarIcon, SignOutIcon, UsersThreeIcon, ClockCounterClockwiseIcon,
  GearSixIcon, SignInIcon, CheckIcon, RepeatIcon
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import SettingsDialog from "@/components/SettingsDialog";
import { toast } from "sonner";

/* File che definisce la struttura del layout principale dell'applicazione. 
  In particolare, definisce l'header e il menu di navigazione. */

/* I blocchi delle voci del menu, poi generati con NavLink */
const links = [
  { to: "/squadra", label: "Squadre", icon: UsersIcon, tid: NAV.squadra },
  { to: "/listone", label: "Listone", icon: UsersThreeIcon, tid: NAV.listone },
  { to: "/trasferimenti", label: "Trasferimenti", icon: RepeatIcon, tid: NAV.trasferimenti },
  { to: "/bacheca", label: "Bacheca", icon: NewspaperIcon, tid: NAV.bacheca },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [pwOpen, setPwOpen] = useState(false);

  /* Lancia il controllo globale anche per ospiti, mentre il controllo bloccante rimane riservato agli utenti autenticati. */
  useEffect(() => {
    let isMounted = true;

    const runSystemChecks = async () => {
      try {
        await api.post("/system/check-global");
      } catch {
        /* ignore */
      }

      if (!user || user === false) return;

      try {
        const { data } = await api.get("/system/check-blocking");
        if (!isMounted || !data?.block || !data?.redirect) return;
        if (location.pathname === data.redirect) return;
        nav(data.redirect, { replace: true });
        toast.info(data.message, {duration: 10000});
      } catch {
        /* ignore */
      }
    };

    runSystemChecks();
    return () => { isMounted = false; };
  }, [user, location.pathname, nav]);

  /* Carica le notifiche dell'utente loggato. Se l'utente non è loggato, non fa nulla. */
  const loadNotif = useCallback(async () => {
    if (!user || user === false) return;
    try {
      const { data } = await api.get("/notifications");
      setNotifications(data);
    } catch { /* ignore */ }
  }, [user]);

  /* Polling: ogni 15 secondi ricarica le notifiche. */
  useEffect(() => {
    if (user && user !== false) {
      loadNotif();
      const t = setInterval(loadNotif, 15000);
      return () => clearInterval(t);
    }
  }, [user, loadNotif]);

  const unread = notifications.filter((n) => !n.read).length;
  const markAllRead = async () => { await api.post("/notifications/read-all"); loadNotif(); };
  const markOneRead = async (notifId) => {
    try { await api.post(`/notifications/${notifId}/read`); loadNotif(); }
    catch { /* ignore */ }
  };
  const goToNotifLink = (n) => { if (n.link) markOneRead(n.id); nav(n.link); };
  const doLogout = async () => { await logout(); nav("/login"); };

  const isLogged = user && user !== false;
  const showSettings = isLogged && user?.role !== "presidente";

  /* Navlink a differenza di Link sa se il link corrisponde alla pagina corrente */
  /* Map trasforma l'array links in un array di NavLink, uno per ogni voce del menu */

  return (
    <div className="min-h-screen relative grain">
      <header
        data-testid={NAV.container}
        className="sticky top-0 z-40 border-b border-[color:var(--border)] bg-[color:var(--bg-main)]/85 backdrop-blur-xl"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          {/* Logo e titolo dell'applicazione */}
          <NavLink to="/" data-testid={NAV.dashboard} className="flex items-center gap-3 group">
            <img src="/logo.png" alt="LA Lega" className="h-10 w-10 object-contain drop-shadow-[0_0_12px_rgba(212,175,55,0.35)]" />
            <div className="leading-tight">
              <div className="font-display text-lg font-bold gradient-text whitespace-nowrap">LA LEGA</div>
            </div>
          </NavLink>

          {/* Menu di navigazione principale */}
          <nav className="hidden lg:flex items-center gap-1">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                title={l.label}
                data-testid={l.tid}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                    isActive
                      ? "bg-[color:var(--primary)] text-white"
                      : "text-[color:var(--text-secondary)] hover:text-white hover:bg-[color:var(--bg-elev)]"
                  }`
                }
              >
                <l.icon size={16} weight="bold" />
                {l.label}
              </NavLink>
            ))}
            {isLogged && (
              <NavLink
                key="/storico"
                to="/storico"
                title="Registro"
                data-testid={NAV.storico}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                    isActive
                      ? "bg-[color:var(--primary)] text-white"
                      : "text-[color:var(--text-secondary)] hover:text-white hover:bg-[color:var(--bg-elev)]"
                  }`
                }
              >
                <ClockCounterClockwiseIcon size={16} weight="bold" />
              </NavLink>
            )}
            {user?.role === "presidente" && (
              <NavLink
                to="/admin"
                title="Amministrazione"
                data-testid={NAV.admin}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
                    isActive
                      ? "bg-[color:var(--gold)] text-black"
                      : "text-[color:var(--gold)] hover:bg-[color:var(--gold)]/10"
                  }`
                }
              >
                <ShieldStarIcon size={16} weight="bold" />
              </NavLink>
            )}
          </nav>

          {/* Popover delle notifiche */}
          <div className="flex items-center gap-2">
            {isLogged && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    data-testid={NAV.notifBtn}
                    className="relative h-9 w-9 rounded-lg border border-[color:var(--border)] flex items-center justify-center hover:bg-[color:var(--bg-elev)] transition-colors"
                  >
                    <BellIcon size={18} weight="bold" />
                    {unread > 0 && (
                      <span className="absolute -top-1 -right-1 text-[10px] bg-[color:var(--gold)] text-black rounded-full h-4 min-w-4 px-1 font-bold flex items-center justify-center">
                        {unread}
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0 border-[color:var(--border)] bg-[color:var(--bg-surface)]">
                  <div className="flex items-center justify-between p-3 border-b border-[color:var(--border)]">
                    <div className="text-sm font-bold uppercase tracking-widest">Notifiche</div>
                    <Button variant="ghost" size="sm" onClick={markAllRead} className="text-xs">
                      Segna lette
                    </Button>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.length === 0 && (
                      <div className="p-6 text-sm text-[color:var(--text-muted)] text-center">Nessuna notifica</div>
                    )}
                    {notifications.map((n) => (
                      <div key={n.id} className={`px-4 py-3 border-b border-[color:var(--border)] text-sm ${n.read ? "opacity-60" : ""}`}>
                        <button
                          type="button"
                          onClick={() => goToNotifLink(n)}
                          disabled={!n.link}
                          className={`flex-1 text-left ${n.link ? "cursor-pointer hover:text-[color:var(--gold)]" : "cursor-default"}`}
                        >
                          {n.text}
                        </button>
                        <div className="flex items-center justify-between mt-1">
                          <div className="text-[10px] text-[color:var(--text-muted)] mt-1 font-mono">
                            {new Date(n.created_at).toLocaleString("it-IT")}
                          </div>
                          {!n.read && (
                            <button
                              type="button"
                              onClick={() => markOneRead(n.id)}
                              title="Segna come letta"
                              className="shrink-0 h-6 w-6 rounded-md flex items-center justify-center hover:bg-[color:var(--bg-elev)] text-[color:var(--success)]"
                            >
                              <CheckIcon size={14} weight="bold" />
                          </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {showSettings && (
              <button
                data-testid={NAV.settingsBtn}
                onClick={() => setPwOpen(true)}
                className="h-9 w-9 rounded-lg border border-[color:var(--border)] flex items-center justify-center hover:bg-[color:var(--bg-elev)] transition-colors"
                title="Impostazioni"
              >
                <GearSixIcon size={16} weight="bold" />
              </button>
            )}  

            {/* Login/Logout e pulsante per cambiare password */}
            {isLogged ? (
              <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-[color:var(--border)]">
                <div className="text-right leading-tight">
                  <div className="text-xs font-bold">{user?.name}</div>
                  <div className="text-[10px] uppercase tracking-widest text-[color:var(--gold)]">{user?.role}</div>
                </div>
                <button
                  data-testid={AUTH.logoutBtn}
                  onClick={doLogout}
                  className="h-9 w-9 rounded-lg border border-[color:var(--border)] flex items-center justify-center hover:bg-[color:var(--danger)]/20 hover:border-[color:var(--danger)] transition-colors"
                  title="Esci"
                >
                  <SignOutIcon size={16} weight="bold" />
                </button>
              </div>
            ) : (
              <NavLink
                to="/login"
                data-testid={AUTH.loginBtn}
                className="hidden sm:flex items-center gap-2 rounded-full bg-[color:var(--primary)] hover:bg-[color:var(--primary-hover)] text-white px-4 py-2 text-sm font-bold btn-pulse"
              >
                <SignInIcon size={16} weight="bold" /> Accedi
              </NavLink>
            )}

            {/* Pulsante per aprire il menu a tendina su mobile */}
            <button
              data-testid={NAV.mobileToggle}
              onClick={() => setOpen(!open)}
              className="lg:hidden h-9 w-9 rounded-lg border border-[color:var(--border)] flex items-center justify-center"
            >
              {open ? <XIcon size={18} /> : <ListIcon size={18} />}
            </button>
          </div>
        </div>

        {/* Menu a tendina per dispositivi mobili: open è la variabile che controlla la visibilità */}
        {open && (
          <div className="lg:hidden border-t border-[color:var(--border)] bg-[color:var(--bg-surface)]">
            <div className="px-4 py-3 flex flex-col gap-1">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
                      isActive ? "bg-[color:var(--primary)] text-white" : "text-[color:var(--text-secondary)]"
                    }`
                  }
                >
                  <l.icon size={16} weight="bold" />
                  {l.label}
                </NavLink>
              ))}
              {isLogged && (
                <NavLink
                  key="/storico"
                  to="/storico"
                  data-testid={"nav-storico"}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
                      isActive ? "bg-[color:var(--primary)] text-white" : "text-[color:var(--text-secondary)]"
                    }`
                  }
                >
                  <ClockCounterClockwiseIcon size={16} weight="bold" />
                  Storico
                </NavLink>
              )}
              {user?.role === "presidente" && (
                <NavLink to="/admin" onClick={() => setOpen(false)} className={({ isActive }) => `px-3 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${isActive ? "bg-[color:var(--gold)] text-black" : "text-[color:var(--gold)]"}`}>
                  <ShieldStarIcon size={16} weight="bold" />
                  Presidente
                </NavLink>
              )}
              {isLogged ? (
                <button onClick={doLogout} className="px-3 py-2 rounded-md text-sm text-left text-[color:var(--danger)] flex items-center gap-2">
                  <SignOutIcon size={16} weight="bold" /> Esci
                </button>
              ) : (
                <NavLink to="/login" onClick={() => setOpen(false)} className="px-3 py-2 rounded-md text-sm font-medium bg-[color:var(--primary)] text-white flex items-center gap-2">
                  <SignInIcon size={16} weight="bold" /> Accedi
                </NavLink>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="relative z-10">{children}</main>
      <SettingsDialog open={pwOpen} onOpenChange={setPwOpen} />
    </div>
  );
}
