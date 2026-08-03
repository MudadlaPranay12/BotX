import * as fs from 'fs';
import * as path from 'path';

export function loadEnvFile(extensionPath: string): void {
    const envPath = path.join(extensionPath, '.env');
    try {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {continue;}
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) {continue;}
            const key = trimmed.slice(0, eqIdx).trim();
            let value = trimmed.slice(eqIdx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && !process.env[key]) {
                process.env[key] = value;
            }
        }
    } catch {
        // .env file not found or unreadable
    }
}
