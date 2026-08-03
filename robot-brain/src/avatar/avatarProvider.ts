import * as vscode from "vscode";

export class AvatarProvider implements vscode.WebviewViewProvider {
    static readonly viewType = "botx-companion-view";

    private webviewView: vscode.WebviewView | undefined;
    private _pendingReveal = false;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage((message) => {
            if (message.type === "ready") {
            }
        });

        if (this._pendingReveal) {
            webviewView.show?.(true);
            this._pendingReveal = false;
        }
    }

    postMessage(message: Record<string, unknown>): void {
        if (this.webviewView) {
            this.webviewView.webview.postMessage(message);
        }
    }

    reveal(): void {
        if (this.webviewView) {
            this.webviewView.show?.(true);
        } else {
            this._pendingReveal = true;
            vscode.commands.executeCommand('workbench.action.focusView', AvatarProvider.viewType);
        }
    }

    private getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px 8px 8px;
    font-family: 'Segoe UI', -apple-system, sans-serif;
    overflow: hidden;
  }
  .robot {
    display: flex;
    flex-direction: column;
    align-items: center;
    animation: float 3s ease-in-out infinite;
  }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }
  .bubble {
    background: var(--bubble-bg, #1e1e2e);
    color: #cdd6f4;
    padding: 10px 14px;
    border-radius: 14px 14px 14px 4px;
    max-width: 180px;
    font-size: 12px;
    line-height: 1.5;
    margin-bottom: 12px;
    display: none;
    text-align: left;
    word-wrap: break-word;
    border: 1px solid #313244;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    position: relative;
    transition: background 0.4s;
  }
  .bubble::after {
    content: '';
    position: absolute;
    bottom: -8px;
    left: 20px;
    width: 12px;
    height: 12px;
    background: var(--bubble-bg, #1e1e2e);
    border-right: 1px solid #313244;
    border-bottom: 1px solid #313244;
    transform: rotate(45deg);
    border-radius: 0 0 4px 0;
    transition: background 0.4s;
  }
  .badge {
    margin-top: 10px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1.5px;
    color: var(--accent, #00f0ff);
    text-shadow: 0 0 6px var(--accent, #00f0ff);
    transition: color 0.4s, text-shadow 0.4s;
    animation: badgePulse 3s ease-in-out infinite;
  }
  @keyframes badgePulse {
    0%, 100% { opacity: 0.65; }
    50% { opacity: 1; }
  }
  @keyframes blink {
    0%, 42%, 58%, 100% { transform: scaleY(1); }
    45%, 55% { transform: scaleY(0.15); }
  }
  .eye { animation: blink 4s ease-in-out infinite; }
</style>
</head>
<body>
<div class="bubble" id="bubble"></div>
<div class="robot">
  <svg width="110" height="130" viewBox="0 0 110 130" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow">
        <feGaussianBlur stdDeviation="2.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <ellipse cx="55" cy="126" rx="28" ry="4" fill="#000" opacity="0.12"/>

    <ellipse cx="55" cy="30" rx="36" ry="26" fill="#ffffff"/>
    <ellipse cx="55" cy="30" rx="27" ry="18" fill="#0d1117"/>

    <rect x="38" y="24" width="10" height="7" rx="3.5" fill="var(--accent, #00f0ff)" filter="url(#glow)" class="eye"/>
    <rect x="62" y="24" width="10" height="7" rx="3.5" fill="var(--accent, #00f0ff)" filter="url(#glow)" class="eye"/>

    <path d="M48 37 Q55 40 62 37" stroke="var(--accent, #00f0ff)" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>

    <path d="M35 64 C35 55 75 55 75 64 L70 95 C70 101 40 101 40 95 Z" fill="#ffffff"/>

    <circle cx="55" cy="77" r="4" fill="var(--accent, #00f0ff)" filter="url(#glow)"/>

    <path d="M29 68 C22 75 22 87 27 91" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"/>
    <path d="M81 68 C88 75 88 87 83 91" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"/>
  </svg>
  <div class="badge" id="badge">CONNECTED</div>
</div>

<script>
  (function() {
    const vscode = acquireVsCodeApi();
    const badge = document.getElementById('badge');
    const bubble = document.getElementById('bubble');
    const style = document.documentElement.style;

    const COLORS    = { idle: '#00f0ff', error: '#ff4444', fix: '#00ff88' };
    const LABELS    = { idle: 'CONNECTED', error: 'ERROR', fix: 'FIXED' };
    const BUBBLE_BG = { idle: '#1e1e2e', error: '#2d1b1b', fix: '#1b2d1b' };

    let bubbleTimer = null;

    function setState(state, text) {
      const c = COLORS[state] || COLORS.idle;
      style.setProperty('--accent', c);
      badge.textContent = LABELS[state] || 'CONNECTED';
      if (text) showBubble(text, state);
    }

    function showBubble(text, state) {
      bubble.textContent = text;
      bubble.style.display = 'block';
      const bg = BUBBLE_BG[state] || BUBBLE_BG.idle;
      style.setProperty('--bubble-bg', bg);
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => { bubble.style.display = 'none'; }, 8000);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg) return;
      const t = (msg.type || '').toLowerCase();

      if (t === 'initialize') {
        setState('idle', 'Hi, ready to code!');
      } else if (t === 'error') {
        setState('error', msg.message || 'Error detected');
      } else if (t === 'fix') {
        setState('fix', msg.message || 'Issue resolved');
      } else if (t === 'expression') {
        const v = (msg.value || '').toLowerCase();
        if (v === 'sad' || v === 'worried' || v === 'shocked') setState('error', msg.message || null);
        else if (v === 'happy') setState('fix', msg.message || null);
        else setState('idle', msg.message || null);
      } else if (t === 'state' || t === 'status') {
        const s = (msg.value || '').toLowerCase();
        if (s === 'error') setState('error', msg.message || null);
        else if (s === 'fix' || s === 'fixed') setState('fix', msg.message || null);
        else setState('idle', msg.message || null);
      } else if (t === 'text' && msg.value) {
        showBubble(msg.value, 'idle');
      } else if (t === 'action') {
        const a = (msg.value || '').toLowerCase();
        if (a === 'alert_red') setState('error', msg.message || null);
        else if (a === 'happy' || a === 'jump') setState('fix', msg.message || null);
        else setState('idle', msg.message || null);
      }
    });

    vscode.postMessage({ type: 'ready' });
  })();
</script>
</body>
</html>`;
    }
}
