import { ipcMain, powerMonitor, session } from 'electron'
import { setPtyHostBindings } from '../ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from '../host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { electronRuntimeBrowserCommandsFactory } from '../host/electron-browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { electronHttpClient } from '../host/electron-http-client'
import { setMainHttpClient } from '../network/http-client'
import { electronSpeechServiceFactories } from '../host/electron-speech-services'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { desktopWorktreeWatcherRemoval } from '../ipc/filesystem-watcher'
import { setDefaultProxySessionResolver } from '../network/proxy-settings'

export function installDesktopRuntimeSurface(): void {
  // Why at process level, not per-window: pty.ts registers against injected surfaces so
  // it can load without electron, and an Electron main process always has ipcMain —
  // whether a window exists is irrelevant. Installing this in attachMainWindowServices
  // meant `orca serve` registered its PTY handlers against no-ops before any window
  // attached, so a paired desktop owner never received them.
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  // Why also at process level: the runtime's notification, window-lookup and
  // tab-create-reply channel are desktop-only. A Node host installs none and the
  // runtime routes notifications to paired clients instead.
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  // Why here: constructing RuntimeBrowserCommands is what pulls the Chromium browser
  // cluster into the graph. The desktop installs it; a Node host installs none and every
  // browser RPC rejects, which capability filtering already tells clients about.
  setRuntimeBrowserCommandsFactory(electronRuntimeBrowserCommandsFactory)
  // Why here: proxy-settings only needed electron for `session.defaultSession`. The
  // desktop supplies it; a Node host has no Chromium proxy config to consult, so the
  // environment variables are the whole answer there.
  setDefaultProxySessionResolver(() => session.defaultSession)
  // Why here: integrations use Chromium's network stack on the desktop. A Node host
  // falls back to the platform default, which is a real behavioural difference (proxy
  // read from the environment, Node's user agent) rather than a transparent swap.
  setMainHttpClient(electronHttpClient)
  // Why here: constructing the speech services is what pulls Electron's streaming net
  // request in. A host without them rejects speech calls rather than pretending.
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
}
