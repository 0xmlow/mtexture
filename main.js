const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const testIdx = process.argv.indexOf('--test');
const TEST = testIdx !== -1;
const batchIdx = process.argv.indexOf('--batch');
const BATCH = batchIdx !== -1;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0D0D0D',
    title: '~M.Texture~',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  if (BATCH) {
    // one process, many wraps — spawning Electron per asset costs more in startup
    // than the work itself once you are past a few dozen
    const jobFile = process.argv[batchIdx + 1];
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('batch-load', { jobFile });
    });
    ipcMain.on('batch-progress', (e, line) => console.log(line));
    ipcMain.on('batch-done', (e, summary) => {
      console.log('BATCH_DONE ' + summary);
      app.exit(0);
    });
    ipcMain.on('batch-error', (e, msg) => {
      console.error('BATCH_FAIL ' + msg);
      app.exit(1);
    });
  }

  if (TEST) {
    const [modelPath, artPath, mode, treatment] = process.argv.slice(testIdx + 1).filter(a => !a.startsWith('-'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('test-load', { modelPath, artPath, mode, treatment });
    });
    ipcMain.on('test-done', async (e, outPath) => {
      await new Promise(r => setTimeout(r, 1200));
      const img = await win.webContents.capturePage();
      const shot = process.env.MTEXTURE_SHOT || path.join(app.getPath('temp'), 'mtexture-test.png');
      fs.writeFileSync(shot, img.toPNG());
      console.log('TEST_OK ' + outPath);
      console.log('SHOT ' + shot);
      app.exit(0);
    });
    ipcMain.on('test-error', (e, msg) => {
      console.error('TEST_FAIL ' + msg);
      app.exit(1);
    });
  }
}

ipcMain.on('reveal', (e, p) => shell.showItemInFolder(p));

ipcMain.handle('pick', async (e, kind) => {
  const filters = kind === 'model'
    ? [{ name: '3D models', extensions: ['glb', 'gltf', 'fbx'] }]
    : [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'] }];
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: kind === 'model' ? 'Choose a 3D model' : 'Choose your art',
    properties: ['openFile'],
    filters,
  });
  return canceled ? null : filePaths[0];
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
