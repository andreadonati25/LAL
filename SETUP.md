# Guida all'Avvio e Configurazione (Setup Guide)

Questo documento contiene le istruzioni per configurare l'ambiente di sviluppo locale e avviare i server Backend e Frontend.

## Requisiti di Sistema

* **Python** 3.10+, **Node.js** 18.x (con `npm` o `yarn`), istanza **MongoDB** attiva (in locale o su Atlas).

## Configurazione File `.env`

Prima di avviare le applicazioni, è necessario creare i file di configurazione ambientale.

### Backend (`/backend/.env`)

```
MONGO_URL="mongodb://localhost:27017"
DB_NAME="db_name"
CORS_ORIGINS="http://localhost:3000"
JWT_SECRET="secret_key"
ADMIN_EMAIL="president@lega.it"
ADMIN_PASSWORD="PasswordEsempio"
SEASON_START_YEAR="2026"
SEASON_SQUADRE_SERIE_A="Atalanta,Bologna,Cagliari,Como,Fiorentina,Genoa,Inter,Juventus,Lazio,Lecce,Milan,Monza,Napoli,Parma,Roma,Torino,Udinese,Venezia"
NEXT_TAGLIO="2029"
```

### Frontend (`/frontend/.env`)

```
REACT_APP_BACKEND_URL="http://localhost:8000"
```

## Avvio del Backend (FastAPI)

Apri un terminale e spostati nella cartella backend, installa le dipendenze e avvia il server di sviluppo:

```
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8000
```

Il server sarà attivo su `http://localhost:8000`. Puoi consultare la documentazione interattiva OpenAPI su `http://localhost:8000/docs`.

## Avvio del Frontend (React)

Apri un secondo terminale e spostati nella cartella frontend, installa i pacchetti Node e avvia l'applicazione in modalità development:

```
cd frontend
yarn install
yarn start
```

L'interfaccia utente si aprirà automaticamente su `http://localhost:3000`.