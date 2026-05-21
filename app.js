// CCNA Flashcards (CCNA 1/2/3) — static web app.
// Open index.html directly in a browser — no server required.
// Question data is loaded synchronously from questions-data.js (window.FLASHCARDS_DATA).

const EXAMS = [
  { id: "ccna1", label: "CCNA 1 — Introduction to Networks" },
  { id: "ccna2", label: "CCNA 2 — Switching, Routing & Wireless" },
  { id: "ccna3", label: "CCNA 3 — Enterprise Networking & Security" },
];

const STORAGE_KEY = "flashcards-srs-v1";
const PREFS_KEY = "ccna3-prefs-v1";
const DAY = 86_400_000;
const BOX_INTERVALS = [0, 1 * DAY, 2 * DAY, 4 * DAY, 8 * DAY, 16 * DAY];
const TOP_UP_THRESHOLD = 20;

const els = {
  examSelect: document.getElementById("exam-select"),
  modeSelect: document.getElementById("mode-select"),
  topicSelect: document.getElementById("topic-select"),
  resetBtn: document.getElementById("reset-btn"),
  helpBtn: document.getElementById("help-btn"),
  themeBtn: document.getElementById("theme-btn"),
  helpDialog: document.getElementById("help-dialog"),
  statusBar: document.getElementById("status-bar"),
  card: document.getElementById("card"),
  explanation: document.getElementById("explanation"),
  actions: document.getElementById("actions"),
  error: document.getElementById("error"),
};

const THEMES = ["dark", "light"];
const THEME_ICONS = { dark: "☾", light: "☀" };

const ui = {
  examId: EXAMS[0].id,
  mode: "srs",
  topicFilter: "all",
  theme: "dark",
  queue: [],
  cursor: 0,
  sessionStats: { right: 0, wrong: 0, seen: 0 },
  selectedIdx: new Set(),
  graded: false,
  questions: [],
  byNumber: new Map(),
};

function currentExam() {
  return EXAMS.find((e) => e.id === ui.examId) || EXAMS[0];
}

// ---------- Data loading ----------

function loadQuestions() {
  const exam = currentExam();
  const all = window.FLASHCARDS_DATA;
  if (!all || !all[exam.id]) {
    throw new Error(
      `Missing data for ${exam.id}. Check that questions-data.js is loaded.`,
    );
  }
  return all[exam.id].map(enrichQuestion);
}

function enrichQuestion(q) {
  const correctIndices = new Set(
    q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0),
  );
  let kind;
  if (q.options.length === 0) kind = "concept";
  else if (correctIndices.size > 1) kind = "multi";
  else kind = "single";
  const topicMajor = q.topic ? q.topic.split(".")[0] : null;
  return { ...q, kind, correctIndices, topicMajor };
}

// ---------- Persistence ----------

function loadAllSRS() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function loadSRS() {
  return loadAllSRS()[ui.examId] || {};
}

function saveSRS(perExam) {
  const all = loadAllSRS();
  all[ui.examId] = perExam;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      examId: ui.examId,
      mode: ui.mode,
      topicFilter: ui.topicFilter,
      theme: ui.theme,
    }),
  );
}

function applyTheme() {
  document.documentElement.dataset.theme = ui.theme;
  // Icon shows the theme you'll get on next click (i.e. the opposite)
  const next = ui.theme === "dark" ? "light" : "dark";
  els.themeBtn.textContent = THEME_ICONS[next];
  els.themeBtn.title = `Switch to ${next} theme (T)`;
}

function toggleTheme() {
  ui.theme = ui.theme === "dark" ? "light" : "dark";
  applyTheme();
  savePrefs();
}

function getQuestionState(number) {
  const srs = loadSRS();
  return (
    srs[number] || { box: 1, due: 0, seen: 0, correct: 0, lastResult: null }
  );
}

function recordResult(number, wasRight) {
  const srs = loadSRS();
  const cur = srs[number] || {
    box: 1,
    due: 0,
    seen: 0,
    correct: 0,
    lastResult: null,
  };
  cur.seen += 1;
  if (wasRight) {
    cur.correct += 1;
    cur.box = Math.min(5, cur.box + 1);
    cur.lastResult = "right";
  } else {
    cur.box = 1;
    cur.lastResult = "wrong";
  }
  cur.due = Date.now() + BOX_INTERVALS[cur.box];
  srs[number] = cur;
  saveSRS(srs);
  ui.sessionStats.seen += 1;
  if (wasRight) ui.sessionStats.right += 1;
  else ui.sessionStats.wrong += 1;
}

