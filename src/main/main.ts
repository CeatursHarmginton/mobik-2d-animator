/**
 * Electron Main Process
 * @module main/main
 */

import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IPC_CHANNELS } from '../shared/constants';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'Mobik Animator',
        backgroundColor: '#1e1e1e',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false // Allow loading local files
        },
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Create menu
    createMenu();
}

function createMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Project',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => mainWindow?.webContents.send('menu-new-project')
                },
                {
                    label: 'Open Project',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => mainWindow?.webContents.send('menu-open-project')
                },
                { type: 'separator' },
                {
                    label: 'Load Frames Folder',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: () => mainWindow?.webContents.send('menu-load-frames')
                },
                {
                    label: 'Load Sprite Sheet',
                    accelerator: 'CmdOrCtrl+Shift+L',
                    click: () => mainWindow?.webContents.send('menu-load-sheet')
                },
                { type: 'separator' },
                {
                    label: 'Save Project',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => mainWindow?.webContents.send('menu-save-project')
                },
                {
                    label: 'Export Meta JSON',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => mainWindow?.webContents.send('menu-export')
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Reset Zoom',
                    accelerator: 'CmdOrCtrl+0',
                    click: () => mainWindow?.webContents.send('menu-reset-zoom')
                },
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+=',
                    click: () => mainWindow?.webContents.send('menu-zoom-in')
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => mainWindow?.webContents.send('menu-zoom-out')
                },
                { type: 'separator' },
                {
                    label: 'Toggle Onion Skin',
                    accelerator: 'O',
                    click: () => mainWindow?.webContents.send('menu-toggle-onion')
                },
                { type: 'separator' },
                { role: 'toggleDevTools' },
                { role: 'reload' }
            ]
        },
        {
            label: 'Animation',
            submenu: [
                {
                    label: 'Play / Pause',
                    accelerator: 'Space',
                    click: () => mainWindow?.webContents.send('menu-play-pause')
                },
                {
                    label: 'Previous Frame',
                    accelerator: 'Left',
                    click: () => mainWindow?.webContents.send('menu-prev-frame')
                },
                {
                    label: 'Next Frame',
                    accelerator: 'Right',
                    click: () => mainWindow?.webContents.send('menu-next-frame')
                },
                { type: 'separator' },
                {
                    label: 'First Frame',
                    accelerator: 'Home',
                    click: () => mainWindow?.webContents.send('menu-first-frame')
                },
                {
                    label: 'Last Frame',
                    accelerator: 'End',
                    click: () => mainWindow?.webContents.send('menu-last-frame')
                }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About Mobik Animator',
                    click: () => {
                        dialog.showMessageBox(mainWindow!, {
                            type: 'info',
                            title: 'About',
                            message: 'Mobik Animator',
                            detail: 'Professional 2D Animation Editor\nVersion 1.0.0'
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// IPC Handlers
ipcMain.handle(IPC_CHANNELS.READ_DIRECTORY, async (_, dirPath: string) => {
    try {
        const files = await fs.promises.readdir(dirPath);
        return files;
    } catch (error) {
        throw new Error(`Failed to read directory: ${dirPath}`);
    }
});

ipcMain.handle(IPC_CHANNELS.OPEN_FILE_DIALOG, async (_, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(mainWindow!, options);
    return result;
});

ipcMain.handle(IPC_CHANNELS.OPEN_FOLDER_DIALOG, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Frames Folder'
    });
    return result;
});

ipcMain.handle(IPC_CHANNELS.SAVE_FILE_DIALOG, async (_, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(mainWindow!, options);
    return result;
});

ipcMain.handle(IPC_CHANNELS.READ_FILE, async (_, filePath: string) => {
    return fs.promises.readFile(filePath, 'utf-8');
});

ipcMain.handle(IPC_CHANNELS.WRITE_FILE, async (_, options: { filePath: string, data: string, encoding?: string } | string, content?: string) => {
    // Support both old and new API
    if (typeof options === 'string') {
        // Old API: (filePath, content)
        await fs.promises.writeFile(options, content || '', 'utf-8');
    } else {
        // New API: ({ filePath, data, encoding })
        if (options.encoding === 'base64') {
            const buffer = Buffer.from(options.data, 'base64');
            await fs.promises.writeFile(options.filePath, buffer);
        } else {
            await fs.promises.writeFile(options.filePath, options.data, 'utf-8');
        }
    }
    return true;
});

ipcMain.handle(IPC_CHANNELS.GET_APP_PATH, () => {
    return app.getAppPath();
});

// App lifecycle
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
