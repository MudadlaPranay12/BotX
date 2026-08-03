# 🤖 BotX — AI-Powered Developer Companion & Pair Programmer

**BotX** is an intelligent, dual-process desktop avatar and VS Code extension designed to provide real-time code analysis, AST-based diagnostic explanations, and adaptive developer support.

---

## 🏗️ Project Architecture

BotX is structured as a high-performance monorepo divided into two primary runtimes:
DigitalCompanion/
├── robot-brain/     # VS Code Extension (Sensors, AST Parsing, Gemini AI Engine)
├── robot-body/      # Electron Desktop App (Interactive Avatar UI & Speech Bubbles)
└── package.json     # Workspace management scripts


* **`robot-brain` (The Brain):** An 8-stage telemetry pipeline built into VS Code that monitors code diagnostics, cursor activity, breakpoint events, and git status. It processes code context using Google Gemini API.
* **`robot-body` (The Body):** A lightweight, transparent Electron desktop overlay that renders the interactive avatar, real-time speech bubbles, and animations.
* **IPC Bridge:** Real-time local WebSocket connection running on `ws://localhost:8055`.

---

## ⚡ Key Features

* **Real-time Diagnostic Sensors:** Monitors active editor errors and terminal output using an 8-stage event pipeline (Sensors → EventFilter → Perception → Context → Decision → Behaviour → Explanation → Motion).
* **AI Explanations:** Integrates Google's Gemini AI to analyze code context and suggest targeted fixes without hallucinating.
* **Adaptive Learning Profile:** Adjusts explanation depth based on developer skill tracking and workspace activity.
* **Interactive Desktop Avatar:** Displays dynamic emotional states (Idle, Thinking, Happy, Alert) triggered directly by coding events.

---

## 🛠️ Getting Started

### Prerequisites

* [Node.js](https://nodejs.org/) (v18 or higher)
* [VS Code](https://code.visualstudio.com/)
* A Gemini API key (placed in your local `.env` file)

### Installation

1. Clone the repository:
   ```bash
   git clone [https://github.com/MudadlaPranay12/BotX.git](https://github.com/MudadlaPranay12/BotX.git)
   cd BotX
Install dependencies for all workspaces:

Bash
npm install
Configure environment variables:
Create a .env file inside robot-brain/:

Code snippet
GEMINI_API_KEY=your_gemini_api_key_here
Running BotX
Start both the extension host and the desktop avatar concurrently:

Bash
npm run dev
🛣️ Roadmap
[x] Monorepo architecture & dual-process WebSocket bridge

[x] 8-Stage Telemetry & Perception Pipeline

[x] Dynamic 2D SVG Avatar UI with state-driven animation queue

[ ] Inline CodeAction (Lightbulb) auto-fixes with interactive diff previews

[ ] Deep AST parsing for full-workspace structural context

[ ] 3D Robot Avatar integration (WebGL/Spline/Rive)

📄 License
This project is licensed under the MIT License.