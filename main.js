const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'icons/tally.png')
  });

  win.loadFile('index.html');

  // Open DevTools if needed during development
  // win.webContents.openDevTools();
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

// IPC handlers for data persistence
const DATA_PATH = path.join(app.getPath('userData'), 'accounting_data.json');

ipcMain.handle('save-data', async (event, data) => {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('load-data', async () => {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const data = fs.readFileSync(DATA_PATH, 'utf-8');
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('export-file', async (event, { content, fileName, type }) => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: fileName,
    filters: [{ name: type, extensions: [type.toLowerCase()] }]
  });

  if (filePath) {
    fs.writeFileSync(filePath, content);
    return { success: true, filePath };
  }
  return { success: false };
});
