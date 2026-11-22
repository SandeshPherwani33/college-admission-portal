const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const frontendPath = path.resolve(__dirname, '../../frontend/dist/index.html');
  const localFrontend = pathToFileURL(frontendPath).href;
  const devUrl = process.env.UNIAPPLY_DESKTOP_URL || 'http://127.0.0.1:5173';
  const targetUrl = app.isPackaged ? localFrontend : devUrl;

  win.loadURL(targetUrl).catch((error) => {
    console.error('Unable to load UniApply-AI frontend:', error);
    app.quit();
  });
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const isTrusted = app.isPackaged
      ? url === localFrontend
      : new URL(url).origin === new URL(devUrl).origin;
    if (!isTrusted) event.preventDefault();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
