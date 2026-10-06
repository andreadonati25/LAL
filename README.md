# LA Lega — Management Platform

[Italiano](#italiano) | [English](#english)

## Italiano

Piattaforma web gestionale custom creata per amministrare **LA Lega**, un fantacalcio continuato a 8 squadre giocato tra amici. Il software sostituisce la gestione tramite fogli di calcolo automatizzando la burocrazia di lega (contratti pluriennali, finanze di club, mercato e rose mensili).

### Funzionalità Principali

* **Gestione Finanziaria**: Budget trasferimenti, monte ingaggi, utili e capienza stadio.

* **Contratti e Rinnovi**: Durata contrattuale, calcolo ingaggi effettivi, scadenze e svincoli.

* **Trasferimenti**: Compravendite, scambi, prestiti, clausole e bonus.

* **Composizione Rosa**: Organizzazione delle rose (Prima Squadra, Primavera, Tribuna, Academy, In Prestito) con validazioni automatiche.

* **Motore di Scadenze**: Rilevamento automatico delle scadenze di lega.

### Note sullo Sviluppo

La progettazione del regolamento, la modellazione del database e la struttura delle API sono state ideate da me e dal mio gruppo di lega. Per la scrittura di parte del codice sorgente mi sono avvalso del supporto dell'Intelligenza Artificiale come strumento di affiancamento, mantenendo il controllo diretto sull'architettura e sulla validazione della logica.

### Architettura Tecnica

* **Backend**: Python 3.10+, FastAPI, MongoDB, Pydantic, JWT.

* **Frontend**: React 18, Tailwind CSS.

### Setup e Configurazione

Per le istruzioni dettagliate su come configurare i file `.env` e avviare il progetto, consulta il file [SETUP.md](SETUP.md).

### Licenza e Proprietà

Copyright © 2026 LA Lega. Tutti i diritti riservati.

Questo software è un progetto privato ad uso personale. La struttura dei dati, il codice e la logica di regolamento non sono destinati alla redistribuzione o all'uso commerciale senza l'autorizzazione degli autori.

## English

Custom web management platform built to run **LA Lega**, an 8-team continuous fantasy football league played among friends. The software replaces spreadsheet tracking by automating league operations (multi-year contracts, club finances, transfers, and monthly rosters).

### Key Features

* **Financial Management**: Transfer budget tracking, wage bill, contract amortization, stadium capacity, and profit distribution.

* **Contracts & Renewals**: Contract duration, effective salary calculation, expirations, and releases.

* **Transfers**: Sales, loans (dry, option, or obligation to buy), custom clauses, and performance bonuses.

* **Roster Management**: Squad sectioning (First Team, Youth, Stands, Academy, On Loan) with automated validations.

* **Deadline Engine**: Backend checks to detect invalid squad setups before league deadlines.

### Development Note

The rules, database schema, and API architecture were designed by me and my league partners. AI tools were used to assist in writing parts of the code, while I retained full oversight of the system architecture and business logic validation.

### Tech Stack

* **Backend**: Python 3.10+, FastAPI, MongoDB, Pydantic, JWT.

* **Frontend**: React 18, Tailwind CSS.

### License & Ownership

Copyright © 2026 LA Lega. All rights reserved.

This software is a private project for personal use. The data structure, code, and league rules logic are not intended for redistribution or commercial use without authorization from the authors.