const DB_NAME = "pablo-throwing-challenge";
const DB_VERSION = 1;
const STORE = "participants";
const WINNER_KEY = "pabloChallengeLastWinner";
const bc = "BroadcastChannel" in window ? new BroadcastChannel("pablo-raffle") : null;

let dbPromise;
let participantsCache = [];
let currentRoute = "/";
let wheelRotation = 0;
let spinAnimation;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("email", "email");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function transaction(mode, callback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getParticipants() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => {
      const people = request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      participantsCache = people;
      resolve(people);
    };
    request.onerror = () => reject(request.error);
  });
}

async function addParticipant(person) {
  await transaction("readwrite", (store) => store.add(person));
  notifyDataChanged();
}

async function updateParticipant(person) {
  await transaction("readwrite", (store) => store.put(person));
  notifyDataChanged();
}

async function clearParticipants() {
  await transaction("readwrite", (store) => store.clear());
  localStorage.removeItem(WINNER_KEY);
  notifyDataChanged();
}

function notifyDataChanged() {
  bc?.postMessage({ type: "participants-updated" });
  localStorage.setItem("pabloChallengeUpdatedAt", String(Date.now()));
}

function fullName(person) {
  return `${person.firstName} ${person.lastName}`.trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(iso) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function summarize(people) {
  return {
    participants: people.length,
    entries: people.reduce((sum, person) => sum + Number(person.entries || 0), 0),
    highScore: people.reduce((max, person) => Math.max(max, Number(person.score || 0)), 0),
  };
}

function makeEntries(people) {
  return people.flatMap((person) => Array.from({ length: person.entries }, () => person));
}

function routeFromHash() {
  return location.hash.replace(/^#/, "") || "/";
}

async function render() {
  currentRoute = routeFromHash();
  $$(".nav a").forEach((link) => link.classList.toggle("active", link.dataset.route === currentRoute));
  $("#main-nav").classList.remove("open");
  $(".nav-toggle").setAttribute("aria-expanded", "false");

  if (currentRoute === "/dashboard") return renderDashboard();
  if (currentRoute === "/wheel") return renderWheel();
  if (currentRoute === "/winner") return renderWinner();
  return renderEntry();
}

function mountTemplate(id) {
  const app = $("#app");
  app.replaceChildren($(id).content.cloneNode(true));
}

async function renderEntry() {
  mountTemplate("#entry-template");
  const people = await getParticipants();
  updateEntryStats(people);
  setupEntryForm();
}

function updateEntryStats(people) {
  const stats = summarize(people);
  $("#entry-total-participants").textContent = stats.participants;
  $("#entry-total-entries").textContent = stats.entries;
}

function setupEntryForm() {
  const form = $("#participant-form");
  const scoreInput = $("#score-input");
  const entryPreview = $("#entry-preview");
  const message = $("#form-message");
  const submit = $("#submit-player");
  let submitting = false;
  let lastSignature = "";
  let lastSubmitAt = 0;

  const updatePreview = () => {
    const score = Math.max(0, Number.parseInt(scoreInput.value || "0", 10) || 0);
    entryPreview.textContent = score;
  };

  scoreInput.addEventListener("input", updatePreview);
  $$("[data-add-score]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = Number.parseInt(scoreInput.value || "0", 10) || 0;
      scoreInput.value = current + Number(button.dataset.addScore);
      updatePreview();
    });
  });
  $("[data-clear-score]").addEventListener("click", () => {
    scoreInput.value = "";
    updatePreview();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;

    const data = new FormData(form);
    const score = Math.max(0, Number.parseInt(data.get("score"), 10) || 0);
    const person = {
      id: crypto.randomUUID(),
      firstName: String(data.get("firstName") || "").trim(),
      lastName: String(data.get("lastName") || "").trim(),
      email: String(data.get("email") || "").trim().toLowerCase(),
      phone: String(data.get("phone") || "").trim(),
      score,
      entries: score,
      createdAt: new Date().toISOString(),
    };

    const signature = `${person.firstName}|${person.lastName}|${person.email}|${person.phone}|${person.score}`.toLowerCase();
    if (signature === lastSignature && Date.now() - lastSubmitAt < 12000) {
      message.className = "form-message error";
      message.textContent = "Looks like that player was just submitted. Wait a moment before adding the same entry again.";
      return;
    }

    const existingPeople = await getParticipants();
    const recentDuplicate = existingPeople.find((existing) => {
      const existingSignature = `${existing.firstName}|${existing.lastName}|${existing.email}|${existing.phone}|${existing.score}`.toLowerCase();
      return existingSignature === signature && Date.now() - new Date(existing.createdAt).getTime() < 120000;
    });
    if (recentDuplicate) {
      message.className = "form-message error";
      message.textContent = "That exact player entry was already saved recently, so it was not submitted again.";
      return;
    }

    if (!person.firstName || !person.lastName || !person.email || !person.phone) {
      message.className = "form-message error";
      message.textContent = "Please fill out every field before adding the player.";
      return;
    }

    submitting = true;
    submit.disabled = true;
    submit.textContent = "Adding...";
    try {
      await addParticipant(person);
      const people = await getParticipants();
      updateEntryStats(people);
      lastSignature = signature;
      lastSubmitAt = Date.now();
      form.reset();
      updatePreview();
      message.className = "form-message success";
      message.textContent = `${fullName(person)} added with ${person.entries} raffle ${person.entries === 1 ? "entry" : "entries"}.`;
      $("input[name='firstName']").focus();
    } catch (error) {
      message.className = "form-message error";
      message.textContent = `Could not save the participant: ${error.message}`;
    } finally {
      submitting = false;
      submit.disabled = false;
      submit.textContent = "Add participant to raffle";
    }
  });
}

