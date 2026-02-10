"use strict";

/* Bullfrog Which Knob Moved
 *
 * Two takes (A then B) of the same synth patch; exactly one knob differs between takes.
 * Web Audio only (no samples, no frameworks).
 */

// All tunables live here.
const SETTINGS = {
  DEBUG_SHOW_ANSWER: false,
  DEBUG_LOG_ROUNDS: false,

  ROUNDS_PER_GAME: 10,
  FEEDBACK_ADVANCE_MS: 900,

  TAKE_SECONDS: 2.0,
  SILENCE_GAP_SECONDS: 0.25,
  LOOP_CYCLE_PAUSE_SECONDS: 0.35,
  TAKE_FADE_SECONDS: 0.02,
  SCHEDULING_LEAD_SECONDS: 0.05,
  TAKE_CLEANUP_EXTRA_SECONDS: 0.15,

  // "Bullfrog like" synth voice.
  OSC_TYPE: "sawtooth",
  NOTE_FREQUENCIES_HZ: [98.0, 110.0, 130.81, 146.83, 164.81], // G2, A2, C3, D3, E3
  NOTE_TIMES_SECONDS: [0.0, 0.33, 0.66, 1.0, 1.33, 1.66], // 6 hits over 2 seconds

  // Amp envelope: A=5ms, D=DECAY knob, S=0, R=50ms.
  AMP_ATTACK_SECONDS: 0.005,
  AMP_RELEASE_SECONDS: 0.05,

  // Filter envelope: A=5ms, D=DECAY knob, fixed amount.
  FILTER_ENV_ATTACK_SECONDS: 0.005,
  // Keep this modest so the base cutoff knob stays audible during the transient.
  FILTER_ENV_AMOUNT_HZ: 500,
  FILTER_STACK_SIZE: 2,
  FILTER_STACK_Q2: 0.707,

  // Loudness control.
  MASTER_GAIN: 0.85,
  VOICE_PEAK_GAIN: 0.11,
  USE_LIMITER: true,
  LIMITER_THRESHOLD_DB: -12,
  LIMITER_KNEE_DB: 18,
  LIMITER_RATIO: 12,
  LIMITER_ATTACK_SECONDS: 0.003,
  LIMITER_RELEASE_SECONDS: 0.11,

  // Knobs and ranges.
  CUTOFF_BASE_HZ_MIN: 250,
  CUTOFF_BASE_HZ_MAX: 2500,
  // More drastic than the original spec, per request.
  CUTOFF_CHANGE_MULTIPLIERS: [2.6, 0.38],
  // >1 biases the random cutoff towards the low end (easier for beginners to hear).
  CUTOFF_BASE_LOG_SKEW: 1.8,

  RESONANCE_BASE_Q_MIN: 0.5,
  RESONANCE_BASE_Q_MAX: 8.0,
  RESONANCE_CHANGE_DELTA_Q: 2.0,
  RESONANCE_Q_MIN: 0.5,
  RESONANCE_Q_MAX: 12.0,

  DECAY_BASE_MS_MIN: 120,
  DECAY_BASE_MS_MAX: 1200,
  DECAY_CHANGE_MULTIPLIERS: [1.6, 0.6],
  DECAY_MS_MIN: 80,
  DECAY_MS_MAX: 2000,
};

const KNOBS = [
  { id: "cutoff", label: "Cutoff" },
  { id: "resonance", label: "Resonance" },
  { id: "decay", label: "Decay" },
];
const KNOB_BY_ID = Object.fromEntries(KNOBS.map((k) => [k.id, k]));

const PARAM_EPS = 1e-9;

const PHASE_A = "a";
const PHASE_GAP = "gap";
const PHASE_B = "b";
const PHASE_ANSWER = "answer";

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

function randLogFloat(min, max) {
  const safeMin = Math.max(1e-6, min);
  const safeMax = Math.max(safeMin * 1.000001, max);
  const u = Math.random();
  return safeMin * Math.exp(Math.log(safeMax / safeMin) * u);
}

