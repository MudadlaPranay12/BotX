# 🤖 BotX — AI-Powered Developer Companion & Pair Programmer

BotX is an **autonomous AI-powered desktop companion** and **VS Code extension** that proactively assists developers while they code.

Unlike traditional AI assistants that wait for prompts, BotX continuously observes your development environment, understands project context, predicts issues before compilation, explains diagnostics, and provides **one-click Quick Fixes** directly inside VS Code.

The system combines an intelligent VS Code extension (**robot-brain**) with an interactive Electron desktop avatar (**robot-body**) connected through a real-time WebSocket communication layer.

---

# ✨ Features

* 🧠 Autonomous multi-agent cognitive architecture (ACES Engine)
* ⚡ Real-time diagnostic analysis
* 🔍 AST-aware contextual code understanding
* 💬 Interactive desktop avatar with live expressions
* 🛠️ One-click AI Quick Fixes
* 🔀 Intelligent Git merge conflict resolution
* 🛡️ Workspace environment validation
* 📦 Package and dependency inspection
* 🚀 Progressive developer assistance without interrupting workflow
* 🔄 Undo-safe code modifications using VS Code WorkspaceEdit

---

# 🏗️ Architecture

```
DigitalCompanion/
│
├── robot-brain/        # VS Code Extension Host
│   ├── Sensors
│   ├── ACES Engine
│   ├── AST Parser
│   ├── Gemini Integration
│   ├── Code Actions
│   └── WebSocket Server
│
├── robot-body/         # Electron Desktop Companion
│   ├── Avatar UI
│   ├── Speech Bubbles
│   ├── Expressions
│   └── Animation Engine
│
└── package.json
```

### Runtime Communication

```
                VS Code Extension
                (robot-brain)

 Sensors
     │
     ▼
Event Processing
     │
     ▼
Perception Agent
     │
     ▼
Context Builder
     │
     ▼
Gemini AI
     │
     ▼
Decision Engine
     │
     ▼
Behavior FSM
     │
     ▼
Motion Planner
     │
     ▼
WebSocket Server
          │
          │ ws://localhost:8055
          ▼
Electron Desktop Companion
        (robot-body)
```

---

# 🧠 ACES Cognitive Engine

BotX follows a four-agent cognitive architecture.

## 🔹 Perception Agent

Continuously monitors the developer workspace by collecting and batching events such as:

* Diagnostics
* Cursor movement
* File saves
* Workspace changes

The perception pipeline automatically debounces events (1.5s) to avoid unnecessary processing.

---

## 🔹 Context Agent

Builds rich contextual information before invoking AI.

Capabilities include:

* AST parsing
* Import dependency resolution
* Cross-file interface tracking
* Local code context extraction
* Surrounding line analysis

This dramatically improves prompt quality for AI reasoning.

---

## 🔹 Explanation Agent

Powered by **Gemini 2.0 Flash**, the Explanation Agent:

* Explains compiler errors
* Groups related diagnostics
* Generates intelligent fixes
* Produces undo-safe WorkspaceEdits
* Creates concise developer-friendly explanations

---

## 🔹 Decision Agent

Prevents BotX from becoming intrusive.

Responsibilities include:

* Cooldown management
* Rule evaluation
* Intervention scheduling
* Notification prioritization

---

# 🔄 Progressive Intervention System

Instead of interrupting developers immediately, BotX follows a three-stage intervention pipeline.

## Phase 1 — Silent Analysis

* Detects problems in the background
* Switches avatar into **Thinking** mode
* Does not interrupt typing

---

## Phase 2 — Proactive Guidance

When repeated issues are detected:

* Displays desktop speech bubbles
* Changes avatar expressions
* Summarizes detected problems
* Suggests possible solutions

---

## Phase 3 — Preferred Quick Fix

Injects an AI-powered **🤖 Fix with BotX** action into VS Code.

Features include:

* Highest priority Code Action
* Ctrl + . integration
* Undo support (Ctrl + Z)
* WorkspaceEdit based modifications

---

# 🛡️ Core Modules

## 🛡️ Workspace Environment Guardian

Automatically validates the development environment by checking:

* Missing `.env` variables
* `.env.template` consistency
* Missing packages
* `node_modules`
* Python virtual environments
* Occupied development ports

Provides one-click environment generation whenever possible.

---

## 🔀 Intent-Aware Git Merge Conflict Resolver

BotX understands both sides of a merge conflict.

Instead of simply choosing "Current" or "Incoming", it:

* Detects conflict markers
* Analyzes branch intent
* Uses Gemini reasoning
* Produces a clean merged implementation

---

## ⚡ Library Deprecation & API Shield

Continuously scans projects for deprecated APIs using AST parsing.

Supported languages:

* TypeScript
* JavaScript
* Python
* Java
* Go

Provides modern replacements through Quick Fixes.

---

## 🎯 Stuck-State Detection

BotX detects when a developer may need assistance.

Examples include:

* Saving the same file multiple times in a short period
* Repeated compiler failures
* Extended idle focus on the same error
* Repetitive editing behavior

The assistant then proactively offers help.

---

# 🛠️ Getting Started

## Prerequisites

* Node.js 18+
* Visual Studio Code
* Gemini API Key

---

## Installation

Clone the repository.

```bash
git clone https://github.com/MudadlaPranay12/BotX.git

cd BotX
```

Install all workspace dependencies.

```bash
npm install
```

Create a `.env` file inside `robot-brain`.

```env
GEMINI_API_KEY=your_api_key_here
```

---

## Running BotX

### 1. Compile the VS Code Extension

```bash
cd robot-brain

npm run compile
```

### 2. Start the Desktop Companion

```bash
cd ../robot-body

npm start
```

### 3. Launch Extension Development Host

Press **F5** from the `robot-brain` workspace inside VS Code.

---

# 🗺️ Roadmap

## Completed

* ✅ Monorepo architecture
* ✅ Dual-process WebSocket communication
* ✅ ACES 4-Agent Cognitive Engine
* ✅ 13 Workspace Sensors
* ✅ Progressive Intervention FSM
* ✅ Workspace Environment Guardian
* ✅ Intent-Aware Merge Conflict Resolver
* ✅ Library Deprecation & API Shield

## In Progress

* ⏳ Live Terminal Autopilot
* ⏳ Command Guard
* ⏳ Build Error Interception

## Planned

* 🔲 Proactive Unit Test Generation
* 🔲 Regression Test Generation
* 🔲 Multi-File Cross-Module Refactoring
* 🔲 Autonomous Code Review Engine

---

# 💡 Tech Stack

**Frontend**

* Electron
* HTML
* CSS
* TypeScript

**Backend**

* Node.js
* VS Code Extension API
* WebSocket

**AI**

* Gemini 2.0 Flash

**Parsing**

* AST Analysis

**Architecture**

* Multi-Agent System
* Finite State Machine (FSM)
* Event-Driven Pipeline

---

# 📄 License

Licensed under the **MIT License**.

---

> **BotX aims to redefine developer productivity by combining proactive AI reasoning, contextual understanding, and real-time workspace awareness into a seamless coding companion.**
