const $ = (selector) => document.querySelector(selector);
const setupView = $("#setup-view");
const sessionView = $("#session-view");
const completeView = $("#complete-view");
const liveStatus = $("#live-status");
const guideLine = $("#guide-line");
const visualField = $("#visual-field");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const focusNames = { settle: "Settle", focus: "Focus", imagine: "Imagine" };
const sceneNames = { settle: "Still water", focus: "A clear horizon", imagine: "An open landscape" };
const focusColors = {
  settle: ["#10131b", "#24223a", "#d4c8ff"],
  focus: ["#101720", "#20323d", "#b7d7e8"],
  imagine: ["#19131e", "#38263d", "#e2b8db"]
};
const sessionState = {
  active: false,
  paused: false,
  focus: "settle",
  minutes: 5,
  lines: [],
  lineIndex: 0,
  durationMs: 0,
  elapsedMs: 0,
  segmentStartedAt: 0,
  nextTimer: null,
  nextDeadline: 0,
  nextRemaining: 0,
  clockTimer: null,
  guideUsesVoice: false,
  startedAt: 0
};

let audioContext = null;
let audioMaster = null;
let audioNodes = [];
let deferredInstallPrompt = null;
let animationFrame = null;
let previousFrameTime = 0;
let visualElapsed = 0;
const appleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installedApp = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function announce(message) {
  liveStatus.textContent = "";
  window.setTimeout(() => { liveStatus.textContent = message; }, 30);
}

