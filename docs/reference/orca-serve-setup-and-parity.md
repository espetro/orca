# Orca Browser-as-Shell: Setup, Runner & Feature Parity Report

## Overview

Orca supports a **Dual-Shell** architecture:

1. **Desktop Shell**: The full Electron desktop application.
2. **Browser-as-Shell (`orca serve`)**: A lightweight headless Node runtime (`orcad`) serving the web client over HTTP and WebSocket RPC directly into any web browser.

This document details the build setup, background daemon usage via `orca-serve`, and a comprehensive feature parity breakdown comparing the browser web app to the native Electron desktop app.

---

## 1. Built Artifacts & Runner Setup

### Artifacts

- **Node Runtime Daemon (`orcad`)**: `out/orcad/orcad.js` (5.6 MB bundle, zero Electron overhead, native PTY daemon integration).
- **Web App Client**: `out/web/` (compiled Vite/React bundle serving `web-index.html` and assets).
- **CLI Engine**: `out/cli/index.js` (standard CLI interface).

### Installed Runner Script

The runner script is installed at:

```
~/.local/bin/orca-serve
```

It is executable and accessible from your `$PATH`.

---

## 2. How to Run `orca-serve`

`orca-serve` includes native background daemonization and `nohup` handling, so you can start it, open the web app in your browser, and safely close the terminal tab immediately.

### Commands

```bash
# 1. Start as a background daemon & auto-open your default browser
orca-serve
# or explicitly:
orca-serve start

# 2. Check daemon status and pairing URL
orca-serve status

# 3. View live server logs
orca-serve logs

# 4. Stop the running server daemon
orca-serve stop
```

### Background Execution & Profile Isolation

- **Process Lifecycle**: When run with `orca-serve` (or `orca-serve start`), the server starts under `nohup`, writes its PID to `~/.orca/serve.pid`, and redirects stdout/stderr to `~/.orca/serve.log`.
- **Browser Auto-Open**: The runner monitors the log for the readiness line containing the pairing URL, prints it, and opens your default browser via `open "$url"`.
- **Terminal Independence**: Once the browser opens, control returns to your shell prompt. You can close the terminal tab without terminating the server.
- **Profile Isolation**: Uses `~/.orca/serve-profile` as its isolated `userData` path (`ORCA_USER_DATA_PATH_OVERRIDE`). Your browser workspaces, sessions, and settings persist across restarts, and they never collide with a running Electron GUI app.
- **Foreground Mode**: To run directly in the foreground for debugging:
  ```bash
  orca-serve --foreground
  ```

---

## 3. Feature Parity Breakdown

The web client runs via `src/renderer/src/web/web-preload-api.ts`, which provides 100% type and property parity (all 85 properties of `PreloadApi`) over WebSocket RPC.

### 100% Full Feature Parity

| Category                    | Capabilities                                                                                                                                                                                     |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Terminal & Multiplexing** | Full PTY allocation, interactive shell execution, terminal multiplexing, ANSI/xterm rendering, full resize/input events, daemon reattachment, terminal parking, scrollback history, split panes. |
| **Projects & Workspaces**   | Opening local projects, git repositories, folder workspaces, workspace switcher, project groups, recent workspaces, workspace creation, switching, settings.                                     |
| **Agent Orchestration**     | Full agent runtimes (Claude, Codex, OpenCode, MIMO, etc.), agent chat, tool invocation, prompt execution, task planning, subagents, streaming responses, diff review, tool approval workflows.   |
| **File System & Editor**    | File tree exploration, Monaco editor, reading/writing files, file watcher (`@parcel/watcher`), syntax highlighting, file search (ripgrep/fd), editor tabs, multi-editor splits.                  |
| **Git & Source Control**    | Full Git operations (branching, commits, diffs, status, merge conflicts, worktrees, stashing, remotes, git log graph, GitLab/GitHub integration).                                                |
| **Automations & Workflows** | Task execution, scheduled commands, shell script runs, recipes.                                                                                                                                  |
| **Markdown & Previews**     | Full markdown rendering, Mermaid diagrams, KaTeX math rendering, image preview.                                                                                                                  |
| **AI Vault & History**      | Session history, agent prompt history, persistence in SQLite / JSON storage, search.                                                                                                             |
| **Settings & Themes**       | Color themes, keyboard shortcut configurations, AI provider configurations (API keys, model selection), editor preferences.                                                                      |

---

### Differences & Browser Boundaries (Flagged)

Because the web client runs within the standard web browser sandbox rather than a native desktop window shell, the following features differ:

| Feature Area                          | Electron Desktop App                                                                                                | Browser Tab Client                                                                                                             | Notes / Workaround                                                                                             |
| :------------------------------------ | :------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| **OS Global Hotkeys**                 | Can intercept global system shortcuts (e.g., summon app from anywhere).                                             | Tab-only shortcuts. Cannot override browser-reserved keys like `Cmd+W` (close tab) or `Cmd+T`.                                 | Within the editor and terminal, standard editing shortcuts (`Cmd+C`, `Cmd+V`, `Cmd+F`, `Cmd+P`) work normally. |
| **Window Shell / Frameless Titlebar** | Native macOS traffic light window controls, Dock icon, menu bar menus.                                              | Rendered inside your browser's tabs and window.                                                                                | Fullscreen is activated via browser fullscreen (`F11` or View -> Enter Full Screen).                           |
| **OS Dialogs (`showOpenDialog`)**     | Native macOS Finder file picker dialogs (`NSOpenPanel`).                                                            | In-app workspace selector and file path inputs.                                                                                | You navigate directories directly through the UI file explorer / workspace switcher.                           |
| **Computer Use / Screen Capture**     | Native macOS Accessibility API helper (`Orca Computer Use.app`) can control the mouse and grab external OS windows. | **Degraded / Unavailable**. The browser sandbox cannot control external macOS applications or capture background desktop apps. | Agent terminal tasks, code editing, git work, and file operations remain fully functional.                     |
| **Local Speech STT / TTS (`speech`)** | Native Whisper/CoreAudio C++ bindings embedded in desktop runtime.                                                  | **Degraded stub**. Local native whisper binary is desktop-only.                                                                | Can be used if remote transcription or browser Web Speech API is enabled.                                      |
| **App Auto-Updater**                  | Native macOS `.dmg` / Squirrel updater restarts `Orca.app`.                                                         | Backend updater handles daemon restart; web interface updates instantly on browser page reload (`Cmd+R`).                      | No manual app installation needed.                                                                             |