async function renderDashboard() {
  mountTemplate("#dashboard-template");
  const people = await getParticipants();
  renderDashboardStats(people);
  renderParticipantList(people);
  setupParticipantEditing(people);

  $("#participant-search").addEventListener("input", (event) => {
    const term = event.target.value.trim().toLowerCase();
    const filtered = people.filter((person) => {
      const haystack = `${fullName(person)} ${person.email} ${person.phone} ${person.score} ${person.entries}`.toLowerCase();
      return haystack.includes(term);
    });
    renderParticipantList(filtered);
    setupParticipantEditing(people);
  });

  $("#export-csv").addEventListener("click", () => exportCsv(people));
  $("#reset-raffle").addEventListener("click", async () => {
    const confirmed = confirm("Reset the raffle and delete all participants from this browser?");
    if (!confirmed) return;
    await clearParticipants();
    await renderDashboard();
  });
}

function renderDashboardStats(people) {
  const stats = summarize(people);
  $("#dash-total-participants").textContent = stats.participants;
  $("#dash-total-entries").textContent = stats.entries;
  $("#dash-high-score").textContent = stats.highScore;
}

function renderParticipantList(people) {
  $("#participant-count-label").textContent = `${people.length} shown`;
  const list = $("#participant-list");
  if (!people.length) {
    list.innerHTML = `<div class="empty-state">No participants yet. Add players from the Game Entry page.</div>`;
    return;
  }
  list.innerHTML = people.map((person) => `
    <article class="participant-card">
      <h3>${escapeHtml(fullName(person))}</h3>
      <dl>
        <dt>Email</dt><dd>${escapeHtml(person.email)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(person.phone)}</dd>
        <dt>Score</dt><dd>${person.score}</dd>
        <dt>Entries</dt><dd>${person.entries}</dd>
        <dt>Submitted</dt><dd>${escapeHtml(formatDate(person.createdAt))}</dd>
      </dl>
      <button class="edit-participant-btn" type="button" data-edit-id="${escapeHtml(person.id)}">Edit participant</button>
    </article>
  `).join("");
}

