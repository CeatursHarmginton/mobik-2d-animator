/**
 * Standalone Electron entry for the interactive mascot demo.
 * Launched via `npm run demo` (electron dist/demo/demo-main.js). It does not
 * touch the real app main process (dist/main/main.js).
 * @module demo/demo-main
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';

function createWindow(): void {
    const win = new BrowserWindow({
        width: 820,
        height: 760,
        title: 'Mobik — Interactive Mascot Demo',
        backgroundColor: '#0b1016',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    void win.loadFile(path.join(__dirname, 'demo.html'));
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
