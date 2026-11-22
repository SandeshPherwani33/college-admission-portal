# Desktop client

The desktop client is an Electron shell around the shared React web app. Electron keeps context isolation enabled and Node integration disabled; the renderer communicates with FastAPI using the same API client as the browser.

## Run locally

```powershell
cd desktop
npm install
npm run dev
```

The command starts Vite and opens the desktop window after the web app is ready. Start FastAPI separately from `backend`. The web renderer defaults to `http://127.0.0.1:8000/api`; set `VITE_API_BASE_URL` in `frontend/.env.local` to use a different backend. That value is an API URL, not a credential.

`npm run build` builds the shared frontend production assets. This scaffold does not yet package OS-specific installers.
