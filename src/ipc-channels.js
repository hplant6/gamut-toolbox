// Central IPC channel registry — the single source of truth for channel names,
// shared by main.js and the renderer so a typo can't silently break a channel
// (and so confusable pairs like pick-cancel / pick-cancelled are named, not retyped).
// Values are the exact original channel strings; do not change a value without
// updating both ends.
const IPC = Object.freeze({
  A11Y_CANCEL: 'a11y-cancel',
  A11Y_FLASH: 'a11y-flash',
  A11Y_PANEL_OPEN: 'a11y-panel-open',
  A11Y_SEND: 'a11y-send',
  PICK_DRIFT: 'pick-drift',
  DRIFT_PANEL_OPEN: 'drift-panel-open',
  DRIFT_FLASH: 'drift-flash',
  DRIFT_PREVIEW: 'drift-preview',
  DRIFT_SEND: 'drift-send',
  DRIFT_CANCEL: 'drift-cancel',
  PERF_REPORT_COLLECT: 'perf-report-collect',
  PERF_REPORT_OPEN: 'perf-report-open',
  PORTS_LIST: 'ports-list',
  PORTS_KILL: 'ports-kill',
  SERVER_START: 'server-start',       // start a project dev server (agent env)
  SERVER_KILL_PORT: 'server-kill-port',   // free a port we may not own (foreign/agent-started server)
  SERVER_STOP: 'server-stop',         // stop a running project server
  SERVER_RESTART: 'server-restart',   // stop + start
  SERVER_STATUS: 'server-status',     // probe a set of ports → running map
  SERVER_DETECT: 'server-detect',     // read a project's package.json scripts
  SERVER_LOG: 'server-log',           // captured stdout/stderr tail for a server
  SERVER_RAM: 'server-ram',           // per-server memory (RSS) by port
  CLUSTERS_LIST: 'clusters-list',     // running k3d clusters (ports, forwards, worktree) — see src/clusters.js
  PROJECT_CAPTURE: 'project-capture', // snapshot the browser pane → project preview
  PROJECT_PREVIEW: 'project-preview', // path to a project's cached preview image
  SESSIONS_LIST: 'sessions-list',
  ACP_CANCEL: 'acp-cancel',
  ACP_CLOSED: 'acp-closed',
  ACP_DONE: 'acp-done',
  ACP_ERROR: 'acp-error',
  ACP_INSTALL_PROGRESS: 'acp-install-progress',
  ACP_INSTALLING: 'acp-installing',
  ACP_KILL: 'acp-kill',
  ACP_MODE_CHANGED: 'acp-mode-changed',
  ACP_MODEL_CHANGED: 'acp-model-changed',
  ACP_SET_MODEL: 'acp-set-model',
  DIGGER_AVAILABLE: 'digger-available',
  DIGGER_HANDOFF_GET: 'digger-handoff-get',
  DIGGER_HANDOFF_SET: 'digger-handoff-set',
  ACP_PERMISSION_REQUEST: 'acp-permission-request',
  ACP_PERMISSION_RESPONSE: 'acp-permission-response',
  ACP_PERMISSION_RESOLVED: 'acp-permission-resolved',
  ACP_SET_MODE: 'acp-set-mode',
  ACP_PROMPT: 'acp-prompt',
  ACP_READY: 'acp-ready',
  ACP_SPAWN: 'acp-spawn',
  ACP_TERM_CREATE: 'acp-term-create',
  ACP_TERM_OUTPUT: 'acp-term-output',
  ACP_TERM_RELEASE: 'acp-term-release',
  ACP_TOOL_APPROVED: 'acp-tool-approved',
  ACP_UPDATE: 'acp-update',
  AGENT_MD_READ: 'agent-md-read',
  MOVE_PANEL_CANCEL: 'move-panel-cancel',
  MOVE_PANEL_CLOSED: 'move-panel-closed',   // page-side Escape closed the tool → renderer hides the panel
  MOVE_PANEL_HOVER: 'move-panel-hover',     // panel row hovered → highlight that arrow on the page
  MOVE_PANEL_OPEN: 'move-panel-open',
  MOVE_PANEL_REMOVE: 'move-panel-remove',
  MOVE_PANEL_SEND: 'move-panel-send',
  MOVE_PANEL_UPDATE: 'move-panel-update',   // live move list from the page (polled)
  SLIDERS_LIST: 'sliders-list',       // panel files for the active project (+ which match the page URL)
  SLIDERS_OPEN: 'sliders-open',       // load a panel: inject the page runtime, return the normalized panel
  SLIDERS_APPLY: 'sliders-apply',     // changed values → the page (one batch per animation frame)
  SLIDERS_CLOSE: 'sliders-close',     // unpin: restore defaults, drop the injected CSS properties + the in-page panel
  SLIDERS_SEND: 'sliders-send',       // changed values → a bake request in chat
  SLIDERS_PRESETS: 'sliders-presets', // write the presets map back into the panel file
  SLIDERS_SCAN: 'sliders-scan',       // page :root custom properties → a starter panel file
  SLIDERS_CHANGED: 'sliders-changed', // a panel file was added / changed / removed
  SLIDERS_LAYOUT: 'sliders-layout',   // in-page panel corner / transparency / collapsed
  SLIDERS_PAGE_CHANGES: 'sliders-page-changes', // values dragged on the in-page panel → the tool column
  SLIDERS_SUSPEND: 'sliders-suspend', // hide the pinned in-page panel while a selection tool is armed
  ANIM_PANEL_CANCEL: 'anim-panel-cancel',
  ANIM_PANEL_OPEN: 'anim-panel-open',
  ANIM_PANEL_PREVIEW: 'anim-panel-preview',
  ANIM_PANEL_SEND: 'anim-panel-send',
  AGENT_MD_WRITE: 'agent-md-write',
  APP_CHECK_UPDATES: 'app-check-updates',
  APP_INSTALL_UPDATE: 'app-install-update',
  APP_VERSION: 'app-version',
  RELEASE_NOTES: 'release-notes',   // What's New: bundled changelog entries between two versions
  APP_TOAST: 'app-toast',
  AUTH_STATUS_READ: 'auth-status-read',
  AUTH_STATUS_WRITE: 'auth-status-write',   // switch the live ~/.claude/.credentials.json to a saved account
  AUTH_ACCOUNT_INFO: 'auth-account-info',   // `claude auth status --json` — the only source of the live account's email/org
  AUTH_TOKEN_CHECK: 'auth-token-check',     // does the live token still work? (a network probe, unlike auth status)
  AUTH_LOGIN_START: 'auth-login-start',     // drive `claude auth login` from the modal instead of a terminal tab
  AUTH_LOGIN_CODE: 'auth-login-code',       // paste the authorization code back into the waiting login process
  AUTH_LOGIN_CANCEL: 'auth-login-cancel',
  AUTH_LOGIN_OPEN: 'auth-login-open',       // open the pending authorize URL host-side (WSL can't reach the browser)
  AUTH_LOGIN_EVENT: 'auth-login-event',     // main → renderer: { phase, url, message }
  BROWSER_BACK: 'browser-back',         // step back through the browser view's own history
  BROWSER_NAV_STATE: 'browser-nav-state',   // main → renderer: { canGoBack } so the Back button can disable itself
  BROWSER_DID_NAVIGATE: 'browser-did-navigate',
  BROWSER_NAVIGATE: 'browser-navigate',
  BROWSER_RELOAD: 'browser-reload',
  BROWSER_TOGGLE_DEVTOOLS: 'browser-toggle-devtools',
  BROWSER_URL_CHANGED: 'browser-url-changed',
  BROWSER_LOADING: 'browser-loading',   // 'loading' | 'done' | 'error' for the address-bar indicator
  BROWSER_HISTORY: 'browser-history',         // visited-URL history for address-bar suggestions
  LOCALHOST_SERVERS: 'localhost-servers',     // running localhost dev servers (for address-bar autocomplete)
  BROWSER_SUGGEST_SPACE: 'browser-suggest-space',   // nudge the browser view down so the suggestions dropdown isn't hidden
  MANIFEST_READ:  'manifest-read',    // read <dir>/.cathode/manifest.json (project source of truth)
  MANIFEST_WRITE: 'manifest-write',   // write-through a project into its folder manifest
  RESOLVE_SERVER_DIRS: 'resolve-server-dirs',   // resolve cwd + launch cmd of the process on each port (attribute running servers to a project by folder)
  DIR_INFO: 'dir-info',               // project-ish signals for a folder (git/pkg/branch/remote/name)
  PROJECT_WORK: 'project-work',       // main → renderer: what this project is currently working on (branch / PR title)
  PROJECT_TRIGGER: 'project-trigger', // main → renderer: a new-work signal (new branch / cloned repo) that may warrant a project
  PROJECT_EXPORT: 'project-export',            // write a portable .cathode bundle for a project
  PROJECT_IMPORT_PICK: 'project-import-pick',  // open + parse a .cathode bundle
  PROJECT_IMPORT_APPLY: 'project-import-apply',// clone-from-remote / scaffold a bundle into a folder
  PROJECT_IMPORT_READ: 'project-import-read',  // parse a .cathode bundle from a given path (file-association open)
  OPEN_BUNDLE_FILE: 'open-bundle-file',        // main → renderer: a .cathode file was opened via the OS (double-click)
  PROJECT_CREATE: 'project-create',            // create a brand-new project folder (mkdir + git init + manifest)
  CHECK_CLAUDE_AUTH: 'check-claude-auth',
  CHECK_MODEL: 'check-model',
  CHECK_WSL: 'check-wsl',
  CLIPBOARD_READ: 'clipboard-read',
  CLOSE_INLINE_POPUP: 'close-inline-popup',
  CODE_LIST: 'code-list',
  CODE_POLL: 'code-poll',
  CODE_READ: 'code-read',
  CONSOLE_CLEAR: 'console-clear',
  CONSOLE_ENTRY: 'console-entry',
  CONSOLE_GET: 'console-get',
  CP_CLEAR_TARGET_HIGHLIGHT: 'cp-clear-target-highlight',
  CP_HIGHLIGHT_TARGET: 'cp-highlight-target',
  DESTROY_CUSTOM_VIEW: 'destroy-custom-view',
  DEVICE_CHANGED: 'device-changed',
  DEVICE_RESIZE_END: 'device-resize-end',
  DEVICE_RESIZE_START: 'device-resize-start',
  DEVICE_VIEW_BOUNDS: 'device-view-bounds',
  DEVTOOLS_CLOSED: 'devtools-closed',
  DEVTOOLS_LAYOUT: 'devtools-layout',
  DEVTOOLS_OPENED: 'devtools-opened',
  DIFF_FILE: 'diff-file',
  DIFF_STATUS: 'diff-status',
  DRAW_CANCEL: 'draw-cancel',
  DRAW_COMPOSITE: 'draw-composite',
  DRAW_COMPOSITE_DONE: 'draw-composite-done',
  DRAW_PANEL_OPEN: 'draw-panel-open',
  EXTRACT_PANEL_CANCEL: 'extract-panel-cancel',
  EXTRACT_PANEL_HIGHLIGHT: 'extract-panel-highlight',
  EXTRACT_PANEL_OPEN: 'extract-panel-open',
  EXTRACT_PANEL_SEND: 'extract-panel-send',
  EYEDROPPER_CANCEL: 'eyedropper-cancel',
  EYEDROPPER_PANEL_OPEN: 'eyedropper-panel-open',
  EYEDROPPER_SEND: 'eyedropper-send',
  EYEDROPPER_SET_COLOR: 'eyedropper-set-color',
  EYEDROPPER_SET_PROP: 'eyedropper-set-prop',
  GET_PROJECT_DIR: 'get-project-dir',
  CHECK_PROJECT_FILE: 'check-project-file',   // does <active project cwd>/<name> exist? (handoff brief wait)
  GET_RATE_LIMITS: 'get-rate-limits',
  GET_USAGE: 'get-usage',
  GET_NOUS_CREDITS: 'get-nous-credits',
  PICK_PANEL_DROP_SEL: 'pick-panel-drop-sel',   // Box/Lasso: a selection chip was removed → drop that pick's outline   // Hermes: Nous Portal credit balance (read through Hermes' own auth)
  LOCAL_MODELS: 'local-models',               // model tags pulled locally (Ollama)
  MARKER_CANCEL: 'marker-cancel',
  MARKER_CLEAR: 'marker-clear',
  MARKER_SEND: 'marker-send',
  MARKER_SET_COLOR: 'marker-set-color',
  MARKER_SET_SIZE: 'marker-set-size',
  MCP_CONNECT: 'mcp-connect',
  MCP_DISCONNECT: 'mcp-disconnect',
  MCP_HAS_SERVER: 'mcp-has-server',
  MCP_STATUS: 'mcp-status',
  MODAL_OVERLAY: 'modal-overlay',
  NATIVE_THEME: 'native-theme',
  NEW_WINDOW: 'new-window',
  ONBOARDING_CANCEL: 'onboarding-cancel',
  ONBOARDING_DONE: 'onboarding-done',
  ONBOARDING_OUTPUT: 'onboarding-output',
  ONBOARDING_RUN: 'onboarding-run',
  PICK_A11Y: 'pick-a11y',
  PICK_ANIMATE: 'pick-animate',
  PICK_CANCEL: 'pick-cancel',
  PICK_CANCELLED: 'pick-cancelled',
  PICK_COMPONENT: 'pick-component',
  PICK_COMPONENT_RESULT: 'pick-component-result',
  PICK_DRAW: 'pick-draw',
  PICK_EYEDROPPER: 'pick-eyedropper',
  PICK_IMAGE_FILE: 'pick-image-file',
  PICK_PANEL_CANCEL: 'pick-panel-cancel',
  PICK_PANEL_OPEN: 'pick-panel-open',
  PICK_PANEL_SEND: 'pick-panel-send',
  PICK_PANEL_STYLE: 'pick-panel-style',
  PICK_PANEL_READ_CSS: 'pick-panel-read-css',   // re-read one element's computed CSS (with any forced pseudo-state applied)
  PICK_PANEL_UPDATE: 'pick-panel-update',
  PICK_PANEL_SIZE: 'pick-panel-size',   // a resize-handle drag finished on the page → tick Width/Height in the drawer
  PICK_PROJECT_DIR: 'pick-project-dir',
  PICK_MOVE: 'pick-move',
  OVERLAY_ACCENT: 'overlay-accent',   // theme's Selection colour → page-tool overlays (renderer → main)
  PICK_SCREENSHOT: 'pick-screenshot',
  PICK_SEND_TO_SESSION: 'pick-send-to-session',
  STATES_FORCE: 'states-force',
  STATES_CLEAR: 'states-clear',
  PICK_START: 'pick-start',
  POPUP_URL: 'popup-url',
  PROFILE_INSTALL: 'profile-install',
  PROFILE_INSTALL_DONE: 'profile-install-done',
  PROFILE_INSTALL_ERROR: 'profile-install-error',
  PROFILE_INSTALL_PROGRESS: 'profile-install-progress',
  PTY_INPUT: 'pty-input',
  PTY_KILL: 'pty-kill',
  PTY_OUTPUT: 'pty-output',
  PTY_RESIZE: 'pty-resize',
  PTY_RESTART: 'pty-restart',
  PTY_SPAWN: 'pty-spawn',
  REGISTER_BROWSER_TOOLS: 'register-browser-tools',
  RENDERER_READY: 'renderer-ready',
  RIGHT_PANEL_MODE: 'right-panel-mode',
  SB_BAR_MENU_ACTION: 'sb-bar-menu-action',
  SCREENSHOT_PANEL_CANCEL: 'screenshot-panel-cancel',
  SCREENSHOT_PANEL_OPEN: 'screenshot-panel-open',
  SCREENSHOT_PANEL_SEND: 'screenshot-panel-send',
  SECRET_OPEN: 'secret-open',
  SECRET_SEAL: 'secret-seal',
  SET_API_KEY: 'set-api-key',
  SET_BROWSER_EMPTY: 'set-browser-empty',
  SET_DEVICE: 'set-device',
  SET_PROJECT_DIR: 'set-project-dir',
  SETTINGS_ACTION: 'settings-action',
  WATCH_APPROVAL_GET: 'watch-approval-get',
  WATCH_APPROVAL_SET: 'watch-approval-set',
  WATCH_APPROVAL_TEST: 'watch-approval-test',
  SHORTCUT_ACTION: 'shortcut-action',
  SHOW_DEVICE_MENU: 'show-device-menu',
  SHOW_FILE_DIALOG: 'show-file-dialog',
  SHOW_FOLDER_DIALOG: 'show-folder-dialog',
  SHOW_SB_BAR_MENU: 'show-sb-bar-menu',
  SHOW_SETTINGS_MENU: 'show-settings-menu',
  SHOW_TABS_CONTEXT_MENU: 'show-tabs-context-menu',
  SINGLE_PANE: 'single-pane',
  SPLIT_CHANGED: 'split-changed',
  STORYBOOK_ADOPT: 'storybook-adopt',
  STORYBOOK_PROJECT_SWITCH: 'storybook-project-switch',   // storybook follows the active project
  STORYBOOK_CLEAR_MEMORY: 'storybook-clear-memory',
  STORYBOOK_DETECT: 'storybook-detect',
  STORYBOOK_DISCONNECT: 'storybook-disconnect',
  STORYBOOK_INSTANCES: 'storybook-instances',
  STORYBOOK_LIST: 'storybook-list',
  STORYBOOK_OPEN_EXTERNAL: 'storybook-open-external',
  STORYBOOK_OPEN_SWITCHER: 'storybook-open-switcher',
  STORYBOOK_RELOAD: 'storybook-reload',
  STORYBOOK_SCAN: 'storybook-scan',
  STORYBOOK_SERVER_START: 'storybook-server-start',
  STORYBOOK_SERVER_STATUS: 'storybook-server-status',
  STORYBOOK_SERVER_STOP: 'storybook-server-stop',
  STORYBOOK_SETUP_OPEN: 'storybook-setup-open',
  STORYBOOK_SHOW_SETUP: 'storybook-show-setup',
  STORYBOOK_WRITE_MEMORY: 'storybook-write-memory',
  SYSPERF: 'sysperf',
  SYSPERF_ACTIVE: 'sysperf-active',
  TAB_TITLE_UPDATED: 'tab-title-updated',
  TOGGLE_PAGE_SELECTION: 'toggle-page-selection',
  TOP_PROCS: 'top-procs',
  UPDATE_AVAILABLE: 'update-available',
  UPDATE_DOWNLOADED: 'update-downloaded',
  UPDATE_DOWNLOADING: 'update-downloading',
  UPDATE_ERROR: 'update-error',
  UPDATE_PROGRESS: 'update-progress',
  DRAG_HOVER_PROBE: 'drag-hover-probe',   // renderer → main: start/stop reporting the cursor over a drag region
  DRAG_HOVER_POINT: 'drag-hover-point',   // main → renderer: cursor position in page px, or null once it leaves the window
  EXPORT_PREPARE: 'export-prepare',         // renderer → main: previews + page metrics, before the dialog opens
  EXPORT_SAVE_DIALOG: 'export-save-dialog', // renderer → main: native Save dialog for the chosen format
  EXPORT_RUN: 'export-run',                 // renderer → main: capture (and, for PDF, write) after the dialog closes
  EXPORT_PROGRESS: 'export-progress',       // main → renderer: { phase, pct | left }
  EXPORT_CANCEL: 'export-cancel',           // renderer → main: Esc during a run
  WINDOW_CLOSE: 'window-close',
  WINDOW_MAXIMIZE_TOGGLE: 'window-maximize-toggle',
  WINDOW_MAXIMIZED_STATE: 'window-maximized-state',
  WINDOW_MINIMIZE: 'window-minimize',
});

module.exports = { IPC };