function setFocus(focus) {
  sessionState.focus = focus;
  document.querySelectorAll(".intention-option").forEach((button) => {
    const selected = button.dataset.focus === focus;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  visualField.dataset.focus = focus;
  $("#scene-name").textContent = sceneNames[focus];
}

function setDuration(minutes) {
  sessionState.minutes = minutes;
  document.querySelectorAll(".duration-option").forEach((button) => {
    const selected = Number(button.dataset.minutes) === minutes;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function makeGuideLines(focus, theme) {
  const direction = theme ? ` If you like, let the idea of ${theme} rest nearby.` : "";
  const sharedOpening = [
    "Take a moment to arrive. Nothing needs to happen all at once.",
    "Notice the support beneath you, and let your attention settle where it wants to.",
    "Each breath can be just a breath. There is no special way to do this.",
    "You can listen to every word, or let some of them drift past. Both are fine."
  ];
  const directions = {
    settle: [
      "Let the edges of the room be there without needing to follow them.",
      "Imagine a quiet surface of water, changing only as much as it wants to.",
      "With each pause, make a little more room around the next thought.",
      "Nothing needs to be pushed away. You can notice, and then choose where to rest.",
      "Perhaps the quiet is not somewhere else. Perhaps it is a small space you can return to.",
      "Let the next few moments be unhurried, just as they are."
    ],
    focus: [
      "Let one detail in the scene become clear, while everything else can soften around it.",
      "Choose a point of attention. You can stay with it, or change your mind.",
      "Notice how attention can gather without becoming tense.",
      "A thought may arrive, and you can decide whether to follow it.",
      "Return to the detail you chose, or choose another one now.",
      "Let clarity mean simply seeing what is here, one thing at a time."
    ],
    imagine: [
      "Let a landscape begin to form, or let it remain only a suggestion.",
      "Perhaps there is a path, a color, or the feeling of open space.",
      "The scene can change whenever you want it to. You are the one imagining it.",
      "Notice what stands out, without needing to decide what it means.",
      "You might add one small detail, or leave the whole scene beautifully unfinished.",
      "The imagination can wander, and you can return to the room whenever you choose."
    ]
  };
  const closing = [
    "Let the scene become a little less important now, if that feels right.",
    "Notice the room around you again, at whatever pace feels comfortable.",
    "You can move, stretch, or simply take another moment before you continue."
  ];
  const chosen = directions[focus].map((line, index) => index === 1 ? `${line}${direction}` : line);
  return [...sharedOpening, ...chosen, ...closing];
}

function setViews(view) {
  setupView.hidden = view !== "setup";
  sessionView.hidden = view !== "session";
  completeView.hidden = view !== "complete";
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsedTime() {
  if (!sessionState.active) return sessionState.elapsedMs;
  if (sessionState.paused) return sessionState.elapsedMs;
  return sessionState.elapsedMs + (performance.now() - sessionState.segmentStartedAt);
}

function updateClock() {
  if (!sessionState.active) return;
  const elapsed = elapsedTime();
  const remaining = Math.max(0, sessionState.durationMs - elapsed);
  $("#scene-clock").textContent = formatTime(remaining);
  $("#progress-bar").style.width = `${Math.min(100, (elapsed / sessionState.durationMs) * 100)}%`;
  if (remaining <= 0) finishSession();
}

function estimatedSpeechTime(lines) {
  const words = lines.reduce((total, line) => total + line.trim().split(/\s+/).length, 0);
  return words * (60 / 135) * 1000;
}

function scheduleNextLine() {
  if (!sessionState.active || sessionState.paused || sessionState.lineIndex >= sessionState.lines.length) {
    if (sessionState.active && sessionState.lineIndex >= sessionState.lines.length) {
      guideLine.textContent = "Let the words settle, or simply stay with the scene for a while.";
    }
    return;
  }
  const linesLeft = sessionState.lines.length - sessionState.lineIndex;
  const estimatedTalk = estimatedSpeechTime(sessionState.lines);
  const pauseMs = Math.max(6500, Math.min(35000, (sessionState.durationMs - estimatedTalk) / Math.max(1, sessionState.lines.length - 1)));
  sessionState.nextRemaining = pauseMs;
  sessionState.nextDeadline = Date.now() + pauseMs;
  sessionState.nextTimer = window.setTimeout(() => {
    sessionState.nextTimer = null;
    sessionState.nextRemaining = 0;
    speakNextLine();
  }, pauseMs);
  if (linesLeft === 0) sessionState.nextRemaining = 0;
}

function speakNextLine() {
  if (!sessionState.active || sessionState.paused) return;
  if (sessionState.lineIndex >= sessionState.lines.length) {
    guideLine.textContent = "Let the words settle, or simply stay with the scene for a while.";
    return;
  }
  const line = sessionState.lines[sessionState.lineIndex++];
  guideLine.textContent = line;

  if (sessionState.guideUsesVoice && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
    const utterance = new SpeechSynthesisUtterance(line);
    utterance.rate = 0.82;
    utterance.pitch = 0.92;
    utterance.volume = 0.9;
    utterance.onend = scheduleNextLine;
    utterance.onerror = (event) => {
      if (!sessionState.active || sessionState.paused || event.error === "canceled" || event.error === "interrupted") return;
      sessionState.guideUsesVoice = false;
      announce("Spoken guidance is unavailable; the session will continue as text.");
      scheduleNextLine();
    };
    window.speechSynthesis.speak(utterance);
  } else {
    scheduleNextLine();
  }
}

async function startAmbience() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    announce("This browser does not support generated ambience. Spoken guidance can still continue.");
    return;
  }
  try {
    audioContext = new AudioContextClass();
    await audioContext.resume();
    audioMaster = audioContext.createGain();
    audioMaster.gain.setValueAtTime(0.0001, audioContext.currentTime);
    audioMaster.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 2.4);
    audioMaster.connect(audioContext.destination);

    const lowTone = audioContext.createOscillator();
    lowTone.type = "sine";
    lowTone.frequency.value = 110;
    const lowGain = audioContext.createGain();
    lowGain.gain.value = 0.44;
    lowTone.connect(lowGain).connect(audioMaster);
    lowTone.start();

    const highTone = audioContext.createOscillator();
    highTone.type = "sine";
    highTone.frequency.value = 164.81;
    const highGain = audioContext.createGain();
    highGain.gain.value = 0.18;
    highTone.connect(highGain).connect(audioMaster);
    highTone.start();
    audioNodes = [lowTone, highTone];
  } catch {
    announce("Generated ambience could not start; the guided session will continue.");
  }
}

function setAmbiencePaused(paused) {
  if (!audioContext || !audioMaster) return;
  const target = paused ? 0.0001 : 0.045;
  audioMaster.gain.cancelScheduledValues(audioContext.currentTime);
  audioMaster.gain.setTargetAtTime(target, audioContext.currentTime, paused ? 0.16 : 0.65);
  if (!paused && audioContext.state === "suspended") audioContext.resume().catch(() => {});
}

function stopAmbience() {
  if (!audioContext) return;
  const context = audioContext;
  const master = audioMaster;
  const nodes = audioNodes;
  audioContext = null;
  audioMaster = null;
  audioNodes = [];
  try {
    master?.gain.cancelScheduledValues(context.currentTime);
    master?.gain.setTargetAtTime(0.0001, context.currentTime, 0.12);
    window.setTimeout(() => {
      nodes.forEach((node) => { try { node.stop(); } catch {} });
      context.close().catch(() => {});
    }, 500);
  } catch {
    context.close().catch(() => {});
  }
}

async function beginSession(event) {
  event.preventDefault();
  const theme = $("#intention").value.trim().replace(/[.!?]+$/, "");
  sessionState.lines = makeGuideLines(sessionState.focus, theme);
  sessionState.lineIndex = 0;
  sessionState.durationMs = sessionState.minutes * 60 * 1000;
  sessionState.elapsedMs = 0;
  sessionState.segmentStartedAt = performance.now();
  sessionState.startedAt = Date.now();
  sessionState.active = true;
  sessionState.paused = false;
  sessionState.nextTimer = null;
  sessionState.nextRemaining = 0;
  sessionState.guideUsesVoice = $("#voice-enabled").checked && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  $("#session-theme").textContent = theme ? `with ${theme}.` : `${focusNames[sessionState.focus].toLowerCase()}, at your pace.`;
  $("#scene-clock").textContent = formatTime(sessionState.durationMs);
  $("#progress-bar").style.width = "0%";
  $("#pause-session").innerHTML = '<span aria-hidden="true">Ⅱ</span> Pause';
  $("#vr-toggle").setAttribute("aria-pressed", "false");
  $("#vr-toggle").innerHTML = '<span aria-hidden="true">◉</span> Cardboard view';
  sessionView.classList.remove("vr-mode");
  setViews("session");
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
  updateClock();
  sessionState.clockTimer = window.setInterval(updateClock, 250);

  if ($("#sound-enabled").checked) await startAmbience();
  if (!sessionState.active) return;
  if (!sessionState.guideUsesVoice && $("#voice-enabled").checked) {
    announce("Spoken guidance is not available in this browser; the session will continue as text.");
  }
  if (sessionState.guideUsesVoice) window.speechSynthesis.cancel();
  speakNextLine();
  beginVisuals();
}

function pauseSession() {
  if (!sessionState.active || sessionState.paused) return;
  sessionState.elapsedMs += performance.now() - sessionState.segmentStartedAt;
  sessionState.paused = true;
  if (sessionState.nextTimer) {
    sessionState.nextRemaining = Math.max(0, sessionState.nextDeadline - Date.now());
    window.clearTimeout(sessionState.nextTimer);
    sessionState.nextTimer = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.pause();
  setAmbiencePaused(true);
  $("#pause-session").innerHTML = '<span aria-hidden="true">▶</span> Resume';
  announce("Session paused. Resume when you are ready.");
}

function resumeSession() {
  if (!sessionState.active || !sessionState.paused) return;
  sessionState.paused = false;
  sessionState.segmentStartedAt = performance.now();
  if ("speechSynthesis" in window) window.speechSynthesis.resume();
  setAmbiencePaused(false);
  $("#pause-session").innerHTML = '<span aria-hidden="true">Ⅱ</span> Pause';
  if (sessionState.nextRemaining > 0 && sessionState.lineIndex < sessionState.lines.length) {
    sessionState.nextDeadline = Date.now() + sessionState.nextRemaining;
    sessionState.nextTimer = window.setTimeout(() => {
      sessionState.nextTimer = null;
      sessionState.nextRemaining = 0;
      speakNextLine();
    }, sessionState.nextRemaining);
  }
  announce("Session resumed.");
}

function cleanSession() {
  sessionState.active = false;
  sessionState.paused = false;
  if (sessionState.nextTimer) window.clearTimeout(sessionState.nextTimer);
  if (sessionState.clockTimer) window.clearInterval(sessionState.clockTimer);
  sessionState.nextTimer = null;
  sessionState.clockTimer = null;
  sessionState.nextRemaining = 0;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  stopAmbience();
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  animationFrame = null;
}

function finishSession() {
  if (!sessionState.active) return;
  cleanSession();
  setViews("complete");
  announce("Session complete. Take your time coming back.");
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
}

function endSession() {
  if (!sessionState.active) return;
  cleanSession();
  setViews("setup");
  announce("Session ended. Your choices were not saved.");
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
}

function drawScene(canvas, elapsed, eyeOffset = 0) {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  const pixelWidth = Math.round(bounds.width * ratio);
  const pixelHeight = Math.round(bounds.height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  const colors = focusColors[sessionState.focus];
  const motion = reducedMotion.matches ? 0 : elapsed;
  const centerX = width * (0.5 + eyeOffset);
  const centerY = height * (0.48 + Math.sin(motion * 0.17) * 0.015);
  const breathing = reducedMotion.matches ? 0.5 : 0.5 + Math.sin(motion * 0.24) * 0.035;

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, colors[0]);
  background.addColorStop(0.58, colors[1]);
  background.addColorStop(1, "#11151f");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const glow = context.createRadialGradient(centerX, centerY, 2, centerX, centerY, Math.max(width, height) * 0.53);
  glow.addColorStop(0, `rgba(${focusColors[sessionState.focus] === focusColors.settle ? "187, 169, 232" : sessionState.focus === "focus" ? "137, 187, 212" : "207, 157, 204"}, ${0.13 + breathing * 0.08})`);
  glow.addColorStop(1, "rgba(16, 19, 27, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.lineWidth = 1;
  for (let index = 0; index < 6; index += 1) {
    const scale = 0.2 + index * 0.13 + breathing * 0.035;
    context.beginPath();
    context.ellipse(centerX, centerY, width * scale, height * scale * 0.56, (index - 2.5) * 0.075, 0, Math.PI * 2);
    context.strokeStyle = `rgba(226, 217, 255, ${0.035 + (5 - index) * 0.012})`;
    context.stroke();
  }

  const coreRadius = Math.min(width, height) * (0.025 + breathing * 0.012);
  const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreRadius * 6);
  core.addColorStop(0, "rgba(246, 240, 255, .85)");
  core.addColorStop(0.18, "rgba(212, 200, 255, .34)");
  core.addColorStop(1, "rgba(169, 155, 221, 0)");
  context.fillStyle = core;
  context.beginPath();
  context.arc(centerX, centerY, coreRadius * 6, 0, Math.PI * 2);
  context.fill();
}

function beginVisuals() {
  if (animationFrame) window.cancelAnimationFrame(animationFrame);
  previousFrameTime = 0;
  const render = (timestamp) => {
    if (!sessionState.active) return;
    if (previousFrameTime && !sessionState.paused && !reducedMotion.matches) {
      visualElapsed += Math.min(80, timestamp - previousFrameTime) / 1000;
    }
    previousFrameTime = timestamp;
    drawScene($("#visual-canvas"), visualElapsed);
    drawScene($("#left-eye"), visualElapsed, -0.018);
    drawScene($("#right-eye"), visualElapsed, 0.018);
    animationFrame = window.requestAnimationFrame(render);
  };
  animationFrame = window.requestAnimationFrame(render);
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  $("#network-label").textContent = online ? "On-device prototype" : "Offline · ready";
  $("#offline-note").textContent = online ? "Session choices stay on this device" : "Offline and ready to use";
}

document.querySelectorAll(".intention-option").forEach((button) => {
  button.addEventListener("click", () => setFocus(button.dataset.focus));
});
document.querySelectorAll(".duration-option").forEach((button) => {
  button.addEventListener("click", () => setDuration(Number(button.dataset.minutes)));
});
$("#session-form").addEventListener("submit", beginSession);
$("#pause-session").addEventListener("click", () => sessionState.paused ? resumeSession() : pauseSession());
$("#end-session").addEventListener("click", endSession);
$("#new-session").addEventListener("click", () => {
  setViews("setup");
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
});
$("#vr-toggle").addEventListener("click", () => {
  const active = sessionView.classList.toggle("vr-mode");
  $("#vr-toggle").setAttribute("aria-pressed", String(active));
  $("#vr-toggle").innerHTML = active ? '<span aria-hidden="true">◉</span> Exit Cardboard view' : '<span aria-hidden="true">◉</span> Cardboard view';
  announce(active ? "Split view enabled for a phone-based viewer." : "Split view disabled.");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && sessionState.active && !sessionState.paused) pauseSession();
});
window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
updateNetworkStatus();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("#install-app").hidden = false;
});
$("#install-app").addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#install-app").hidden = true;
    return;
  }
  if (appleMobile) $("#install-help").showModal();
});
window.addEventListener("appinstalled", () => {
  $("#install-app").hidden = true;
  announce("Hypno is installed.");
});
if (appleMobile && !installedApp) {
  $("#install-app").hidden = false;
  $("#install-app").textContent = "Add to Home Screen";
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      $("#network-label").textContent = "Online · offline setup unavailable";
    });
  });
}