function randLogFloatSkew(min, max, skewPower) {
  const safeSkew = Math.max(0.05, Number.isFinite(skewPower) ? skewPower : 1.0);
  const u = Math.pow(Math.random(), safeSkew);
  const safeMin = Math.max(1e-6, min);
  const safeMax = Math.max(safeMin * 1.000001, max);
  return safeMin * Math.exp(Math.log(safeMax / safeMin) * u);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nearEqual(a, b, eps = PARAM_EPS) {
  return Math.abs(a - b) <= eps;
}

function formatKnob(id) {
  return (KNOB_BY_ID[id] && KNOB_BY_ID[id].label) || id;
}

function msToSec(ms) {
  return ms / 1000;
}

// (1) Audio engine + envelope scheduling.
function createAudioEngine(ctx) {
  const masterGain = ctx.createGain();
  masterGain.gain.value = SETTINGS.MASTER_GAIN;

  let limiter = null;
  if (SETTINGS.USE_LIMITER) {
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = SETTINGS.LIMITER_THRESHOLD_DB;
    limiter.knee.value = SETTINGS.LIMITER_KNEE_DB;
    limiter.ratio.value = SETTINGS.LIMITER_RATIO;
    limiter.attack.value = SETTINGS.LIMITER_ATTACK_SECONDS;
    limiter.release.value = SETTINGS.LIMITER_RELEASE_SECONDS;
    masterGain.connect(limiter);
    limiter.connect(ctx.destination);
  } else {
    masterGain.connect(ctx.destination);
  }

  return { ctx, masterGain, limiter };
}

function scheduleTakeFade(gainParam, startTime, durationSeconds) {
  const fade = clamp(SETTINGS.TAKE_FADE_SECONDS, 0.001, durationSeconds / 2);
  const endTime = startTime + durationSeconds;
  const fadeOutStart = endTime - fade;

  gainParam.cancelScheduledValues(startTime);
  gainParam.setValueAtTime(0.0, startTime);
  gainParam.linearRampToValueAtTime(1.0, startTime + fade);
  gainParam.setValueAtTime(1.0, fadeOutStart);
  gainParam.linearRampToValueAtTime(0.0, endTime);
}

function scheduleVoice(ctx, destination, params, noteStartTime, hardStopTime) {
  const osc = ctx.createOscillator();
  osc.type = SETTINGS.OSC_TYPE;
  osc.frequency.setValueAtTime(params.noteFreqHz, noteStartTime);

  const stackSize = clamp(Math.floor(SETTINGS.FILTER_STACK_SIZE || 1), 1, 4);
  const filters = [];
  for (let i = 0; i < stackSize; i += 1) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    const q = i === 0 ? params.resonanceQ : SETTINGS.FILTER_STACK_Q2;
    f.Q.setValueAtTime(q, noteStartTime);
    filters.push(f);
  }

  const noteGain = ctx.createGain();
  noteGain.gain.setValueAtTime(0.0, noteStartTime);

  osc.connect(filters[0]);
  for (let i = 0; i < filters.length - 1; i += 1) {
    filters[i].connect(filters[i + 1]);
  }
  filters[filters.length - 1].connect(noteGain);
  noteGain.connect(destination);

  const attack = SETTINGS.AMP_ATTACK_SECONDS;
  const release = SETTINGS.AMP_RELEASE_SECONDS;
  const decay = msToSec(params.decayMs);
  const nearZero = 0.0001;

  // Amp envelope: A=5ms, D=DECAY, S=0, R=50ms.
  noteGain.gain.setValueAtTime(0.0, noteStartTime);
  noteGain.gain.linearRampToValueAtTime(SETTINGS.VOICE_PEAK_GAIN, noteStartTime + attack);
  noteGain.gain.linearRampToValueAtTime(nearZero, noteStartTime + attack + decay);
  noteGain.gain.linearRampToValueAtTime(0.0, noteStartTime + attack + decay + release);

  // Filter envelope: A=5ms, D=DECAY, fixed amount.
  const baseCutoff = clamp(params.cutoffHz, 20, 20000);
  const envPeak = clamp(baseCutoff + SETTINGS.FILTER_ENV_AMOUNT_HZ, 20, 20000);
  for (const f of filters) {
    f.frequency.setValueAtTime(baseCutoff, noteStartTime);
    // Exponential ramps sound more natural for frequency sweeps.
    f.frequency.exponentialRampToValueAtTime(envPeak, noteStartTime + SETTINGS.FILTER_ENV_ATTACK_SECONDS);
    f.frequency.exponentialRampToValueAtTime(baseCutoff, noteStartTime + SETTINGS.FILTER_ENV_ATTACK_SECONDS + decay);
  }

  const naturalEndTime = noteStartTime + attack + decay + release;
  const stopAt = Math.max(noteStartTime + 0.01, Math.min(naturalEndTime, hardStopTime));

  osc.start(noteStartTime);
  osc.stop(stopAt);

  osc.onended = () => {
    try {
      osc.disconnect();
    } catch (_error) {}
    for (const f of filters) {
      try {
        f.disconnect();
      } catch (_error) {}
    }
    try {
      noteGain.disconnect();
    } catch (_error) {}
  };
}

