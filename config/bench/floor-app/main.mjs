// Minimal Electron/Chromium memory floor: one empty BrowserWindow, no Orca runtime.
// Electron honors --remote-debugging-port automatically; do not disable it here.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow() {
  new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  }).loadFile(join(import.meta.dirname, 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('window-all-closed', () => app.quit())
})
