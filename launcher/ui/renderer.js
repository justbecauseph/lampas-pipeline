// Lampas Launcher UI Renderer

let currentUser = null;
let currentConfig = null;
let isLaunching = false;
let logLineCount = 0;

// DOM Elements: Titlebar Controls
const btnMinimize = document.getElementById("btn-minimize");
const btnMaximize = document.getElementById("btn-maximize");
const btnClose = document.getElementById("btn-close");
const titlebarChannelBadge = document.getElementById("titlebar-channel-badge");
const titlebarGameStatus = document.getElementById("titlebar-game-status");
const titlebarStatusDot = document.getElementById("titlebar-status-dot");
const titlebarStatusText = document.getElementById("titlebar-status-text");

// DOM Elements: Navigation
const navPlay = document.getElementById("nav-play");
const navMods = document.getElementById("nav-mods");
const navConsole = document.getElementById("nav-console");
const navSettings = document.getElementById("nav-settings");

const tabPlay = document.getElementById("tab-play");
const tabMods = document.getElementById("tab-mods");
const tabConsole = document.getElementById("tab-console");
const tabSettings = document.getElementById("tab-settings");

// DOM Elements: User & Auth
const btnLogin = document.getElementById("btn-login");
const btnLogout = document.getElementById("btn-logout");
const userCard = document.getElementById("user-card");
const userName = document.getElementById("user-name");
const userRole = document.getElementById("user-role");
const userAvatar = document.getElementById("user-avatar");

// DOM Elements: Play & Launch Controls
const btnPlay = document.getElementById("btn-play");
const btnPlayText = document.getElementById("btn-play-text");
const btnPlaySpinner = document.getElementById("btn-play-spinner");
const btnStop = document.getElementById("btn-stop");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const progressMsg = document.getElementById("progress-msg");
const progressPercent = document.getElementById("progress-percent");
const ramDisplay = document.getElementById("ram-display");
const gamedirDisplay = document.getElementById("gamedir-display");
const btnOpenGamedir = document.getElementById("btn-open-gamedir");
const channelBtns = document.querySelectorAll(".channel-btn");

// DOM Elements: Modpack Info Tab
const modsPackVersion = document.getElementById("mods-pack-version");
const modsChannelBadge = document.getElementById("mods-channel-badge");
const btnRepairPack = document.getElementById("btn-repair-pack");
const btnVerifyPack = document.getElementById("btn-verify-pack");
const btnModsOpenDir = document.getElementById("btn-mods-open-dir");
const btnAddMods = document.getElementById("btn-add-mods");
const modDropZone = document.getElementById("mod-drop-zone");

// DOM Elements: Console Tab
const consoleOutput = document.getElementById("console-output");
const consoleCount = document.getElementById("console-count");
const consoleAutoscroll = document.getElementById("console-autoscroll");
const btnCopyLogs = document.getElementById("btn-copy-logs");
const btnClearLogs = document.getElementById("btn-clear-logs");
const consoleGameStatus = document.getElementById("console-game-status");
const consoleStatusDot = document.getElementById("console-status-dot");
const consoleStatusText = document.getElementById("console-status-text");
const btnConsoleStop = document.getElementById("btn-console-stop");