// (2) playTake(params, when): schedules one 2.0s take with fades and repeated "croak" hits.
function playTake(engine, params, when, destination) {
  const { ctx, masterGain } = engine;
  const out = destination || masterGain;

  const takeGain = ctx.createGain();
  takeGain.connect(out);

  scheduleTakeFade(takeGain.gain, when, SETTINGS.TAKE_SECONDS);

  const hardStopTime = when + SETTINGS.TAKE_SECONDS + SETTINGS.TAKE_CLEANUP_EXTRA_SECONDS;
  for (const t of SETTINGS.NOTE_TIMES_SECONDS) {
    scheduleVoice(ctx, takeGain, params, when + t, hardStopTime);
  }

  const cleanupAt = hardStopTime;
  const cleanupMs = Math.max(0, (cleanupAt - ctx.currentTime) * 1000);
  window.setTimeout(() => {
    try {
      takeGain.disconnect();
    } catch (_error) {}
  }, cleanupMs);

  return when + SETTINGS.TAKE_SECONDS;
}

function playRound(engine, round, when, destination) {
  const aStart = when;
  const aEnd = playTake(engine, round.takeA, aStart, destination);
  const bStart = aEnd + SETTINGS.SILENCE_GAP_SECONDS;
  const bEnd = playTake(engine, round.takeB, bStart, destination);
  return { aStart, aEnd, bStart, bEnd, endAt: bEnd };
}

// (3) Round generator + validation.
function generateRounds() {
  const rounds = [];

  // Each knob appears at least 3 times across 10 rounds: 3 + 3 + 3 + 1 = 10.
  const knobBag = [];
  for (const k of KNOBS) {
    for (let i = 0; i < 3; i += 1) knobBag.push(k.id);
  }
  knobBag.push(pick(KNOBS).id);
  const changedKnobs = shuffle(knobBag);

  for (let i = 0; i < SETTINGS.ROUNDS_PER_GAME; i += 1) {
    const changedKnob = changedKnobs[i];

    const base = {
      cutoffHz: randLogFloatSkew(
        SETTINGS.CUTOFF_BASE_HZ_MIN,
        SETTINGS.CUTOFF_BASE_HZ_MAX,
        SETTINGS.CUTOFF_BASE_LOG_SKEW,
      ),
      resonanceQ: randFloat(SETTINGS.RESONANCE_BASE_Q_MIN, SETTINGS.RESONANCE_BASE_Q_MAX),
      decayMs: randFloat(SETTINGS.DECAY_BASE_MS_MIN, SETTINGS.DECAY_BASE_MS_MAX),
      noteFreqHz: pick(SETTINGS.NOTE_FREQUENCIES_HZ),
    };

    const takeA = { ...base };
    const takeB = { ...base };

    if (changedKnob === "cutoff") {
      takeB.cutoffHz = takeA.cutoffHz * pick(SETTINGS.CUTOFF_CHANGE_MULTIPLIERS);
    } else if (changedKnob === "resonance") {
      const sign = Math.random() < 0.5 ? -1 : 1;
      takeB.resonanceQ = clamp(
        takeA.resonanceQ + sign * SETTINGS.RESONANCE_CHANGE_DELTA_Q,
        SETTINGS.RESONANCE_Q_MIN,
        SETTINGS.RESONANCE_Q_MAX,
      );
    } else if (changedKnob === "decay") {
      takeB.decayMs = clamp(
        takeA.decayMs * pick(SETTINGS.DECAY_CHANGE_MULTIPLIERS),
        SETTINGS.DECAY_MS_MIN,
        SETTINGS.DECAY_MS_MAX,
      );
    } else {
      throw new Error(`Unknown knob id: ${changedKnob}`);
    }

    rounds.push({ index: i, changedKnob, takeA, takeB });
  }

  return rounds;
}

