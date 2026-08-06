# 🤖 BotX — AI-Powered Developer Companion & Pair Programmer

**BotX** is an autonomous, dual-process desktop avatar and VS Code extension designed to provide real-time code analysis, AST-based diagnostic explanations, progressive intervention, and proactive developer support.

Unlike reactive chat interfaces, BotX operates as a background **Proactive Agentic System**. It continuously senses your workspace, predicts bugs before compilation, resolves merge conflicts, and offers single-click quick-fixes directly beside your line of work.

---

## 🏗️ Project Architecture

BotX is structured as a monorepo divided into two primary runtimes communicating via WebSocket on `ws://localhost:8055`:

DigitalCompanion/├── robot-brain/     # VS Code Extension Host (Sensors, ACES Engine, AST Parser, Gemini AI)├── robot-body/      # Electron Desktop App (Interactive Avatar UI & Speech Bubbles)└── package.json     # Workspace management scripts
┌──────────────────────────────────────────────────────────────────────────────┐│                      robot-brain  (VS Code Extension Host)                   ││                                                                              ││  SENSORS  ──►  EVENT FILTER  ──►  PERCEPTION  ──►  CONTEXT  ──►  AI/GEMINI   ││  (13)         (queue+dedupe)     (guard clause)    (AST deps)    (explanation) ││                                                                              ││  DECISION  ──►  BEHAVIOUR/FSM  ──►  MOTION PLANNER ──►  MOTION CONTROLLER    ││  (cooldown)   (progressive        (animation queue)  (executor)              ││                intervention)                                                 ││                                                                              ││  UI LAYER: BotXCodeActionProvider + CodeFixRegistry (isPreferred QuickFix)   ││            EnvSetupCodeActionProvider · GitConflictCodeActionProvider        ││                                                                              ││  COMMS: WebSocket Server (port 8055, 30s heartbeat)                          │└──────────────────────────────────────────────────────────────────────────────┘│WebSocket State Feed▼┌──────────────────────────────────────────────────────────────────────────────┐│                        robot-body  (Electron Overlay)                        ││  BrowserWindow: 360x180, transparent, frameless, alwaysOnTop                  ││  Expressions : IDLE · THINKING · HAPPY · CONFUSED · HELPFUL · ALERT          ││  Renderer    : Mouth-morph tweening, eye accents, SVG avatar, typing caret   │└──────────────────────────────────────────────────────────────────────────────┘
---

## ⚡ Key Features & Capabilities

### 🧠 ACES 4-Agent Cognitive Engine
* **Perception Agent:** Aggregates, debounces (1.5s), and batches diagnostic, cursor, file save, and workspace events.
* **Context Agent:** Resolves AST import trees, line surrounds, and cross-file interfaces for precision AI prompting.
* **Explanation Agent:** Powered by Gemini (`gemini-2.0-flash`) for multi-error batch analysis and undoable fix generation.
* **Decision Agent:** Cooldown-gated rule evaluator preventing intrusive popups.

### 🔄 Progressive Intervention FSM
* **Phase 1 (Silent Analysis):** Detects background errors and switches avatar state to `THINKING` silently without interrupting your typing flow.
* **Phase 2 (Proactive Guidance):** Broadcasts real-time facial expressions and speech-bubble summaries to the desktop overlay when you hit a roadblock.
* **Phase 3 (Preferred QuickFix):** Injects top-priority `🤖 Fix with BotX` (`Ctrl + .`) lightbulb actions into VS Code for safe, undoable (`Ctrl + Z`) edits via `WorkspaceEdit`.

### 🛡️ Core Feature Modules
* 🛡️ **Workspace Environment Guardian:** Inspects `.env` vs template keys, uninstalled packages (`node_modules`/`venv`), and dev ports on startup, providing 1-click `.env` generation.
* 🔀 **Intent-Aware Git Merge Conflict Resolver:** Intercepts `<<<<<<<` conflict markers, analyzes branch intents with Gemini, and synthesizes clean, merged code blocks.
* ⚡ **Library Deprecation & API Shield:** Real-time AST parsing for TypeScript, Python, Go, and Java against deprecation rule manifests to offer instant modernizations.
* 🎯 **Stuck-State Detection:** Automatically senses developer fatigue (e.g., saving the same file $\ge 3$ times in 30 seconds or high idle focus) to offer timely assistance.

---

## 🛠️ Getting Started

### Prerequisites

* [Node.js](https://nodejs.org/) (v18 or higher)
* [VS Code](https://code.visualstudio.com/)
* A Gemini API key

### Installation

1. Clone the repository:
   ```bash
   git clone [https://github.com/MudadlaPranay12/BotX.git](https://github.com/MudadlaPranay12/BotX.git)
   cd BotX
Install dependencies for all workspaces:Bashnpm install
Configure environment variables:Create a .env file inside robot-brain/:Code snippetGEMINI_API_KEY=your_gemini_api_key_here
Building & Running BotXCompile the VS Code Extension (robot-brain):Bashcd robot-brain
npm run compile
Launch the Desktop Overlay (robot-body):Bashcd ../robot-body
npm start
Debug Extension: Press F5 inside VS Code from robot-brain/ to launch the Extension Development Host.🛣️ Roadmap[x] Monorepo architecture & dual-process WebSocket bridge (ws://localhost:8055)[x] ACES 4-Agent Telemetry & Perception Pipeline (13 Workspace Sensors)[x] Progressive Intervention FSM (Silent $\rightarrow$ Speech Bubble $\rightarrow$ Preferred QuickFix)[x] Workspace Environment & Setup Guardian[x] Intent-Aware Git Merge Conflict Resolver[x] Library Deprecation & API Shield[ ] Live Terminal Autopilot & Command Guard (Build crash & CLI error interception)[ ] Proactive Regression & Unit Test Generator[ ] Multi-File Cross-Module Refactor Engine📄 LicenseThis project is licensed under the MIT License.