function setConsoleStatus(status, textOverride) {
  // Update Console Indicator
  if (consoleGameStatus && consoleStatusDot && consoleStatusText) {
    if (status === "running") {
      consoleStatusDot.className = "status-dot status-dot-running";
      consoleStatusText.innerText = textOverride || "GAME RUNNING";
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-emerald-400 border-emerald-500/40 bg-emerald-950/50";
      if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
    } else if (status === "syncing" || status === "launching" || status === "repairing") {
      consoleStatusDot.className = "status-dot status-dot-launching";
      consoleStatusText.innerText = textOverride || (status === "syncing" ? "SYNCING..." : status === "repairing" ? "REPAIRING..." : "LAUNCHING...");
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-amber-400 border-amber-500/40 bg-amber-950/50";
      if (btnConsoleStop) btnConsoleStop.classList.remove("hidden");
    } else {
      consoleStatusDot.className = "status-dot status-dot-idle";
      consoleStatusText.innerText = textOverride || "IDLE";
      consoleGameStatus.className = "badge flex items-center gap-1.5 text-slate-400";
      if (btnConsoleStop) btnConsoleStop.classList.add("hidden");
    }
  }

  // Update Titlebar Indicator
  if (titlebarGameStatus && titlebarStatusDot && titlebarStatusText) {
    if (status === "running") {
      titlebarStatusDot.className = "status-dot status-dot-running";
      titlebarStatusText.innerText = textOverride || "RUNNING";
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-emerald-400 border-emerald-500/40 bg-emerald-950/50";
    } else if (status === "syncing" || status === "launching" || status === "repairing") {
      titlebarStatusDot.className = "status-dot status-dot-launching";
      titlebarStatusText.innerText = textOverride || (status === "syncing" ? "SYNCING" : status === "repairing" ? "REPAIRING" : "LAUNCHING");
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-amber-400 border-amber-500/40 bg-amber-950/50";
    } else {
      titlebarStatusDot.className = "status-dot status-dot-idle";
      titlebarStatusText.innerText = textOverride || "IDLE";
      titlebarGameStatus.className = "badge flex items-center gap-1.5 text-slate-400";
    }
  }
}

// DOM Elements: Settings Tab
const ramSlider = document.getElementById("ram-slider");
const settingRamVal = document.getElementById("setting-ram-val");
const settingGamedirInput = document.getElementById("setting-gamedir-input");
const btnSettingsOpenDir = document.getElementById("btn-settings-open-dir");
const settingPortal = document.getElementById("setting-portal");
const settingJavaArgs = document.getElementById("setting-java-args");
const btnRepairSettings = document.getElementById("btn-repair-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");

// DOM Elements: Toast Container
const toastContainer = document.getElementById("toast-container");