function validateRounds(rounds) {
  const errors = [];
  if (!Array.isArray(rounds)) errors.push("Rounds is not an array.");
  if (rounds.length !== SETTINGS.ROUNDS_PER_GAME) errors.push(`Expected ${SETTINGS.ROUNDS_PER_GAME} rounds.`);

  const counts = Object.fromEntries(KNOBS.map((k) => [k.id, 0]));

  for (const r of rounds) {
    counts[r.changedKnob] = (counts[r.changedKnob] || 0) + 1;

    const a = r.takeA;
    const b = r.takeB;
    const diffs = [];

    if (!nearEqual(a.noteFreqHz, b.noteFreqHz)) errors.push(`Round ${r.index + 1}: noteFreq differs (not allowed).`);
    if (!nearEqual(a.cutoffHz, b.cutoffHz)) diffs.push("cutoff");
    if (!nearEqual(a.resonanceQ, b.resonanceQ)) diffs.push("resonance");
    if (!nearEqual(a.decayMs, b.decayMs)) diffs.push("decay");

    if (diffs.length !== 1) {
      errors.push(`Round ${r.index + 1}: expected 1 knob change, got ${diffs.length} (${diffs.join(", ") || "none"}).`);
    } else if (diffs[0] !== r.changedKnob) {
      errors.push(`Round ${r.index + 1}: changedKnob says "${r.changedKnob}" but diff is "${diffs[0]}".`);
    }
  }

  for (const k of KNOBS) {
    if ((counts[k.id] || 0) < 3) errors.push(`Knob "${k.id}" appears ${(counts[k.id] || 0)} times (< 3).`);
  }

  return { ok: errors.length === 0, errors, counts };
}

function bullfrogSelfTest(rounds) {
  const { ok, errors, counts } = validateRounds(rounds);
  const dist = KNOBS.map((k) => `${k.id}=${counts[k.id] || 0}`).join(" ");
  console.log("[Bullfrog self-test] rounds=%d distribution=%s", rounds.length, dist);
  if (!ok) {
    console.error("[Bullfrog self-test] FAILED:");
    for (const e of errors) console.error(" -", e);
    return false;
  }
  console.log("[Bullfrog self-test] OK");
  return true;
}

window.bullfrogSelfTest = bullfrogSelfTest;

// (4) UI + state machine.
const state = {
  audioContext: null,
  engine: null,
  rounds: [],
  currentIndex: 0,
  score: 0,
  answered: false,
  results: [],
  playbackToken: 0,
  moveNextTimer: null,
  phaseTimers: [],
  roundOutput: null,
  loopNextAt: 0,
};

const dom = {
  startScreen: document.getElementById("start-screen"),
  quizScreen: document.getElementById("quiz-screen"),
  resultScreen: document.getElementById("result-screen"),
  startButton: document.getElementById("start-button"),
  restartButton: document.getElementById("restart-button"),
  progress: document.getElementById("progress"),
  liveScore: document.getElementById("live-score"),
  loopStatus: document.getElementById("loop-status"),
  eqOffIndicator: document.getElementById("eq-off-indicator"),
  eqOnIndicator: document.getElementById("eq-on-indicator"),
  prompt: document.getElementById("prompt"),
  debugAnswer: document.getElementById("debug-answer"),
  options: document.getElementById("options"),
  feedback: document.getElementById("feedback"),
  score: document.getElementById("score"),
  review: document.getElementById("review"),
};

function showScreen(name) {
  dom.startScreen.classList.toggle("hidden", name !== "start");
  dom.quizScreen.classList.toggle("hidden", name !== "quiz");
  dom.resultScreen.classList.toggle("hidden", name !== "result");
}

function clearTimers() {
  if (state.moveNextTimer) {
    window.clearTimeout(state.moveNextTimer);
    state.moveNextTimer = null;
  }
  clearPhaseTimers();
}

function clearPhaseTimers() {
  for (const t of state.phaseTimers) window.clearTimeout(t);
  state.phaseTimers = [];
}

function scheduleUi(token, delaySeconds, fn) {
  const id = window.setTimeout(() => {
    if (token !== state.playbackToken) return;
    fn();
  }, Math.max(0, delaySeconds * 1000));
  state.phaseTimers.push(id);
}

function setPhase(phase) {
  let statusText = "Answer";
  let aActive = false;
  let bActive = false;

  if (phase === PHASE_A) {
    statusText = "Take A";
    aActive = true;
  } else if (phase === PHASE_GAP) {
    statusText = "Silence";
  } else if (phase === PHASE_B) {
    statusText = "Take B";
    bActive = true;
  } else if (phase === PHASE_ANSWER) {
    statusText = "Answer";
  }

  dom.loopStatus.textContent = statusText;
  dom.eqOffIndicator.classList.toggle("active", aActive);
  dom.eqOnIndicator.classList.toggle("active", bActive);
}

