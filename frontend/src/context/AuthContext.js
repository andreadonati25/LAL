import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api, { formatApiError } from "@/lib/api";

/* Crea un contenitore per il contesto dell'autenticazione, inizialmente nullo. */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null=checking, false=guest, obj=user
  const [error, setError] = useState("");

  /* Verifica lo stato di autenticazione all'avvio dell'applicazione. */
  const bootstrap = useCallback(async () => {
    try {
      /* Chiediamo al backend se l'utente è autenticato */
      const { data } = await api.get("/auth/me");
      setUser(data);
    } catch {
      setUser(false);
    }
  }, []);

  /* bootstrap eseguito una volta */
  useEffect(() => { bootstrap(); }, [bootstrap]);

  /* Chiamo il backend per fare il login */
  const login = async (email, password) => {
    setError("");
    try {
      const { data } = await api.post("/auth/login", { email, password });
      setUser(data);
      return true;
    } catch (e) {
      setError(formatApiError(e.response?.data?.detail) || e.message);
      return false;
    }
  };

  /* Chiamo il backend per fare il logout */
  const logout = async () => {
    try { await api.post("/auth/logout"); } catch { /* ignore */ }
    setUser(false);
  };

  /* Fornisce il contesto dell'autenticazione ai componenti figli. */
  return (
    <AuthContext.Provider value={{ user, setUser, login, logout, error, bootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

/* Un modo per accedere al contesto dell'autenticazione in qualsiasi componente figlio. */
export const useAuth = () => useContext(AuthContext);
