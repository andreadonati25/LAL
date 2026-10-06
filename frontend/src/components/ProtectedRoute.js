import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";

/* ProtectedRoute è un componente che avvolge le pagine che richiedono autenticazione. */

export default function ProtectedRoute({ children, presidentOnly = false }) {
  const { user } = useAuth();
  if (user === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-pulse text-[color:var(--text-muted)] font-mono text-sm">
          Caricamento…
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (presidentOnly && user.role !== "presidente") return <Navigate to="/" replace />;
  return children;
}
