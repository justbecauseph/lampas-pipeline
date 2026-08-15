// Lampas Launcher UI Renderer

let currentUser = null;
let currentConfig = null;
let isLaunching = false;
let currentMsaPrompt = null;

// DOM Elements
const btnMinimize = document.getElementById("btn-minimize");
const btnMaximize = document.getElementById("btn-maximize");
const btnClose = document.getElementById("btn-close");

const navPlay = document.getElementById("nav-play");
const navMods = document.getElementById("nav-mods");
const navConsole = document.getElementById("nav-console");
const navSettings = document.getElementById("nav-settings");

const tabPlay = document.getElementById("tab-play");
const tabMods = document.getElementById("tab-mods");
const tabConsole = document.getElementById("tab-console");
const tabSettings = document.getElementById("tab-settings");

const btnLogin = document.getElementById("btn-login");
const btnMsaLogin = document.getElementById("btn-msa-login");
const btnLogout = document.getElementById("btn-logout");
const userCard = document.getElementById("user-card");
const userName = document.getElementById("user-name");
const userRole = document.getElementById("user-role");
const userAvatar = document.getElementById("user-avatar");

const modalMsa = document.getElementById("modal-msa");
const btnCloseMsa = document.getElementById("btn-close-msa");
const msaCodeDisplay = document.getElementById("msa-code-display");
const btnCopyMsaCode = document.getElementById("btn-copy-msa-code");
const btnOpenMsaUrl = document.getElementById("btn-open-msa-url");

const btnPlay = document.getElementById("btn-play");
const btnPlayText = document.getElementById("btn-play-text");
const progressContainer = document.getElementById("progress-container");
const progressFill = document.getElementById("progress-fill");
const progressMsg = document.getElementById("progress-msg");
const progressPercent = document.getElementById("progress-percent");

const ramSlider = document.getElementById("ram-slider");
const ramDisplay = document.getElementById("ram-display");
const settingPortal = document.getElementById("setting-portal");
const btnSaveSettings = document.getElementById("btn-save-settings");

const consoleOutput = document.getElementById("console-output");
const btnClearLogs = document.getElementById("btn-clear-logs");
const channelBtns = document.querySelectorAll(".channel-btn");

// Window Controls
btnMinimize.onclick = () => window.lampas.window.minimize();
btnMaximize.onclick = () => window.lampas.window.maximize();
btnClose.onclick = () => window.lampas.window.close();

// Navigation Tabs
function switchTab(activeNav, activeTab) {
  [navPlay, navMods, navConsole, navSettings].forEach((n) => n.classList.remove("active"));
  [tabPlay, tabMods, tabConsole, tabSettings].forEach((t) => t.classList.add("hidden"));

  activeNav.classList.add("active");
  activeTab.classList.remove("hidden");
}

navPlay.onclick = () => switchTab(navPlay, tabPlay);
navMods.onclick = () => switchTab(navMods, tabMods);
navConsole.onclick = () => switchTab(navConsole, tabConsole);
navSettings.onclick = () => switchTab(navSettings, tabSettings);

// RAM Slider
ramSlider.oninput = (e) => {
  const val = e.target.value;
  ramDisplay.innerText = `${val} GB RAM`;
};

btnSaveSettings.onclick = async () => {
  const ram = parseInt(ramSlider.value, 10);
  const portalUrl = settingPortal.value.trim();
  currentConfig = await window.lampas.config.set({
    allocatedRamGb: ram,
    portalUrl,
  });
  alert("Settings saved!");
};

