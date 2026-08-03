const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    sendCursorMove: (x, y) => {
        ipcRenderer.send('cursor-move', { x, y });
    },
    sendDragStart: () => {
        ipcRenderer.send('drag-start');
    },
    sendDragMove: (dx, dy) => {
        ipcRenderer.send('drag-move', { dx, dy });
    },
    sendDragEnd: () => {
        ipcRenderer.send('drag-end');
    },
    sendEditorChanged: () => {
        ipcRenderer.send('editor-changed');
    },
    setCompanionPosition: (targetX, targetY) => {
        ipcRenderer.send('set-companion-position', { targetX, targetY });
    },
    onToggleDrag: (callback) => {
        ipcRenderer.on('toggle-drag', (_event, data) => callback(data));
    },
    hideWindow: () => {
        ipcRenderer.send('hide-window');
    },
    showWindow: () => {
        ipcRenderer.send('show-window');
    }
});
