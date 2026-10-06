import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/context/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Layout from "@/components/Layout";
import { Toaster } from "@/components/ui/sonner";

import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Squadra from "@/pages/Squadra";
import Bacheca from "@/pages/Bacheca";
import Admin from "@/pages/Admin";
import Listone from "@/pages/Listone";
import AuditLog from "@/pages/AuditLog";
import Scadenze from "@/pages/Scadenze";
import Transfer from "@/pages/Transfer";

/* Questo @/.. non è nativo di JavaScript, ma è configurato in frontend/jsconfig.json: "paths": { "@/*": ["src/*"] } e replicato in craco.config.js: alias: { '@': path.resolve(__dirname, 'src') }*/
/* Questa pagina è un layout generico per le pagine pubbliche, contiene l'header e il footer, e il contenuto della pagina viene passato come elemento figlio. */

/* publicPage è una funzione che prende un elemento React e lo avvolge nel layout pubblico. */
const publicPage = (el) => <Layout>{el}</Layout>;

/* useState crea una variabile di stato open che parte con valore false e dammi anche una funzione per aggiornarla.
   La differenza con una variabile normale è che React "ricorda" il valore di open tra un render e l'altro, mentre una variabile normale viene ricreata ad ogni render.
   Quindi react ri-esegue automaticamente la funzione del componente per aggiornare cosa viene mostrato a schermo. \*

/* useEffect esegue del codice dopo che il componente è stato creato e ogni volta che cambia una delle dipendenze. */

/* AuthProvider fornisce il contesto dell'autenticazione a tutti i componenti figli */
/* BrowserRouter gestisce la navigazione tra le pagine */
/* Routes genera una sorta di mappa: URL -> componente da renderizzare */
/* Toaster è un componente che mostra notifiche a comparsa in alto al centro in tutte le pagine */

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={publicPage(<Dashboard />)} />
          <Route path="/squadra" element={publicPage(<Squadra />)} />
          <Route path="/squadra/:id" element={publicPage(<Squadra />)} />
          <Route path="/bacheca" element={publicPage(<Bacheca />)} />
          <Route path="/listone" element={publicPage(<Listone />)} />
          <Route path="/storico" element={publicPage(<AuditLog />)} />
          <Route path="/scadenze" element={publicPage(<Scadenze />)} />
          <Route path="/trasferimenti" element={publicPage(<Transfer />)} />
          <Route
            path="/admin"
            element={
              <ProtectedRoute presidentOnly>
                <Layout><Admin /></Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
      <Toaster richColors position="top-center" theme="dark" />
    </AuthProvider>
  );
}

export default App;