// Console Logging
function appendLog(level, message, timestamp) {
  const line = document.createElement("div");
  line.className = `console-line-${level.toLowerCase()}`;
  line.innerText = `[${timestamp || new Date().toLocaleTimeString()}] [${level}] ${message}`;
  consoleOutput.appendChild(line);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

btnClearLogs.onclick = () => {
  consoleOutput.innerHTML = "";
};

window.lampas.game.onLog((entry) => {
  appendLog(entry.level, entry.message, entry.timestamp);
});

window.lampas.game.onExit((code) => {
  isLaunching = false;
  btnPlay.disabled = false;
  btnPlayText.innerText = "PLAY";
  progressContainer.classList.add("hidden");
  appendLog("INFO", `Game process terminated (code: ${code})`);
});

// Auth & Profile Management
function updateUserUI(user) {
  currentUser = user;
  const authButtons = document.getElementById("auth-buttons");

  if (user) {
    authButtons?.classList.add("hidden");
    userCard.classList.remove("hidden");
    userName.innerText = user.minecraftUsername || user.name || user.discordTag || "Player";
    userRole.innerText = user.isTech ? "Tech Staff" : user.isAdmin ? "Admin" : "Online MSA";
    userAvatar.innerText = (user.minecraftUsername || user.name || "U")[0].toUpperCase();

    // Channel gating
    const allowed = user.allowedChannels || ["stable"];
    channelBtns.forEach((btn) => {
      const ch = btn.dataset.channel;
      btn.disabled = !allowed.includes(ch);
    });
  } else {
    authButtons?.classList.remove("hidden");
    userCard.classList.add("hidden");
    channelBtns.forEach((btn) => {
      btn.disabled = btn.dataset.channel !== "stable";
    });
  }
}

// Portal OAuth Login
btnLogin.onclick = async () => {
  try {
    btnLogin.disabled = true;
    btnLogin.innerText = "Authorizing...";
    const res = await window.lampas.auth.login(currentConfig?.portalUrl);
    updateUserUI(res.user);
  } catch (err) {
    alert(`Login failed: ${err.message}`);
  } finally {
    btnLogin.disabled = false;
    btnLogin.innerText = "Log In with Portal";
  }
};

// Microsoft Account (MSA) Device Code Login
window.lampas.msa.onPrompt((prompt) => {
  currentMsaPrompt = prompt;
  msaCodeDisplay.innerText = prompt.userCode;
  modalMsa.classList.remove("hidden");
});

btnCopyMsaCode.onclick = () => {
  if (currentMsaPrompt?.userCode) {
    navigator.clipboard.writeText(currentMsaPrompt.userCode);
    btnCopyMsaCode.innerText = "✓ Copied!";
    setTimeout(() => {
      btnCopyMsaCode.innerText = "Copy Code";
    }, 2000);
  }
};

btnOpenMsaUrl.onclick = () => {
  if (currentMsaPrompt?.verificationUri) {
    window.open(currentMsaPrompt.verificationUri, "_blank");
  }
};

btnCloseMsa.onclick = () => {
  modalMsa.classList.add("hidden");
};

btnMsaLogin.onclick = async () => {
  try {
    btnMsaLogin.disabled = true;
    btnMsaLogin.innerText = "Waiting for Code...";
    const account = await window.lampas.msa.login();
    modalMsa.classList.add("hidden");

    updateUserUI({
      name: account.username,
      minecraftUsername: account.username,
      minecraftUuid: account.uuid,
      allowedChannels: ["stable", "beta", "dev"],
    });

    appendLog("INFO", `Logged into Microsoft Account: ${account.username} (${account.uuid})`);
  } catch (err) {
    modalMsa.classList.add("hidden");
    alert(`Microsoft Login Failed: ${err.message}`);
  } finally {
    btnMsaLogin.disabled = false;
    btnMsaLogin.innerText = "Microsoft Account (MSA)";
  }
};

btnLogout.onclick = async () => {
  await window.lampas.auth.logout();
  updateUserUI(null);
};

// Channel Switching
channelBtns.forEach((btn) => {
  btn.onclick = async () => {
    if (btn.disabled) return;
    channelBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const channel = btn.dataset.channel;
    await window.lampas.config.set({ selectedChannel: channel });
  };
});

// Sync & Play Flow
btnPlay.onclick = async () => {
  if (isLaunching) return;

  try {
    isLaunching = true;
    btnPlay.disabled = true;
    btnPlayText.innerText = "CHECKING...";
    progressContainer.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressPercent.innerText = "0%";
    progressMsg.innerText = "Connecting to pipeline...";

    // Listen to sync progress
    const removeListener = window.lampas.sync.onProgress((progress) => {
      progressFill.style.width = `${progress.percent}%`;
      progressPercent.innerText = `${progress.percent}%`;
      progressMsg.innerText = progress.message;
      if (progress.status === "downloading") {
        btnPlayText.innerText = "DOWNLOADING...";
      } else if (progress.status === "staging") {
        btnPlayText.innerText = "STAGING...";
      }
    });

    const syncResult = await window.lampas.sync.start();
    removeListener();

    btnPlayText.innerText = "LAUNCHING...";
    progressMsg.innerText = "Starting Minecraft JVM...";
    progressFill.style.width = "100%";

    appendLog("INFO", `Pack v${syncResult.version} synchronized. Spawning JVM...`);
    await window.lampas.game.launch(currentUser);

    btnPlayText.innerText = "RUNNING";
  } catch (err) {
    isLaunching = false;
    btnPlay.disabled = false;
    btnPlayText.innerText = "PLAY";
    progressContainer.classList.add("hidden");
    alert(`Launch Error: ${err.message}`);
    appendLog("ERROR", err.message);
  }
};

// Initialize on Load
async function init() {
  currentConfig = await window.lampas.config.get();

  // Populate settings
  ramSlider.value = currentConfig.allocatedRamGb || 4;
  ramDisplay.innerText = `${ramSlider.value} GB RAM`;
  settingPortal.value = currentConfig.portalUrl || "http://localhost:3000";

  // Select active channel
  const selChannel = currentConfig.selectedChannel || "stable";
  channelBtns.forEach((btn) => {
    if (btn.dataset.channel === selChannel) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Verify portal session or offline profile
  try {
    const authCheck = await window.lampas.auth.verify(currentConfig.portalUrl);
    if (authCheck.valid && authCheck.user) {
      updateUserUI(authCheck.user);
    } else if (currentConfig.offlineUsername) {
      updateUserUI({
        name: currentConfig.offlineUsername,
        minecraftUsername: currentConfig.offlineUsername,
        allowedChannels: ["stable"],
      });
    } else {
      updateUserUI(null);
    }
  } catch {
    if (currentConfig.offlineUsername) {
      updateUserUI({
        name: currentConfig.offlineUsername,
        minecraftUsername: currentConfig.offlineUsername,
        allowedChannels: ["stable"],
      });
    } else {
      updateUserUI(null);
    }
  }
}

init();