// ========================================================
// Toast Notification Utility
// ========================================================
function showToast(message, type = "info", duration = 3500) {
  if (!toastContainer) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
  } else if (type === "error") {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
  } else {
    iconSvg = `<svg class="w-4 h-4 toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
  }

  toast.innerHTML = `
    ${iconSvg}
    <span class="truncate">${message}</span>
  `;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ========================================================
// Window Titlebar Controls
// ========================================================
if (btnMinimize) {
  btnMinimize.onclick = () => window.lampas.window.minimize();
}

if (btnMaximize) {
  btnMaximize.onclick = async () => {
    await window.lampas.window.maximize();
  };
}

if (btnClose) {
  btnClose.onclick = () => window.lampas.window.close();
}

// ========================================================
// Navigation Tabs
// ========================================================
function switchTab(activeNav, activeTab) {
  [navPlay, navMods, navConsole, navSettings].forEach((n) => n?.classList.remove("active"));
  [tabPlay, tabMods, tabConsole, tabSettings].forEach((t) => t?.classList.add("hidden"));

  activeNav?.classList.add("active");
  activeTab?.classList.remove("hidden");
}

if (navPlay) navPlay.onclick = () => switchTab(navPlay, tabPlay);
if (navMods) navMods.onclick = () => switchTab(navMods, tabMods);
if (navConsole) navConsole.onclick = () => switchTab(navConsole, tabConsole);
if (navSettings) navSettings.onclick = () => switchTab(navSettings, tabSettings);

// ========================================================
// RAM Slider & Real-Time Sync
// ========================================================
if (ramSlider) {
  ramSlider.oninput = (e) => {
    const val = e.target.value;
    if (ramDisplay) ramDisplay.innerText = `${val} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${val} GB`;
  };
}

// ========================================================
// Console Logging
// ========================================================
function appendLog(level, message, timestamp) {
  if (!consoleOutput) return;

  const line = document.createElement("div");
  const lvl = (level || "INFO").toUpperCase();
  const time = timestamp || new Date().toLocaleTimeString();

  line.className = `console-line console-line-${lvl.toLowerCase()}`;
  line.innerText = `[${time}] [${lvl}] ${message}`;

  consoleOutput.appendChild(line);
  logLineCount++;

  if (consoleCount) {
    consoleCount.innerText = `${logLineCount} line${logLineCount === 1 ? "" : "s"}`;
  }

  if (consoleAutoscroll && consoleAutoscroll.checked) {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }
}

if (btnClearLogs) {
  btnClearLogs.onclick = () => {
    if (consoleOutput) {
      consoleOutput.innerHTML = "";
      logLineCount = 0;
      if (consoleCount) consoleCount.innerText = "0 lines";
      showToast("Console cleared", "info", 1500);
    }
  };
}

if (btnCopyLogs) {
  btnCopyLogs.onclick = async () => {
    if (!consoleOutput) return;
    try {
      const text = consoleOutput.innerText;
      await navigator.clipboard.writeText(text);
      showToast("Logs copied to clipboard!", "success", 2000);
    } catch {
      showToast("Failed to copy logs", "error", 2000);
    }
  };
}

// Subscribe to Game Logs
window.lampas.game.onLog((entry) => {
  appendLog(entry.level, entry.message, entry.timestamp);
});

// Subscribe to Game Exit
window.lampas.game.onExit((code) => {
  isLaunching = false;
  setConsoleStatus("idle", "IDLE");
  if (btnPlay) {
    btnPlay.disabled = false;
  }
  if (btnPlayText) btnPlayText.innerText = currentUser ? "PLAY" : "LOG IN TO PLAY";
  if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
  if (btnStop) btnStop.classList.add("hidden");
  if (progressContainer) progressContainer.classList.add("hidden");

  appendLog(code === 0 ? "INFO" : "ERROR", `Game process terminated (exit code: ${code})`);

  if (code !== 0 && code !== null) {
    showToast(`Minecraft exited with code ${code}. Check Console tab for logs.`, "error", 5000);
  } else {
    showToast("Minecraft session ended.", "info", 2500);
  }
});

// ========================================================
// Auth & Profile Management
// ========================================================
function updateUserUI(user) {
  currentUser = user;

  if (user) {
    if (btnLogin) btnLogin.classList.add("hidden");
    if (userCard) userCard.classList.remove("hidden");

    const displayName = user.minecraftUsername || user.name || user.discordTag || "Player";
    if (userName) userName.innerText = displayName;
    if (userRole) {
      userRole.innerText = user.isTech ? "Tech Staff" : user.isAdmin ? "Admin" : "Verified";
    }
    if (userAvatar) {
      userAvatar.innerText = displayName[0]?.toUpperCase() || "P";
    }

    if (btnPlayText && !isLaunching) {
      btnPlayText.innerText = "PLAY";
    }

    // Channel gating based on user permissions
    const allowed = user.allowedChannels || ["stable"];
    channelBtns.forEach((btn) => {
      const ch = btn.dataset.channel;
      btn.disabled = !allowed.includes(ch);
    });
  } else {
    if (btnLogin) btnLogin.classList.remove("hidden");
    if (userCard) userCard.classList.add("hidden");

    if (btnPlayText && !isLaunching) {
      btnPlayText.innerText = "LOG IN TO PLAY";
    }

    channelBtns.forEach((btn) => {
      btn.disabled = btn.dataset.channel !== "stable";
    });

    const activeChannelBtn = document.querySelector(".channel-btn.active");
    if (activeChannelBtn && activeChannelBtn.dataset.channel !== "stable") {
      applyChannel("stable");
    }
  }
}

// Portal OAuth Login
if (btnLogin) {
  btnLogin.onclick = async () => {
    try {
      btnLogin.disabled = true;
      btnLogin.innerHTML = `
        <span class="spinner mr-2"></span>
        <span>Authorizing in browser...</span>
      `;
      showToast("Opening browser for Lampas Portal authentication...", "info", 4000);

      const res = await window.lampas.auth.login(currentConfig?.portalUrl);
      updateUserUI(res.user);
      showToast(`Welcome back, ${res.user.minecraftUsername || res.user.name || "Player"}!`, "success");
    } catch (err) {
      showToast(`Login failed: ${err.message}`, "error", 5000);
    } finally {
      if (btnLogin) {
        btnLogin.disabled = false;
        btnLogin.innerHTML = `
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
          </svg>
          <span>Log In with Portal</span>
        `;
      }
    }
  };
}

if (btnLogout) {
  btnLogout.onclick = async () => {
    try {
      await window.lampas.auth.logout();
      currentConfig = await window.lampas.config.get();
      updateUserUI(null);
      showToast("Logged out successfully.", "info");
    } catch (err) {
      showToast(`Logout failed: ${err.message}`, "error");
    }
  };
}

// ========================================================
// Channel Switching
// ========================================================
function applyChannel(channel) {
  channelBtns.forEach((b) => {
    if (b.dataset.channel === channel) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  });

  const upper = (channel || "stable").toUpperCase();
  if (titlebarChannelBadge) titlebarChannelBadge.innerText = upper;
  if (modsChannelBadge) modsChannelBadge.innerText = upper;
}

channelBtns.forEach((btn) => {
  btn.onclick = async () => {
    if (btn.disabled) return;
    const channel = btn.dataset.channel;
    applyChannel(channel);
    currentConfig = await window.lampas.config.set({ selectedChannel: channel });
    showToast(`Switched channel to ${channel.toUpperCase()}`, "info", 2000);
  };
});

// ========================================================
// Directory Opening Actions
// ========================================================
async function openGameDir() {
  if (currentConfig?.gameDir && window.lampas.utils?.openPath) {
    await window.lampas.utils.openPath(currentConfig.gameDir);
  }
}

if (btnOpenGamedir) btnOpenGamedir.onclick = openGameDir;
if (btnSettingsOpenDir) btnSettingsOpenDir.onclick = openGameDir;
if (btnModsOpenDir) btnModsOpenDir.onclick = openGameDir;

// ========================================================
// Settings Management
// ========================================================
if (btnSaveSettings) {
  btnSaveSettings.onclick = async () => {
    try {
      const ram = parseInt(ramSlider?.value || "4", 10);
      const portalUrl = settingPortal?.value?.trim() || "http://localhost:3000";

      currentConfig = await window.lampas.config.set({
        allocatedRamGb: ram,
        portalUrl,
        javaArgs: settingJavaArgs?.value?.trim() || "",
      });

      showToast("Settings saved successfully!", "success");
    } catch (err) {
      showToast(`Failed to save settings: ${err.message}`, "error");
    }
  };
}

// ========================================================
// Installation Repair & Integrity Recovery
// ========================================================
async function handleRepair() {
  if (isLaunching) {
    showToast("Cannot repair while game or launch is in progress.", "info");
    return;
  }

  if (!currentUser) {
    showToast("Authentication required: Please log in with Lampas Portal before repairing files.", "warning", 4000);
    if (btnLogin) btnLogin.click();
    return;
  }

  try {
    isLaunching = true;
    setConsoleStatus("repairing", "REPAIRING...");
    if (btnRepairPack) btnRepairPack.disabled = true;
    if (btnRepairSettings) btnRepairSettings.disabled = true;
    if (btnPlay) btnPlay.disabled = true;

    // Refresh token with portal
    const session = await window.lampas.auth.refresh(currentConfig?.portalUrl);
    if (!session?.valid || !session?.user) {
      updateUserUI(null);
      showToast("Portal session expired. Please log in again.", "warning", 4000);
      if (btnLogin) btnLogin.click();
      return;
    }
    updateUserUI(session.user);

    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressFill) progressFill.style.width = "0%";
    if (progressPercent) progressPercent.innerText = "0%";
    if (progressMsg) progressMsg.innerText = "Initiating full file & asset repair...";

    appendLog("INFO", "[Repair] Starting full installation repair and asset verification...");
    showToast("Repairing installation: validating assets, libraries, and mod files...", "info", 4000);

    const removeListener = window.lampas.sync.onProgress((progress) => {
      if (progressFill) progressFill.style.width = `${progress.percent}%`;
      if (progressPercent) progressPercent.innerText = `${progress.percent}%`;
      if (progressMsg) progressMsg.innerText = progress.message;
    });

    const repairRes = await window.lampas.sync.repair();
    removeListener();

    if (progressFill) progressFill.style.width = "100%";
    if (progressPercent) progressPercent.innerText = "100%";
    if (progressMsg) progressMsg.innerText = "Repair complete!";

    appendLog("INFO", `[Repair] ${repairRes.message || "All components verified and repaired."}`);
    showToast("Repair complete! All assets, libraries, and mods verified.", "success", 4500);
  } catch (err) {
    appendLog("ERROR", `[Repair Error] ${err.message}`);
    showToast(`Repair Error: ${err.message}`, "error", 6000);
  } finally {
    isLaunching = false;
    setConsoleStatus("idle", "IDLE");
    if (btnRepairPack) btnRepairPack.disabled = false;
    if (btnRepairSettings) btnRepairSettings.disabled = false;
    if (btnPlay) btnPlay.disabled = false;
  }
}

if (btnRepairPack) btnRepairPack.onclick = handleRepair;
if (btnRepairSettings) btnRepairSettings.onclick = handleRepair;

// ========================================================
// Force Verify Modpack Button
// ========================================================
if (btnVerifyPack) {
  btnVerifyPack.onclick = async () => {
    if (isLaunching) {
      showToast("Launch is already in progress.", "info");
      return;
    }
    switchTab(navPlay, tabPlay);
    btnPlay.click();
  };
}

// ========================================================
// Game Stop / Kill Button
// ========================================================
async function handleStopGame() {
  try {
    if (btnStop) btnStop.disabled = true;
    if (btnConsoleStop) btnConsoleStop.disabled = true;
    appendLog("WARN", "Termination signal sent to Minecraft process...");
    showToast("Terminating Minecraft process...", "info", 2000);
    await window.lampas.game.kill();
  } catch (err) {
    showToast(`Failed to terminate game: ${err.message}`, "error");
  } finally {
    if (btnStop) btnStop.disabled = false;
    if (btnConsoleStop) btnConsoleStop.disabled = false;
  }
}

if (btnStop) btnStop.onclick = handleStopGame;
if (btnConsoleStop) btnConsoleStop.onclick = handleStopGame;

// ========================================================
// Sync & Play Launch Flow
// ========================================================
if (btnPlay) {
  btnPlay.onclick = async () => {
    if (isLaunching) {
      // If already playing, switch to console
      switchTab(navConsole, tabConsole);
      return;
    }

    // Require authentication before playing
    if (!currentUser) {
      showToast("Authentication required: Please log in with Lampas Portal to play.", "warning", 4000);
      if (btnLogin) {
        btnLogin.click();
      }
      return;
    }

    // Navigate to Console and Logs tab on play
    switchTab(navConsole, tabConsole);

    try {
      isLaunching = true;
      btnPlay.disabled = true;
      setConsoleStatus("syncing", "VERIFYING TOKEN...");
      if (btnPlayText) btnPlayText.innerText = "VERIFYING...";
      if (btnPlaySpinner) btnPlaySpinner.classList.remove("hidden");
      if (btnStop) btnStop.classList.remove("hidden");

      // 1. Refresh & ensure fresh token from Portal
      const session = await window.lampas.auth.refresh(currentConfig?.portalUrl);
      if (!session?.valid || !session?.user) {
        isLaunching = false;
        updateUserUI(null);
        showToast("Portal session expired. Please log in again.", "warning", 5000);
        if (btnLogin) btnLogin.click();
        return;
      }
      updateUserUI(session.user);

      if (progressContainer) {
        progressContainer.classList.remove("hidden");
      }
      if (progressFill) progressFill.style.width = "0%";
      if (progressPercent) progressPercent.innerText = "0%";
      if (progressMsg) progressMsg.innerText = "Connecting to pipeline...";

      // Progress listener
      const removeListener = window.lampas.sync.onProgress((progress) => {
        if (progressFill) progressFill.style.width = `${progress.percent}%`;
        if (progressPercent) progressPercent.innerText = `${progress.percent}%`;
        if (progressMsg) progressMsg.innerText = progress.message;

        if (progress.status === "downloading") {
          if (btnPlayText) btnPlayText.innerText = "DOWNLOADING...";
          setConsoleStatus("syncing", "DOWNLOADING...");
        } else if (progress.status === "staging") {
          if (btnPlayText) btnPlayText.innerText = "STAGING...";
          setConsoleStatus("syncing", "STAGING...");
        }
      });

      appendLog("INFO", "Initiating modpack synchronization...");
      const syncResult = await window.lampas.sync.start();
      removeListener();

      if (btnPlayText) btnPlayText.innerText = "LAUNCHING...";
      setConsoleStatus("launching", "STARTING JVM...");
      if (progressMsg) progressMsg.innerText = "Starting Minecraft JVM...";
      if (progressFill) progressFill.style.width = "100%";
      if (progressPercent) progressPercent.innerText = "100%";

      appendLog("INFO", `Pack v${syncResult.version} synchronized. Bootstrapping KnotClient runtime...`);
      showToast(`Pack v${syncResult.version} verified. Launching game...`, "info", 2500);

      await window.lampas.game.launch(currentUser);

      if (btnPlayText) btnPlayText.innerText = "RUNNING";
      setConsoleStatus("running", "GAME RUNNING");
      if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
      if (btnPlay) btnPlay.disabled = false; // allow clicking to switch to console
    } catch (err) {
      isLaunching = false;
      setConsoleStatus("idle", "ERROR");
      if (btnPlay) btnPlay.disabled = false;
      if (btnPlayText) btnPlayText.innerText = currentUser ? "PLAY" : "LOG IN TO PLAY";
      if (btnPlaySpinner) btnPlaySpinner.classList.add("hidden");
      if (btnStop) btnStop.classList.add("hidden");
      if (progressContainer) progressContainer.classList.add("hidden");

      showToast(`Launch Error: ${err.message}`, "error", 6000);
      appendLog("ERROR", err.message);
    }
  };
}

// ========================================================
// Initialization on App Load
// ========================================================
async function init() {
  try {
    currentConfig = await window.lampas.config.get();

    // RAM allocation display & controls
    const ram = currentConfig.allocatedRamGb || 4;
    if (ramSlider) ramSlider.value = ram;
    if (ramDisplay) ramDisplay.innerText = `${ram} GB RAM`;
    if (settingRamVal) settingRamVal.innerText = `${ram} GB`;

    // Game Directory display
    const gDir = currentConfig.gameDir || ".minecraft-lampas";
    if (gamedirDisplay) gamedirDisplay.innerText = gDir;
    if (settingGamedirInput) settingGamedirInput.value = gDir;

    // Portal Endpoint
    if (settingPortal) {
      settingPortal.value = currentConfig.portalUrl || "http://localhost:3000";
    }
    if (settingJavaArgs) settingJavaArgs.value = currentConfig.javaArgs || "";

    // Selected Channel
    const selChannel = currentConfig.selectedChannel || "stable";
    applyChannel(selChannel);

    // Verify & refresh session
    try {
      const authCheck = await window.lampas.auth.refresh(currentConfig.portalUrl);
      if (authCheck?.valid && authCheck?.user) {
        updateUserUI(authCheck.user);
      } else {
        updateUserUI(null);
      }
    } catch {
      updateUserUI(null);
    }

    // Load rich mod catalog
    await loadModCatalog();
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// ========================================================
// Mod Explorer & Metadata Catalog
// ========================================================
let allMods = [];
let activeModFilter = "all";
let activeModSearch = "";

const modsGrid = document.getElementById("mods-grid");
const modsSearchInput = document.getElementById("mods-search-input");
const modsFilteredCount = document.getElementById("mods-filtered-count");
const managedModCount = document.getElementById("managed-mod-count");
const optionalModCount = document.getElementById("optional-mod-count");
const localModCount = document.getElementById("local-mod-count");
const modFilterPills = document.querySelectorAll(".mod-filter-pill");

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function renderMods() {
  if (!modsGrid) return;

  const query = (activeModSearch || "").toLowerCase().trim();
  const filter = (activeModFilter || "all").toLowerCase();

  const filtered = allMods.filter((mod) => {
    // Filter check
    if (filter === "client" && mod.side !== "client") return false;
    if (filter === "custom" && mod.source !== "custom") return false;
    if (filter === "server" && mod.side !== "server") return false;
    if (filter === "both" && mod.side !== "both") return false;
    if (filter !== "all" && filter !== "client" && filter !== "server" && filter !== "both") {
      const cats = (mod.categories || []).map((c) => c.toLowerCase());
      if (!cats.includes(filter)) return false;
    }

    // Search query check
    if (query) {
      const matchName = (mod.name || "").toLowerCase().includes(query);
      const matchId = (mod.id || "").toLowerCase().includes(query);
      const matchDesc = (mod.description || "").toLowerCase().includes(query);
      const matchCats = (mod.categories || []).some((c) => c.toLowerCase().includes(query));
      if (!matchName && !matchId && !matchDesc && !matchCats) return false;
    }

    return true;
  });

  if (modsFilteredCount) {
    modsFilteredCount.innerText = `${filtered.length} of ${allMods.length}`;
  }

  if (filtered.length === 0) {
    modsGrid.innerHTML = `
      <div class="col-span-2 py-12 text-center text-slate-500 text-xs">
        No mods found matching your search and filter criteria.
      </div>
    `;
    return;
  }

  modsGrid.innerHTML = filtered
    .map((mod) => {
      const sideBadge =
        mod.side === "client"
          ? '<span class="text-[9px] font-bold text-cyan-400 bg-cyan-950/80 border border-cyan-800/60 px-1.5 py-0.5 rounded-md">CLIENT ONLY</span>'
          : mod.side === "server"
          ? '<span class="text-[9px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded-md">SERVER ONLY</span>'
          : '<span class="text-[9px] font-bold text-indigo-400 bg-indigo-950/80 border border-indigo-800/60 px-1.5 py-0.5 rounded-md">DUAL-SIDED</span>';

      const fallbackText = escapeHtml((mod.name || mod.id || "M")[0].toUpperCase());
      const modName = escapeHtml(mod.name || mod.filename || "Unknown mod");
      const modId = escapeHtml(mod.id);
      const iconHtml = mod.iconUrl
        ? `<div class="mod-icon-wrapper">
            <img src="${escapeHtml(mod.iconUrl)}" alt="${modName}" class="mod-icon-img" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="mod-icon-fallback" style="display: none;">${fallbackText}</div>
          </div>`
        : `<div class="mod-icon-wrapper">
            <div class="mod-icon-fallback">${fallbackText}</div>
          </div>`;

      const catsHtml = (mod.categories || [])
        .slice(0, 3)
        .map((c) => `<span class="text-[9px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">#${escapeHtml(c)}</span>`)
        .join(" ");

      const linkBtn = mod.sourceUrl
        ? `<button data-source-url="${escapeHtml(mod.sourceUrl)}" class="mod-link-btn js-source-link" title="Open source page">View ↗</button>`
        : "";

      const toggle = mod.canDisable
        ? `<label class="mod-switch" title="${mod.enabled ? "Disable" : "Enable"} ${modName}">
            <input class="js-mod-toggle" type="checkbox" data-id="${modId}" data-filename="${escapeHtml(mod.filename)}" data-source="${escapeHtml(mod.source)}" ${mod.enabled ? "checked" : ""}>
            <span></span>
          </label>`
        : "";
      const localBadge = mod.source === "custom" ? '<span class="local-mod-badge">LOCAL</span>' : "";
      const remove = mod.source === "custom"
        ? `<button class="mod-remove-btn js-mod-remove" data-filename="${escapeHtml(mod.filename)}" title="Remove this local mod">Remove</button>`
        : "";

      return `
        <div class="mod-card">
          <div class="flex items-start gap-3">
            ${iconHtml}
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-1">
                <h5 class="font-bold text-xs text-white truncate" title="${modName}">${modName}</h5>
                <div class="flex items-center gap-1">${localBadge}${sideBadge}${toggle}</div>
              </div>
              <p class="text-[11px] text-slate-400 line-clamp-2 mt-1 leading-relaxed">${escapeHtml(mod.description || "Synchronized modpack component.")}</p>
            </div>
          </div>
          <div class="flex items-center justify-between pt-1 border-t border-slate-900/80 text-[10px] text-slate-500 font-mono">
            <div class="flex items-center gap-1 overflow-hidden">
              ${catsHtml}
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <span>${formatBytes(mod.size)}</span>
              ${remove}
              ${linkBtn}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  modsGrid.querySelectorAll(".js-source-link").forEach((button) => {
    button.onclick = () => window.lampas.utils.openPath(button.dataset.sourceUrl);
  });
  modsGrid.querySelectorAll(".js-mod-toggle").forEach((toggle) => {
    toggle.onchange = async () => {
      try {
        toggle.disabled = true;
        if (toggle.dataset.source === "custom") {
          await window.lampas.mods.setCustomEnabled(toggle.dataset.filename, toggle.checked);
        } else {
          await window.lampas.mods.setOfficialEnabled(toggle.dataset.id, toggle.checked);
        }
        await loadModCatalog();
        showToast(`${toggle.checked ? "Enabled" : "Disabled"} ${toggle.dataset.filename}. Changes apply on the next sync.`, "success");
      } catch (err) {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
        showToast(`Could not update mod: ${err.message}`, "error");
      }
    };
  });
  modsGrid.querySelectorAll(".js-mod-remove").forEach((button) => {
    button.onclick = async () => {
      try {
        await window.lampas.mods.removeCustom(button.dataset.filename);
        await loadModCatalog();
        showToast(`Removed ${button.dataset.filename}.`, "success");
      } catch (err) {
        showToast(`Could not remove mod: ${err.message}`, "error");
      }
    };
  });
}

async function addLocalMods(files) {
  try {
    if (files) await window.lampas.mods.addDropped(Array.from(files));
    else await window.lampas.mods.browseAndAdd();
    await loadModCatalog();
    showToast("Local client mods added. They will be preserved during sync.", "success");
  } catch (err) {
    showToast(`Could not add mod: ${err.message}`, "error", 5000);
  }
}

if (btnAddMods) btnAddMods.onclick = () => addLocalMods();
if (modDropZone) {
  for (const eventName of ["dragenter", "dragover"]) {
    modDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      modDropZone.classList.add("drag-active");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    modDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      modDropZone.classList.remove("drag-active");
    });
  }
  modDropZone.addEventListener("drop", (event) => addLocalMods(event.dataTransfer?.files));
  modDropZone.onclick = () => addLocalMods();
}

async function loadModCatalog() {
  try {
    if (window.lampas.sync?.getModCatalog) {
      allMods = await window.lampas.sync.getModCatalog();
      if (managedModCount) managedModCount.innerText = allMods.filter((mod) => mod.source === "official").length;
      if (optionalModCount) optionalModCount.innerText = allMods.filter((mod) => mod.source === "official" && mod.canDisable).length;
      if (localModCount) localModCount.innerText = allMods.filter((mod) => mod.source === "custom").length;
      renderMods();
    }
  } catch (err) {
    console.warn("Failed to load mod catalog:", err);
  }
}

if (modsSearchInput) {
  modsSearchInput.oninput = (e) => {
    activeModSearch = e.target.value;
    renderMods();
  };
}

modFilterPills.forEach((pill) => {
  pill.onclick = () => {
    modFilterPills.forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    activeModFilter = pill.dataset.filter || "all";
    renderMods();
  };
});

init();
