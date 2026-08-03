import { WebSocketServer, WebSocket } from 'ws';
import { Logger } from './logger';
import type { RobotCommand, WindowAnchorPayload } from '../core/types';

const clients: Set<WebSocket> = new Set();
const messageQueue: string[] = [];
const MAX_QUEUE_SIZE = 500;
let server: WebSocketServer | null = null;
let messageCallback: ((data: Record<string, unknown>) => void) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const HEARTBEAT_INTERVAL_MS = 30000;
const ACTION_COOLDOWN_MS = 3000;
let lastActionTime = 0;

function flushQueue(): void {
    if (messageQueue.length === 0) {return;}
    const batch = messageQueue.splice(0, messageQueue.length);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            for (const msg of batch) {
                try {
                    client.send(msg);
                } catch (err) {
                    Logger.info("WEBSOCKET", { Event: "Queue flush send failed", Error: String(err) });
                    clients.delete(client);
                }
            }
        }
    }
}

function attemptStart(port: number, maxAttempts: number, attempt: number): void {
    if (attempt >= maxAttempts) {
        Logger.info('WEBSOCKET', { Event: 'All port fallback attempts exhausted' });
        console.log(`[COMMUNICATION] WebSocket Server failed to bind after ${maxAttempts} attempts.`);
        return;
    }

    server = new WebSocketServer({ port });

    server.on('connection', (ws) => {
        clients.add(ws);
        (ws as any).isAlive = true;
        Logger.info('WEBSOCKET', { Event: 'Client connected', Total: String(clients.size) });

        const connectMsg = JSON.stringify({ type: "CONNECTION_STATUS", status: "CONNECTED" });
        try {
            ws.send(connectMsg);
        } catch (err) {
            Logger.info("WEBSOCKET", { Event: "Failed to send CONNECTION_STATUS", Error: String(err) });
        }

        flushQueue();

        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString()) as Record<string, unknown>;
                if (messageCallback) {
                    messageCallback(data);
                }
            } catch {
                Logger.info('WEBSOCKET', { Event: 'Invalid message received' });
            }
        });

        ws.on('pong', () => {
            (ws as any).isAlive = true;
        });

        ws.on('close', () => {
            clients.delete(ws);
            Logger.info('WEBSOCKET', { Event: 'Client disconnected', Total: String(clients.size) });
        });

        ws.on('error', (err) => {
            Logger.info('WEBSOCKET', { Event: 'Client error', Error: String(err) });
            clients.delete(ws);
        });
    });

    server.on('listening', () => {
        Logger.info('WEBSOCKET', { Event: 'Server started', Port: String(port) });
        console.log(`[COMMUNICATION] WebSocket Server running on port ${port}.`);
        heartbeatTimer = setInterval(() => {
            for (const client of clients) {
                if ((client as any).isAlive === false) {
                    clients.delete(client);
                    client.terminate();
                    Logger.info('WEBSOCKET', { Event: 'Client terminated (no pong)' });
                    continue;
                }
                (client as any).isAlive = false;
                client.ping();
            }
        }, HEARTBEAT_INTERVAL_MS);
    });

    server.on('error', (err) => {
        Logger.info('WEBSOCKET', { Event: 'Server error', Error: String(err) });
        console.log(`[COMMUNICATION] WebSocket Server error on port ${port}: ${err.message}`);
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
            console.log(`[COMMUNICATION] Port ${port} is already in use, trying port ${port + 1}...`);
            server = null;
            setTimeout(() => attemptStart(port + 1, maxAttempts, attempt + 1), 2000);
        }
    });
}

export function startRobotServer(port: number): void {
    attemptStart(port, 3, 0);
}

export function onRobotMessage(callback: (data: Record<string, unknown>) => void): void {
    messageCallback = callback;
}

type CursorMovePayload = { type: "CURSOR_MOVE"; relativeX: number; relativeY: number };
type ActionPayload = { type: "ACTION"; animation?: string; speech?: string };
type EditorChangedPayload = { type: "EDITOR_CHANGED" };
type UserDismissPayload = { type: "USER_DISMISS" };
type RobotStatePayload = RobotCommand;
type WindowAnchorPayloadType = WindowAnchorPayload;
type WindowVisibilityPayload = { type: "WINDOW_VISIBILITY"; visible: boolean };
type RobotPayload = CursorMovePayload | ActionPayload | EditorChangedPayload | UserDismissPayload | RobotStatePayload | WindowAnchorPayloadType | WindowVisibilityPayload;

export function sendToRobot(payload: RobotPayload): void {
    if (payload.type === 'ACTION') {
        const now = Date.now();
        if (now - lastActionTime < ACTION_COOLDOWN_MS) {
            Logger.info("WEBSOCKET", { Event: "ACTION rate-limited", CooldownMs: String(ACTION_COOLDOWN_MS - (now - lastActionTime)) });
            return;
        }
        lastActionTime = now;
    }

    const message = JSON.stringify(payload);
    if (clients.size === 0) {
        if (messageQueue.length >= MAX_QUEUE_SIZE) {
            messageQueue.shift();
        }
        messageQueue.push(message);
        Logger.info("WEBSOCKET", { Event: "No clients, queued message", Type: payload.type, QueueSize: String(messageQueue.length) });
        return;
    }
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (err) {
                Logger.info("WEBSOCKET", {
                    Event: "Send failed",
                    Error: String(err)
                });
                clients.delete(client);
            }
        }
    }
}

export function stopRobotServer(): void {
    messageCallback = null;
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (server) {
        for (const client of clients) {
            client.close();
        }
        clients.clear();
        server.close();
        server = null;
        Logger.info('WEBSOCKET', { Event: 'Server stopped' });
    }
}
