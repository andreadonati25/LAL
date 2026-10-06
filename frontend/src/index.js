import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/* Primo file JavaScript eseguito quando il browser carica la pagina.
  Unico compito è prendere l'elemento con ID "root" e renderizzare l'app React all'interno di esso
  in questo caso è frontend/public/index.html */

  /* React.StrictMode è una modalità di sviluppo, un componente che aiuta a individuare problemi nell'applicazione React.
  Non ha effetto sulla produzione, ma in modalità sviluppo attiva controlli aggiuntivi e avvisi per aiutare a scrivere codice più sicuro e robusto. */
  