function stopRoundAudio() {
  if (!state.roundOutput || !state.engine) return;

  const { bus } = state.roundOutput;
  state.roundOutput = null;

  const ctx = state.engine.ctx;
  const now = ctx.currentTime;
  const fade = 0.03;

  try {
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(0.0, now + fade);
  } catch (_error) {
    // If we can't automate for any reason, just disconnect later.
  }

  const disconnectMs = Math.max(0, (now + fade + 0.03 - ctx.currentTime) * 1000);
  window.setTimeout(() => {
    try {
      bus.disconnect();
    } catch (_error) {}
  }, disconnectMs);
}

function setOptionsDisabled(disabled) {
  const buttons = dom.options.querySelectorAll("button.option-button");
  for (const b of buttons) b.disabled = disabled;
}

function clearOptionClasses() {
  const buttons = dom.options.querySelectorAll("button.option-button");
  for (const b of buttons) b.classList.remove("correct", "wrong");
}

function renderOptions(order) {
  dom.options.innerHTML = "";

  for (const knobId of order) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-button";
    button.dataset.knob = knobId;
    button.textContent = formatKnob(knobId);
    button.disabled = true;
    button.addEventListener("click", () => handleAnswer(knobId));
    dom.options.appendChild(button);
  }
}

function setFeedback(text, tone /* "ok" | "bad" | "" */) {
  dom.feedback.textContent = text;
  dom.feedback.className = "feedback";
  if (tone === "ok") dom.feedback.classList.add("ok");
  if (tone === "bad") dom.feedback.classList.add("bad");
}

function initAudio() {
  if (state.audioContext) return;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Web Audio API not supported in this browser.");

  state.audioContext = new AudioCtx();
  state.engine = createAudioEngine(state.audioContext);
}

function buildNewRounds() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = generateRounds();
    const v = validateRounds(candidate);
    if (v.ok) {
      state.rounds = candidate;
      if (SETTINGS.DEBUG_LOG_ROUNDS) console.log("[Bullfrog] rounds", candidate);
      bullfrogSelfTest(candidate);
      return;
    }
  }
  throw new Error("Failed to generate valid rounds.");
}

function startNewGame() {
  clearTimers();
  stopRoundAudio();
  buildNewRounds();

  state.currentIndex = 0;
  state.score = 0;
  state.answered = false;
  state.results = [];

  dom.liveScore.textContent = String(state.score);
  dom.progress.textContent = `1/${SETTINGS.ROUNDS_PER_GAME}`;
  dom.review.innerHTML = "";
  setFeedback("", "");

  showScreen("quiz");
  startRound(0);
}

function startRound(index) {
  clearTimers();
  stopRoundAudio();
  state.playbackToken += 1;
  const token = state.playbackToken;

  state.currentIndex = index;
  state.answered = false;

  const round = state.rounds[index];
  const order = shuffle(KNOBS.map((k) => k.id));
  round.answerOrder = order;

  dom.liveScore.textContent = String(state.score);
  dom.progress.textContent = `${index + 1}/${SETTINGS.ROUNDS_PER_GAME}`;

  clearOptionClasses();
  renderOptions(order);
  setOptionsDisabled(false);

  setFeedback("", "");

  if (SETTINGS.DEBUG_SHOW_ANSWER) {
    const knob = round.changedKnob;
    const a = round.takeA;
    const b = round.takeB;
    let details = "";
    if (knob === "cutoff") details = `${a.cutoffHz.toFixed(0)}Hz -> ${b.cutoffHz.toFixed(0)}Hz`;
    if (knob === "resonance") details = `Q ${a.resonanceQ.toFixed(2)} -> ${b.resonanceQ.toFixed(2)}`;
    if (knob === "decay") details = `${a.decayMs.toFixed(0)}ms -> ${b.decayMs.toFixed(0)}ms`;
    dom.debugAnswer.classList.remove("hidden");
    dom.debugAnswer.textContent = `DEBUG: ${formatKnob(round.changedKnob)} (${details})`;
  } else {
    dom.debugAnswer.classList.add("hidden");
    dom.debugAnswer.textContent = "";
  }

  dom.prompt.textContent = "Which knob moved?";
  setPhase(PHASE_GAP);

  const ctx = state.engine.ctx;
  const now = ctx.currentTime;
  const startAt = now + SETTINGS.SCHEDULING_LEAD_SECONDS;

  const bus = ctx.createGain();
  bus.gain.value = 1.0;
  bus.connect(state.engine.masterGain);
  state.roundOutput = { bus };

  state.loopNextAt = startAt;
  scheduleNextLoopCycle(token);
}