function setupParticipantEditing(allPeople) {
  const dialog = $("#edit-participant-dialog");
  const form = $("#edit-participant-form");
  const message = $("#edit-message");

  $$(".edit-participant-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const person = allPeople.find((candidate) => candidate.id === button.dataset.editId);
      if (!person) return;
      form.elements.id.value = person.id;
      form.elements.firstName.value = person.firstName;
      form.elements.lastName.value = person.lastName;
      form.elements.email.value = person.email;
      form.elements.phone.value = person.phone;
      form.elements.score.value = person.score;
      message.textContent = "";
      dialog.showModal();
    });
  });

  $("#cancel-edit").onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const person = allPeople.find((candidate) => candidate.id === form.elements.id.value);
    if (!person) return;
    const score = Math.max(0, Number.parseInt(form.elements.score.value || "0", 10) || 0);
    const updatedPerson = {
      ...person,
      firstName: form.elements.firstName.value.trim(),
      lastName: form.elements.lastName.value.trim(),
      email: form.elements.email.value.trim().toLowerCase(),
      phone: form.elements.phone.value.trim(),
      score,
      entries: score,
      updatedAt: new Date().toISOString(),
    };
    await updateParticipant(updatedPerson);
    dialog.close();
    await renderDashboard();
  };
}

function exportCsv(people) {
  const headers = ["First name", "Last name", "Email", "Phone number", "Score", "Number of entries", "Date/time submitted"];
  const rows = people.map((person) => [
    person.firstName,
    person.lastName,
    person.email,
    person.phone,
    person.score,
    person.entries,
    person.createdAt,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pablo-raffle-participants-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function renderWheel() {
  mountTemplate("#wheel-template");
  const people = await getParticipants();
  const entries = makeEntries(people);
  const canvas = $("#raffle-wheel");
  const spinButton = $("#spin-wheel");
  drawWheel(canvas, entries);
  renderWheelList(entries, people);

  spinButton.disabled = entries.length === 0;
  spinButton.addEventListener("click", () => spinWheel(canvas, entries, spinButton));
}

function renderWheelList(entries, people) {
  const stats = summarize(people);
  $("#wheel-summary").textContent = `${stats.participants} participants and ${stats.entries} total raffle entries.`;
  const list = $("#wheel-entry-list");
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">No entries yet. Add participants first.</div>`;
    return;
  }
  const visibleEntries = entries.slice(0, 500);
  list.innerHTML = visibleEntries.map((person, index) => `<span class="entry-pill">${index + 1}. ${escapeHtml(fullName(person))}</span>`).join("");
  if (entries.length > visibleEntries.length) {
    list.insertAdjacentHTML("beforeend", `<span class="entry-pill">+ ${entries.length - visibleEntries.length} more entries</span>`);
  }
}

function drawWheel(canvas, entries, rotation = wheelRotation) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const radius = width / 2 - 18;
  const center = width / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(rotation);

  if (!entries.length) {
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#fff3cf";
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#12324a";
    ctx.stroke();
    ctx.fillStyle = "#12324a";
    ctx.font = "900 32px Nunito";
    ctx.textAlign = "center";
    ctx.fillText("Add players", 0, -12);
    ctx.fillText("to fill the wheel", 0, 30);
    ctx.restore();
    return;
  }

  const colors = ["#d83d32", "#1e74d6", "#20935c", "#ffc943", "#fff3cf"];
  const angle = (Math.PI * 2) / entries.length;
  entries.forEach((person, index) => {
    const start = index * angle;
    const end = start + angle;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    ctx.lineWidth = entries.length > 140 ? 0.45 : 1.5;
    ctx.strokeStyle = "rgba(18, 50, 74, 0.58)";
    ctx.stroke();

    if (entries.length <= 72) {
      ctx.save();
      ctx.rotate(start + angle / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = index % 5 === 3 || index % 5 === 4 ? "#12324a" : "#fff";
      ctx.font = `${entries.length > 36 ? 14 : 20}px Nunito`;
      ctx.fillText(fullName(person), radius - 18, 6);
      ctx.restore();
    }
  });

  ctx.beginPath();
  ctx.arc(0, 0, 74, 0, Math.PI * 2);
  ctx.fillStyle = "#fff9e8";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#12324a";
  ctx.stroke();
  ctx.fillStyle = "#d83d32";
  ctx.font = "900 24px Bangers";
  ctx.textAlign = "center";
  ctx.fillText("RAFFLE", 0, -4);
  ctx.fillText("TIME", 0, 26);
  ctx.restore();
}

function spinWheel(canvas, entries, button) {
  if (!entries.length || spinAnimation) return;
  button.disabled = true;
  $("#wheel-result").hidden = true;
  const winnerIndex = crypto.getRandomValues(new Uint32Array(1))[0] % entries.length;
  const angle = (Math.PI * 2) / entries.length;
  const targetCenter = winnerIndex * angle + angle / 2;
  const pointerAngle = -Math.PI / 2;
  const fullSpins = 7 + Math.floor(Math.random() * 4);
  const start = wheelRotation;
  const target = fullSpins * Math.PI * 2 + pointerAngle - targetCenter;
  const duration = 4300;
  const startTime = performance.now();

  const animate = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 4);
    wheelRotation = start + (target - start) * eased;
    drawWheel(canvas, entries, wheelRotation);
    if (progress < 1) {
      spinAnimation = requestAnimationFrame(animate);
      return;
    }
    spinAnimation = null;
    wheelRotation = normalizeAngle(wheelRotation);
    const winner = entries[winnerIndex];
    localStorage.setItem(WINNER_KEY, JSON.stringify({ ...winner, selectedAt: new Date().toISOString() }));
    showWinnerCallout(winner);
    button.disabled = false;
  };
  spinAnimation = requestAnimationFrame(animate);
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function showWinnerCallout(winner) {
  const callout = $("#wheel-result");
  callout.hidden = false;
  callout.innerHTML = `
    <h2>${escapeHtml(fullName(winner))} wins!</h2>
    <p>${escapeHtml(winner.email)} | ${escapeHtml(winner.phone)}</p>
    <p>Score: <strong>${winner.score}</strong> | Entries: <strong>${winner.entries}</strong></p>
    <a class="primary-link" href="#/winner">View winner details</a>
  `;
}

function renderWinner() {
  mountTemplate("#winner-template");
  const rawWinner = localStorage.getItem(WINNER_KEY);
  const details = $("#winner-details");
  if (!rawWinner) {
    details.innerHTML = `<div class="empty-state">No winner selected yet. Spin the raffle wheel to pick one.</div>`;
    return;
  }
  const winner = JSON.parse(rawWinner);
  details.innerHTML = `
    <div class="winner-card">
      <h2>${escapeHtml(fullName(winner))}</h2>
      <p><strong>Email:</strong> ${escapeHtml(winner.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(winner.phone)}</p>
      <p><strong>Score:</strong> ${winner.score}</p>
      <p><strong>Number of entries:</strong> ${winner.entries}</p>
      <p><strong>Selected:</strong> ${escapeHtml(formatDate(winner.selectedAt))}</p>
    </div>
  `;
}

function setupNav() {
  $(".nav-toggle").addEventListener("click", () => {
    const nav = $("#main-nav");
    const open = !nav.classList.contains("open");
    nav.classList.toggle("open", open);
    $(".nav-toggle").setAttribute("aria-expanded", String(open));
  });
}

window.addEventListener("hashchange", render);
window.addEventListener("storage", (event) => {
  if (event.key === "pabloChallengeUpdatedAt" && ["/", "/dashboard", "/wheel"].includes(currentRoute)) render();
});
bc?.addEventListener("message", (event) => {
  if (event.data?.type === "participants-updated" && ["/", "/dashboard", "/wheel"].includes(currentRoute)) render();
});

setupNav();
render().catch((error) => {
  $("#app").innerHTML = `<section class="panel"><h1>Database error</h1><p>${escapeHtml(error.message)}</p></section>`;
});
