console.log("[DEBUG] Electron executing from:", __dirname);

const electron = require('electron');
const app = electron && electron.app;
const BrowserWindow = electron && electron.BrowserWindow;
const ipcMain = electron && electron.ipcMain;
const path = require('path');
const {
  initCardReader,
  setMode,
  getMode,
  prepareWrite,
  cancelWrite,
  syncBackendPoliciesToCard,
  syncCardToBackend,
  compareCardAndBackendData,
  performSmartSync,
  readStructuredData
} = require('./smartcard');

let mainWindow;
let nfcInstance = null;
let existingCardData = null;
let backendCache = null;

function createWindow() {
  if (!BrowserWindow) {
    console.error('BrowserWindow not available');
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
    title: 'ANUR Onewealth Card Master',
    backgroundColor: '#000000'
  });

  // Check if user is logged in (by checking if there's a session)
  // Start with login screen - the login.html will check session and redirect if needed
  mainWindow.loadFile(path.join(__dirname, '../renderer/dashboard.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Check if app is available
if (typeof app !== 'undefined' && app) {
  app.on('ready', () => {
    createWindow();

    // Initialize NFC card reader with callbacks
    nfcInstance = initCardReader(
      (cardData) => {
        console.log('[main] Card data received:', cardData.status || cardData.mode);
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('card-detected', cardData);
        }
      },
      (error) => {
        console.error('[main] Card error:', error);
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('card-error', error.message || error);
        }
      }
    );

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
} else {
  console.log('Electron app not available, creating window directly');
  createWindow();
}

// IPC Handlers
if (ipcMain) {

  // Handle login success
  ipcMain.on('login-success', (event, userData) => {
    console.log('[main] User logged in:', userData.name);
  });

  // Handle logout
  ipcMain.on('logout', (event) => {
    console.log('[main] User logged out');
    // Reload to login screen
    if (mainWindow) {
      mainWindow.loadFile(path.join(__dirname, '../renderer/login.html'));
    }
  });

  // Set mode (READ or WRITE)
  ipcMain.handle('set-mode', async (event, mode) => {
    try {
      console.log('[main] Setting mode to:', mode);
      const result = setMode(mode);
      return result;
    } catch (error) {
      console.error('[main] Error setting mode:', error);
      throw error;
    }
  });

  // Get current mode
  ipcMain.handle('get-mode', async () => {
    try {
      return getMode();
    } catch (error) {
      throw error;
    }
  });

  // Cancel write operation
  ipcMain.handle('cancel-write', async () => {
    try {
      return cancelWrite();
    } catch (error) {
      throw error;
    }
  });

  // Sync handlers
  ipcMain.handle('sync-to-card', async (event, backendData) => {
    backendCache = backendData;
    const result = await performSmartSync(currentReader, existingCardData, backendData);
    return result;
  });

  ipcMain.handle('sync-to-backend', async (event, cardPolicies) => {
    try {
      return await syncCardToBackend(cardPolicies);
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle('compare-data', async (event, backendPolicies) => {
    try {
      return await compareCardAndBackendData(backendPolicies);
    } catch (error) {
      throw error;
    }
  });



} else {
  console.log('ipcMain not available, skipping IPC handlers');
}