function scheduleNextLoopCycle(token) {
  if (token !== state.playbackToken) return;
  if (state.answered) return;
  if (!state.roundOutput) return;

  const ctx = state.engine.ctx;
  const now = ctx.currentTime;
  const round = state.rounds[state.currentIndex];

  let at = state.loopNextAt;
  if (at < now + 0.005) at = now + 0.005;

  const times = playRound(state.engine, round, at, state.roundOutput.bus);

  scheduleUi(token, times.aStart - now, () => setPhase(PHASE_A));
  scheduleUi(token, times.aEnd - now, () => setPhase(PHASE_GAP));
  scheduleUi(token, times.bStart - now, () => setPhase(PHASE_B));
  scheduleUi(token, times.endAt - now, () => setPhase(PHASE_GAP));

  state.loopNextAt = times.endAt + SETTINGS.LOOP_CYCLE_PAUSE_SECONDS;

  const callAt = state.loopNextAt - SETTINGS.SCHEDULING_LEAD_SECONDS;
  scheduleUi(token, callAt - ctx.currentTime, () => scheduleNextLoopCycle(token));
}

function handleAnswer(knobId) {
  if (state.answered) return;

  // Only accept answers once options are enabled.
  const anyEnabled = Array.from(dom.options.querySelectorAll("button.option-button")).some((b) => !b.disabled);
  if (!anyEnabled) return;

  state.answered = true;
  clearPhaseTimers();
  stopRoundAudio();
  setPhase(PHASE_ANSWER);

  const round = state.rounds[state.currentIndex];
  const correct = round.changedKnob;
  const isCorrect = knobId === correct;

  state.results.push({ correctKnob: correct, chosenKnob: knobId, isCorrect });
  if (isCorrect) state.score += 1;
  dom.liveScore.textContent = String(state.score);

  const buttons = Array.from(dom.options.querySelectorAll("button.option-button"));
  for (const b of buttons) {
    b.disabled = true;
    b.classList.remove("correct", "wrong");
    if (b.dataset.knob === correct) b.classList.add("correct");
    if (!isCorrect && b.dataset.knob === knobId) b.classList.add("wrong");
  }

  if (isCorrect) {
    setFeedback(`Correct: ${formatKnob(correct)}`, "ok");
  } else {
    setFeedback(`Wrong. Correct was ${formatKnob(correct)}.`, "bad");
  }

  state.moveNextTimer = window.setTimeout(() => {
    if (state.currentIndex + 1 >= SETTINGS.ROUNDS_PER_GAME) {
      finishGame();
      return;
    }
    startRound(state.currentIndex + 1);
  }, SETTINGS.FEEDBACK_ADVANCE_MS);
}

function finishGame() {
  clearTimers();
  stopRoundAudio();
  setOptionsDisabled(true);
  setPhase(PHASE_ANSWER);

  dom.score.textContent = `Score: ${state.score}/${SETTINGS.ROUNDS_PER_GAME}`;
  dom.review.innerHTML = "";

  for (let i = 0; i < state.results.length; i += 1) {
    const r = state.results[i];
    const li = document.createElement("li");
    const chosen = r.chosenKnob ? formatKnob(r.chosenKnob) : "—";
    li.textContent = `Round ${i + 1}: ${formatKnob(r.correctKnob)} (you: ${chosen}) - ${r.isCorrect ? "correct" : "wrong"}`;
    dom.review.appendChild(li);
  }

  showScreen("result");
}

async function onStartPressed() {
  dom.startButton.disabled = true;
  try {
    initAudio();
    if (state.audioContext.state !== "running") {
      await state.audioContext.resume();
    }
    startNewGame();
  } catch (error) {
    console.error(error);
    alert(String(error && error.message ? error.message : error));
    dom.startButton.disabled = false;
  }
}

function onRestartPressed() {
  startNewGame();
}

dom.startButton.addEventListener("click", onStartPressed);
dom.restartButton.addEventListener("click", onRestartPressed);

document.addEventListener("keydown", (e) => {
  if (dom.quizScreen.classList.contains("hidden")) return;
  if (state.answered) return;

  const key = e.key;
  if (key !== "1" && key !== "2" && key !== "3") return;

  const idx = Number(key) - 1;
  const buttons = Array.from(dom.options.querySelectorAll("button.option-button"));
  const target = buttons[idx];
  if (!target || target.disabled) return;
  target.click();
});

// Initial state.
showScreen("start");
setPhase(PHASE_A);
dom.prompt.textContent = "";
setFeedback("", "");
