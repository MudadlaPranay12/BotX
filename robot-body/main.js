const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let mainWindow;
const WIN_WIDTH = 360;
const WIN_HEIGHT = 180;

function clampPosition(x, y) {
  const displays = screen.getAllDisplays();
  let bounds = displays[0].workArea;
  for (const d of displays) {
    const db = d.workArea;
    if (x >= db.x && x < db.x + db.width && y >= db.y && y < db.y + db.height) {
      bounds = db;
      break;
    }
  }
  const clampedX = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - WIN_WIDTH));
  const clampedY = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - WIN_HEIGHT));
  return { x: clampedX, y: clampedY };
}

app.whenReady().then(() => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: screenWidth - WIN_WIDTH - 20,
    y: screenHeight - WIN_HEIGHT - 20,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.on('set-position', (_event, targetX, targetY) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const pos = clampPosition(targetX, targetY);
      mainWindow.setPosition(pos.x, pos.y);
    }
  });

  ipcMain.on('brain-event', (_event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('brain-event', data);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