// ---------- Queue building ----------

function filteredQuestions() {
  if (ui.topicFilter === "all") return ui.questions;
  return ui.questions.filter((q) => q.topicMajor === ui.topicFilter);
}

function buildQueue() {
  const pool = filteredQuestions();
  if (pool.length === 0) return [];

  if (ui.mode === "sequential") {
    return pool.map((q) => q.number).sort((a, b) => a - b);
  }
  if (ui.mode === "random") {
    return shuffle(pool.map((q) => q.number));
  }
  // SRS
  const now = Date.now();
  const srs = loadSRS();
  const withState = pool.map((q) => ({
    number: q.number,
    state: srs[q.number] || {
      box: 1,
      due: 0,
      seen: 0,
      correct: 0,
      lastResult: null,
    },
  }));
  const due = withState.filter(({ state }) => state.due <= now);
  const notDue = withState.filter(({ state }) => state.due > now);

  due.sort((a, b) => {
    if (a.state.box !== b.state.box) return a.state.box - b.state.box;
    return a.state.due - b.state.due;
  });
  notDue.sort((a, b) => a.state.due - b.state.due);

  let queue = due.map((x) => x.number);
  if (queue.length < TOP_UP_THRESHOLD) {
    queue = queue.concat(
      notDue.slice(0, TOP_UP_THRESHOLD - queue.length).map((x) => x.number),
    );
  }
  return queue;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function currentQuestion() {
  if (ui.cursor >= ui.queue.length) return null;
  return ui.byNumber.get(ui.queue[ui.cursor]);
}

// ---------- Rendering ----------

function render() {
  const q = currentQuestion();
  renderStatus();
  if (!q) {
    renderEmpty();
    return;
  }
  renderCard(q);
  renderActions(q);
  els.explanation.hidden = !ui.graded;
  if (ui.graded) renderExplanation(q);
}

function renderStatus() {
  const { right, wrong, seen } = ui.sessionStats;
  const pos = Math.min(ui.cursor + 1, ui.queue.length);
  els.statusBar.innerHTML = `
    <div>Card ${pos} of ${ui.queue.length} <span style="color:var(--fg-muted)">(${ui.questions.length} in ${ui.examId.toUpperCase()})</span></div>
    <div class="session-stats">
      <span class="stat-right">✓ ${right}</span>
      <span class="stat-wrong">✗ ${wrong}</span>
      <span>seen ${seen}</span>
    </div>`;
}

function renderEmpty() {
  els.card.innerHTML = `
    <div class="empty">
      <h2>All done!</h2>
      <p>No more cards in this queue. Try switching mode or topic, or come back later.</p>
    </div>`;
  els.actions.innerHTML = "";
  els.explanation.hidden = true;
}

function renderCard(q) {
  const state = getQuestionState(q.number);
  const meta = [
    `<span class="badge">#${q.number}</span>`,
    q.topic ? `<span class="badge">topic ${q.topic}</span>` : "",
    `<span class="badge">box ${state.box}</span>`,
    q.kind !== "single"
      ? `<span class="badge">${q.kind === "multi" ? "choose all" : "concept card"}</span>`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const parts = [`<div class="card-meta"><div>${meta}</div></div>`];
  parts.push(`<p class="question-text"></p>`);
  if (q.image)
    parts.push(
      `<div class="exhibit"><img src="${escapeAttr(q.image)}" loading="lazy" alt="exhibit"></div>`,
    );
  if (q.code) parts.push(`<pre class="code-block"></pre>`);
  parts.push(`<ul class="options"></ul>`);

  els.card.innerHTML = parts.join("");
  els.card.querySelector(".question-text").textContent = q.question;
  if (q.code) els.card.querySelector(".code-block").textContent = q.code;
  renderOptions(q);
}

function renderOptions(q) {
  const ul = els.card.querySelector(".options");
  ul.innerHTML = "";
  if (q.kind === "concept") return;

  q.options.forEach((opt, idx) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "option";
    btn.type = "button";
    btn.dataset.idx = String(idx);

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = letterFor(idx);
    btn.appendChild(key);

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = opt.text;
    btn.appendChild(text);

    const marker = document.createElement("span");
    marker.className = "marker";
    btn.appendChild(marker);

    if (ui.selectedIdx.has(idx)) btn.classList.add("selected");

    if (ui.graded) {
      btn.disabled = true;
      const isCorrect = q.correctIndices.has(idx);
      const wasSelected = ui.selectedIdx.has(idx);
      if (isCorrect) {
        btn.classList.add("correct");
        marker.textContent = "✓";
      } else if (wasSelected) {
        btn.classList.add("wrong");
        marker.textContent = "✗";
      }
    } else {
      btn.addEventListener("click", () => onOptionClick(idx));
    }

    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function renderExplanation(q) {
  els.explanation.innerHTML = `<h3>Explanation</h3>`;
  const body = document.createElement("div");
  body.innerHTML = q.explanation_html || "<p><em>No explanation provided.</em></p>";
  els.explanation.appendChild(body);
}

function renderActions(q) {
  els.actions.innerHTML = "";
  if (!currentQuestion()) return;

  if (!ui.graded) {
    if (q.kind === "concept") {
      addBtn("Reveal", "primary", revealConcept);
    } else if (q.kind === "multi") {
      const submit = addBtn("Check answer", "primary", submitAnswer);
      submit.disabled = ui.selectedIdx.size === 0;
    }
    // single-correct grades on click; no submit button needed
  } else {
    if (q.kind === "concept") {
      addBtn("I was wrong", "ghost", () => gradeConcept(false));
      addBtn("I knew it", "primary", () => gradeConcept(true));
    } else {
      addBtn("Next →", "primary", nextCard);
    }
  }
}

function addBtn(label, cls, handler) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", handler);
  els.actions.appendChild(b);
  return b;
}

function letterFor(idx) {
  return String.fromCharCode(65 + idx);
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// ---------- Game logic ----------

function onOptionClick(idx) {
  const q = currentQuestion();
  if (!q || ui.graded) return;

  if (q.kind === "single") {
    ui.selectedIdx = new Set([idx]);
    ui.graded = true;
    const wasRight = q.correctIndices.has(idx);
    recordResult(q.number, wasRight);
    render();
  } else {
    // multi: toggle
    if (ui.selectedIdx.has(idx)) ui.selectedIdx.delete(idx);
    else ui.selectedIdx.add(idx);
    render();
  }
}

function submitAnswer() {
  const q = currentQuestion();
  if (!q || ui.graded || q.kind !== "multi") return;
  const sel = ui.selectedIdx;
  const correct = q.correctIndices;
  let wasRight = sel.size === correct.size;
  if (wasRight) {
    for (const i of correct) if (!sel.has(i)) { wasRight = false; break; }
  }
  ui.graded = true;
  recordResult(q.number, wasRight);
  render();
}

function revealConcept() {
  ui.graded = true;
  render();
}

function gradeConcept(wasRight) {
  const q = currentQuestion();
  if (!q) return;
  recordResult(q.number, wasRight);
  nextCard();
}

function nextCard() {
  ui.cursor += 1;
  ui.selectedIdx = new Set();
  ui.graded = false;
  if (ui.cursor >= ui.queue.length) {
    ui.queue = buildQueue();
    ui.cursor = 0;
  }
  render();
}

function markWrongAndNext() {
  const q = currentQuestion();
  if (!q) return;
  if (!ui.graded) {
    recordResult(q.number, false);
  }
  nextCard();
}

// ---------- Topic filter dropdown ----------

function populateExamSelect() {
  els.examSelect.innerHTML = "";
  for (const exam of EXAMS) {
    const opt = document.createElement("option");
    opt.value = exam.id;
    opt.textContent = exam.label;
    els.examSelect.appendChild(opt);
  }
  els.examSelect.value = ui.examId;
}

function populateTopicFilter() {
  // Keep only the "All topics" option; rebuild the rest.
  [...els.topicSelect.querySelectorAll("option")].forEach((opt) => {
    if (opt.value !== "all") opt.remove();
  });
  const counts = new Map();
  for (const q of ui.questions) {
    if (!q.topicMajor) continue;
    counts.set(q.topicMajor, (counts.get(q.topicMajor) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  );
  const available = new Set(sorted.map(([m]) => m));
  for (const [major, n] of sorted) {
    const opt = document.createElement("option");
    opt.value = major;
    opt.textContent = `Topic ${major} — ${n} question${n === 1 ? "" : "s"}`;
    els.topicSelect.appendChild(opt);
  }
  // If the previously-selected topic doesn't exist in this exam, reset to "all".
  if (ui.topicFilter !== "all" && !available.has(ui.topicFilter)) {
    ui.topicFilter = "all";
    savePrefs();
  }
  els.topicSelect.value = ui.topicFilter;
}

// ---------- Event wiring ----------

function onExamChange() {
  ui.examId = els.examSelect.value;
  savePrefs();
  try {
    ui.questions = loadQuestions();
    ui.byNumber = new Map(ui.questions.map((q) => [q.number, q]));
    populateTopicFilter();
    ui.sessionStats = { right: 0, wrong: 0, seen: 0 };
    resetSession();
  } catch (err) {
    showError(`Failed to load exam: ${err.message}`);
    console.error(err);
  }
}

function onModeChange() {
  ui.mode = els.modeSelect.value;
  resetSession();
  savePrefs();
}

function onTopicChange() {
  ui.topicFilter = els.topicSelect.value;
  resetSession();
  savePrefs();
}

function resetSession() {
  ui.queue = buildQueue();
  ui.cursor = 0;
  ui.selectedIdx = new Set();
  ui.graded = false;
  render();
}

function onReset() {
  const exam = currentExam();
  if (
    !confirm(
      `Reset study progress for "${exam.label}"? Other exams are unaffected.`,
    )
  )
    return;
  const all = loadAllSRS();
  delete all[ui.examId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  ui.sessionStats = { right: 0, wrong: 0, seen: 0 };
  resetSession();
}

function onKeydown(e) {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const q = currentQuestion();
  if (!q) return;

  if (e.key === "?") {
    e.preventDefault();
    if (els.helpDialog.open) els.helpDialog.close();
    else els.helpDialog.showModal();
    return;
  }
  if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    markWrongAndNext();
    return;
  }
  if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    toggleTheme();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (ui.graded) {
      if (q.kind === "concept") gradeConcept(true);
      else nextCard();
    } else if (q.kind === "multi" && ui.selectedIdx.size > 0) {
      submitAnswer();
    } else if (q.kind === "concept") {
      revealConcept();
    }
    return;
  }
  if (e.key === " " && q.kind === "concept" && !ui.graded) {
    e.preventDefault();
    revealConcept();
    return;
  }
  // 1-9 option selection
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    const idx = n - 1;
    if (q.kind !== "concept" && idx < q.options.length && !ui.graded) {
      e.preventDefault();
      onOptionClick(idx);
    }
  }
}

function showError(msg) {
  els.error.hidden = false;
  els.error.textContent = msg;
}

// ---------- Init ----------

(function init() {
  try {
    const prefs = loadPrefs();
    if (prefs.examId && EXAMS.some((e) => e.id === prefs.examId)) {
      ui.examId = prefs.examId;
    }
    if (prefs.mode) ui.mode = prefs.mode;
    if (prefs.topicFilter) ui.topicFilter = prefs.topicFilter;
    if (THEMES.includes(prefs.theme)) ui.theme = prefs.theme;

    applyTheme();

    ui.questions = loadQuestions();
    ui.byNumber = new Map(ui.questions.map((q) => [q.number, q]));

    populateExamSelect();
    populateTopicFilter();
    els.modeSelect.value = ui.mode;

    els.examSelect.addEventListener("change", onExamChange);
    els.modeSelect.addEventListener("change", onModeChange);
    els.topicSelect.addEventListener("change", onTopicChange);
    els.resetBtn.addEventListener("click", onReset);
    els.themeBtn.addEventListener("click", toggleTheme);
    els.helpBtn.addEventListener("click", () => els.helpDialog.showModal());
    document.addEventListener("keydown", onKeydown);

    resetSession();
  } catch (err) {
    showError(`Failed to start: ${err.message}`);
    console.error(err);
  }
})();
