import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const API = `${BACKEND_URL}/api`;

/* Crea l'istanza axios con le impostazioni di base per tutte le chiamate al backend. */
/* baseURL: API significa che ovunque nel resto del codice scriverai api.get("/teams") al posto dover
scrivere api.get("http://localhost:8000/api/teams"). Dettaglio importante è withCredentials: true. 
è quello che porta i cookie httpOnly (dove il backend salva i token JWT) ad essere inclusi */
const api = axios.create({
  baseURL: API,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

/* formatApiError prende il dettaglio di un errore restituito dal backend e lo trasforma in una stringa leggibile. */
export function formatApiError(detail) {
  if (detail == null) return "Errore imprevisto";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e)))
      .join(" ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}

export default api;
