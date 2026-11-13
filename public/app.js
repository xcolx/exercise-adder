// Exercise Adder: plain JavaScript without a build step.
// The ideas, the proposed and the staged exercises are stored by the server in a JSON file (data.json).
// Only the session token stays in the localStorage of the browser.

const METRICS = ["reps", "weights", "time", "intensity", "distance"];
const TABS = { library: "Library", ideas: "1 · Ideas", proposed: "2 · Proposed", staged: "3 · Staging" };

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const state = {
  token: stored("token", ""),
  tab: "library",
  data: null, // { exercises, equipment, muscleGroups, muscles } of gym2.app
  ideas: [], // { id, name, reason }
  proposals: [], // exercises with id and client_uuid
  staged: [],
  busy: new Set(), // IDs of ideas that are generated and exercises that are uploaded
  errors: {}, // ID -> message
  notes: {}, // ID of a proposed exercise -> note for regenerating it
  ideasBusy: false,
  filter: "",
  title: "",
  prompt: "",
};

const STORED = ["ideas", "proposals", "staged"];
let saveTimer = null;

/** Writes the ideas and exercises to the file of the server, shortly after the last change (e.g. while typing). */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  // keepalive lets the request finish when the page is closed right after a change
  fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.fromEntries(STORED.map((key) => [key, state[key]]))),
    keepalive: true,
  })
    .then((res) => res.ok || Promise.reject())
    .catch(() => flash("The changes could not be saved to data.json. Is the server still running?", true));
}

async function loadState() {
  try {
    Object.assign(state, await api("/api/state"));
    // Takes over what an older version kept in the localStorage
    if (STORED.some((key) => localStorage.getItem(key))) {
      for (const key of STORED) {
        state[key].push(...stored(key, []));
        localStorage.removeItem(key);
      }
      save();
    }
  } catch (e) {
    flash(e.message, true);
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Session-Token": state.token },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function flash(message, isError = false) {
  const status = $("#status");
  status.textContent = message;
  status.className = isError ? "error" : "";
  status.hidden = !message;
}

// ---------- Helpers ----------

const nameOf = (id, items) => items.find((item) => item.id === id)?.name ?? "–";
const namesOf = (ids, items) => ids.map((id) => nameOf(id, items)).join(", ") || "–";
const tracks = (exercise) => METRICS.filter((metric) => exercise[metric]).join(", ");

/** The existing exercise with this name or alias, regardless of case. */
function existing(name) {
  const wanted = name.trim().toLowerCase();
  return state.data.exercises.find((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase() === wanted));
}

function problems(exercise) {
  const list = [];
  if (!exercise.name.trim()) list.push("the name is missing");
  if (existing(exercise.name)) list.push("an exercise with this name already exists");
  if (!state.data.equipment.some((item) => item.id === exercise.equipment_id)) list.push("choose the equipment");
  if (!state.data.muscleGroups.some((item) => item.id === exercise.muscle_group_id)) list.push("choose the muscle group");
  if (!METRICS.some((metric) => exercise[metric])) list.push("choose at least one tracked metric");
  return list;
}

// ---------- Highlighted body ----------
// Like HighlightedBody of the Gym 2.0 web app: the server has one image per muscle that shows the muscle in color
// on the body. Its colored part becomes a mask that is filled with red (primary) or orange (secondary), below the
// outline of the body.

const masks = new Map(); // hash of the image -> Promise of the mask as object URL, or null

/** The colored part of an image as a white PNG with its opacity (makeMuscleMask of Gym 2.0). */
async function maskFromImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 500 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    // Transparent pixels count as black. JPEG compression gives black and white a little color, so 24 is ignored
    const opacity = pixels[i + 3] / 255;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]].map((value) => Math.round(value * opacity));
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = Math.min(255, Math.trunc((Math.max(chroma - 24, 0) * 255) / (255 - 24)));
  }
  context.putImageData(image, 0, 0);
  const mask = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return URL.createObjectURL(mask);
}

function loadMask(hash) {
  if (!masks.has(hash)) {
    masks.set(
      hash,
      fetch(`/api/images/${hash}`, { headers: { "X-Session-Token": state.token } })
        .then(async (res) => (res.ok ? maskFromImage(await res.blob()) : null))
        .catch(() => null),
    );
  }
  return masks.get(hash);
}

/** The placeholder of a body, filled by fillBodies after it is in the page. */
const bodyHtml = (exercise, size = "") =>
  `<div class="body ${size}" data-primary="${exercise.primary_muscle_ids.join(",")}" data-secondary="${exercise.secondary_muscle_ids.join(",")}"></div>`;

function fillBody(body) {
  body.replaceChildren();
  // Secondary first, so that the primary muscles are drawn above them
  for (const kind of ["secondary", "primary"]) {
    for (const id of body.dataset[kind].split(",").filter(Boolean)) {
      const hash = state.data.muscles.find((muscle) => muscle.id === Number(id))?.image_url;
      if (!hash) continue;
      const layer = document.createElement("div");
      layer.className = kind;
      body.append(layer);
      loadMask(hash).then((mask) => {
        if (mask) layer.style.maskImage = layer.style.webkitMaskImage = `url("${mask}")`;
      });
    }
  }
}

const fillBodies = (root = $("#view")) => root.querySelectorAll(".body").forEach(fillBody);

// ---------- Views ----------

function libraryRows() {
  const { exercises, equipment, muscleGroups, muscles } = state.data;
  const query = state.filter.toLowerCase();
  return exercises
    .filter((e) => !query || [e.name, ...e.aliases, e.description].join(" ").toLowerCase().includes(query))
    .map((e) => `
      <tr>
        <td><b>${esc(e.name)}</b>${e.aliases.length ? `<br><small>${esc(e.aliases.join(", "))}</small>` : ""}</td>
        <td class="description">${esc(e.description)}</td>
        <td>${esc(nameOf(e.equipment_id, equipment))}</td>
        <td>${esc(nameOf(e.muscle_group_id, muscleGroups))}</td>
        <td>${bodyHtml(e, "small")}</td>
        <td>${esc(namesOf(e.primary_muscle_ids, muscles))}</td>
        <td>${esc(namesOf(e.secondary_muscle_ids, muscles))}</td>
        <td>${esc(tracks(e))}</td>
        <td>${e.verified ? "yes" : "no"}</td>
        <td>${e.id}</td>
      </tr>`)
    .join("");
}

const views = {
  library: () => `
    <div class="toolbar">
      <input class="grow" data-bind="filter" value="${esc(state.filter)}" placeholder="Filter ${state.data.exercises.length} exercises by name, alias or description">
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Name / aliases</th><th>Description</th><th>Equipment</th><th>Muscle group</th>
        <th>Body</th><th>Primary muscles</th><th>Secondary muscles</th><th>Tracks</th><th>Verified</th><th>ID</th>
      </tr></thead>
      <tbody id="library-rows">${libraryRows()}</tbody>
    </table></div>`,

  ideas: () => `
    <div class="card">
      <form class="row" data-form="add-idea">
        <input class="grow" data-bind="title" value="${esc(state.title)}" maxlength="50" placeholder="Your own exercise title, e.g. Zercher Squat" required>
        <button>Add idea</button>
      </form>
    </div>
    <div class="card">
      <form data-form="generate-ideas">
        <textarea data-bind="prompt" placeholder="Optional instructions for the ideas, e.g. &quot;focus on kettlebell exercises&quot;">${esc(state.prompt)}</textarea>
        <div class="actions" style="margin-top: 8px">
          <button ${state.ideasBusy ? "disabled" : ""}>${state.ideasBusy ? "Finding ideas …" : "Generate 10 ideas"}</button>
          ${state.ideas.length ? `<button type="button" class="secondary" data-action="generate-all" ${state.ideas.every((idea) => state.busy.has(idea.id) || existing(idea.name)) ? "disabled" : ""}>Generate all</button>` : ""}
          ${state.ideas.length ? `<button type="button" class="danger" data-action="clear-ideas">Remove all ideas</button>` : ""}
        </div>
      </form>
    </div>
    ${state.ideas.map(ideaCard).join("") || `<p class="empty">No ideas yet. Add a title yourself or let Claude find exercises that are missing in the library.</p>`}`,

  proposed: () =>
    state.proposals.map(proposalCard).join("") ||
    `<p class="empty">No proposed exercises yet. Press "Generate" on an idea to let Claude fill in its fields.</p>`,

  staged: () => {
    const uploading = state.staged.some((e) => state.busy.has(e.id));
    return state.staged.length
      ? `<div class="toolbar">
           <span class="grow hint">Uploaded exercises are created on gym2.app as unverified exercises of your account.</span>
           <button data-action="upload-all" ${uploading ? "disabled" : ""}>Upload all (${state.staged.length})</button>
         </div>
         ${state.staged.map(stagedCard).join("")}`
      : `<p class="empty">Nothing staged. Stage a proposed exercise to upload it from here.</p>`;
  },
};

function ideaCard(idea) {
  const busy = state.busy.has(idea.id);
  return `
    <div class="card row" data-id="${idea.id}">
      <div class="grow">
        <b>${esc(idea.name)}</b>
        ${existing(idea.name) ? `<span class="badge warn">already exists</span>` : ""}
        <div class="hint">${esc(idea.reason || "Your own idea")}</div>
        ${errorLine(idea.id)}
      </div>
      <a class="button secondary" href="https://www.google.com/search?q=${encodeURIComponent(`${idea.name} exercise`)}" target="_blank" rel="noopener">Search in internet</a>
      <button data-action="generate" ${busy ? "disabled" : ""}>${busy ? "Generating …" : "Generate"}</button>
      <button class="danger" data-action="remove-idea" ${busy ? "disabled" : ""}>Remove</button>
    </div>`;
}

function proposalCard(p) {
  const { equipment, muscleGroups, muscles } = state.data;
  const busy = state.busy.has(p.id);
  const options = (items, selected) =>
    `<option value="">–</option>` +
    items.map((item) => `<option value="${item.id}" ${item.id === selected ? "selected" : ""}>${esc(item.name)}</option>`).join("");
  const muscleChecks = (field) =>
    muscles
      .map((m) => `<label><input type="checkbox" data-field="${field}" value="${m.id}" ${p[field].includes(m.id) ? "checked" : ""}>${esc(m.name)}</label>`)
      .join("");

  return `
    <div class="card ${busy ? "busy" : ""}" data-id="${p.id}">
      <div class="with-body">
      <div class="fields">
        <label><span>Name (max. 50)</span><input data-field="name" maxlength="50" value="${esc(p.name)}"></label>
        <label><span>Aliases (comma separated)</span><input data-field="aliases" value="${esc(p.aliases.join(", "))}"></label>
        <label class="wide"><span>Description (max. 1000)</span><textarea data-field="description" maxlength="1000" rows="4">${esc(p.description)}</textarea></label>
        <label><span>Equipment</span><select data-field="equipment_id">${options(equipment, p.equipment_id)}</select></label>
        <label><span>Muscle group</span><select data-field="muscle_group_id">${options(muscleGroups, p.muscle_group_id)}</select></label>
        <fieldset class="wide"><legend>Primary muscles</legend><div class="checks">${muscleChecks("primary_muscle_ids")}</div></fieldset>
        <fieldset class="wide"><legend>Secondary muscles</legend><div class="checks">${muscleChecks("secondary_muscle_ids")}</div></fieldset>
        <fieldset class="wide"><legend>Tracks</legend><div class="checks">
          ${METRICS.map((metric) => `<label><input type="checkbox" data-field="${metric}" ${p[metric] ? "checked" : ""}>${metric}</label>`).join("")}
        </div></fieldset>
      </div>
      ${bodyHtml(p)}
      </div>
      ${errorLine(p.id)}
      <div class="actions">
        <button data-action="stage" ${busy ? "disabled" : ""}>Stage</button>
        <button class="danger" data-action="delete-proposal" ${busy ? "disabled" : ""}>Delete</button>
        <input class="grow" data-note value="${esc(state.notes[p.id])}" ${busy ? "disabled" : ""} placeholder="Optional note for Claude, e.g. &quot;shorter, and it is a cable exercise&quot;">
        <button class="secondary" data-action="regenerate" ${busy ? "disabled" : ""}>${busy ? "Regenerating …" : "Regenerate"}</button>
      </div>
    </div>`;
}

function stagedCard(e) {
  const { equipment, muscleGroups, muscles } = state.data;
  const busy = state.busy.has(e.id);
  return `
    <div class="card" data-id="${e.id}">
      <h2>${esc(e.name)}</h2>
      <div class="with-body">
      <dl>
        <dt>Description</dt><dd>${esc(e.description) || "–"}</dd>
        <dt>Aliases</dt><dd>${esc(e.aliases.join(", ")) || "–"}</dd>
        <dt>Equipment</dt><dd>${esc(nameOf(e.equipment_id, equipment))}</dd>
        <dt>Muscle group</dt><dd>${esc(nameOf(e.muscle_group_id, muscleGroups))}</dd>
        <dt>Primary muscles</dt><dd>${esc(namesOf(e.primary_muscle_ids, muscles))}</dd>
        <dt>Secondary muscles</dt><dd>${esc(namesOf(e.secondary_muscle_ids, muscles))}</dd>
        <dt>Tracks</dt><dd>${esc(tracks(e))}</dd>
      </dl>
      ${bodyHtml(e)}
      </div>
      ${errorLine(e.id)}
      <div class="actions">
        <button data-action="upload" ${busy ? "disabled" : ""}>${busy ? "Uploading …" : "Upload"}</button>
        <button class="secondary" data-action="unstage" ${busy ? "disabled" : ""}>Back to proposed</button>
      </div>
    </div>`;
}

const errorLine = (id) => (state.errors[id] ? `<p class="error">${esc(state.errors[id])}</p>` : "");

function render() {
  const counts = { library: state.data?.exercises.length, ideas: state.ideas.length, proposed: state.proposals.length, staged: state.staged.length };
  $("#tabs").innerHTML = Object.entries(TABS)
    .map(([tab, label]) => `<button data-tab="${tab}" class="${tab === state.tab ? "active" : ""}">${label}${counts[tab] ? ` (${counts[tab]})` : ""}</button>`)
    .join("");
  $("#view").innerHTML = state.data
    ? views[state.tab]()
    : `<p class="empty">Enter your session token of gym2.app and load the exercises to start.</p>`;
  if (state.data) fillBodies();
}

// ---------- Actions ----------

async function loadData() {
  flash("Loading the exercises from gym2.app …");
  try {
    state.data = await api("/api/data");
    state.data.exercises.sort((a, b) => a.name.localeCompare(b.name));
    flash("");
  } catch (e) {
    flash(e.message, true);
  }
  render();
}

async function generateIdeas() {
  state.ideasBusy = true;
  render();
  try {
    const { ideas } = await api("/api/ideas", {
      existing: state.data.exercises.map(({ name, aliases }) => ({ name, aliases })),
      pending: [...state.ideas, ...state.proposals, ...state.staged].map((item) => item.name),
      prompt: state.prompt,
    });
    state.ideas.push(...ideas.map((idea) => ({ id: crypto.randomUUID(), ...idea })));
    save();
    flash("");
  } catch (e) {
    flash(e.message, true);
  }
  state.ideasBusy = false;
  render();
}

/** Lets Claude fill in the fields of an exercise. `revision` is { current, note } when it is regenerated. */
function requestExercise(title, revision = {}) {
  const { exercises, equipment, muscleGroups, muscles } = state.data;
  return api("/api/generate", {
    title,
    equipment,
    muscleGroups,
    muscles: muscles.map(({ id, name }) => ({ id, name })),
    examples: exercises
      .filter((e) => e.verified && e.description)
      .slice(0, 5)
      .map(({ id, verified, ...example }) => example),
    ...revision,
  });
}

async function generateExercise(idea) {
  state.busy.add(idea.id);
  delete state.errors[idea.id];
  render();
  try {
    const exercise = await requestExercise(idea.name);
    // The client UUID makes the upload safe to repeat: the server returns the exercise instead of creating it twice
    const proposal = { id: crypto.randomUUID(), client_uuid: crypto.randomUUID(), ...exercise };
    state.proposals.push(proposal);
    state.ideas = state.ideas.filter((item) => item.id !== idea.id);
    save();
  } catch (e) {
    state.errors[idea.id] = e.message;
  }
  state.busy.delete(idea.id);

  // Only adds the new card on the proposed screen, a full render would interrupt the editing there
  if (state.tab === "proposed" && state.proposals.length > 1 && !state.errors[idea.id]) {
    $("#view").insertAdjacentHTML("beforeend", proposalCard(state.proposals.at(-1)));
    fillBodies($("#view").lastElementChild);
    $(`#tabs [data-tab="proposed"]`).textContent = `${TABS.proposed} (${state.proposals.length})`;
  } else {
    render();
  }
}

/** Renders one proposed exercise again, the others may be edited at the moment. */
function refreshCard(id) {
  const card = $(`#view [data-id="${id}"]`);
  const proposal = state.proposals.find((p) => p.id === id);
  if (state.tab !== "proposed" || !card || !proposal) return;
  card.outerHTML = proposalCard(proposal);
  fillBodies($(`#view [data-id="${id}"]`));
}

async function regenerate(proposal) {
  state.busy.add(proposal.id);
  delete state.errors[proposal.id];
  refreshCard(proposal.id);
  try {
    const { id, client_uuid, ...current } = proposal;
    Object.assign(proposal, await requestExercise(proposal.name, { current, note: state.notes[id] || "" }));
    delete state.notes[id];
    save();
  } catch (e) {
    state.errors[proposal.id] = e.message;
  }
  state.busy.delete(proposal.id);
  refreshCard(proposal.id);
}

async function upload(exercise) {
  state.busy.add(exercise.id);
  delete state.errors[exercise.id];
  render();
  try {
    const { id, ...payload } = exercise;
    const created = await api("/api/upload", payload);
    state.staged = state.staged.filter((item) => item.id !== exercise.id);
    if (!state.data.exercises.some((e) => e.id === created.id)) {
      const { image_urls, client_uuid, ...row } = created;
      state.data.exercises.push(row);
      state.data.exercises.sort((a, b) => a.name.localeCompare(b.name));
    }
    save();
    flash(`Created "${created.name}" on gym2.app (ID ${created.id}).`);
  } catch (e) {
    state.errors[exercise.id] = e.message;
  }
  state.busy.delete(exercise.id);
  render();
}

function move(id, from, to) {
  const item = state[from].find((entry) => entry.id === id);
  state[from] = state[from].filter((entry) => entry.id !== id);
  state[to].push(item);
}

const actions = {
  generate: (id) => generateExercise(state.ideas.find((idea) => idea.id === id)),
  "generate-all": async () => {
    // Ideas that already exist are skipped. All are marked as busy right away, but only 3 run at the same time
    const queue = state.ideas.filter((idea) => !state.busy.has(idea.id) && !existing(idea.name));
    for (const idea of queue) state.busy.add(idea.id);
    const worker = async () => {
      while (queue.length) await generateExercise(queue.shift());
    };
    await Promise.all([worker(), worker(), worker()]);
  },
  regenerate: (id) => regenerate(state.proposals.find((p) => p.id === id)),
  "remove-idea": (id) => (state.ideas = state.ideas.filter((idea) => idea.id !== id)),
  "clear-ideas": () => (state.ideas = state.ideas.filter((idea) => state.busy.has(idea.id))),
  "delete-proposal": (id) => (state.proposals = state.proposals.filter((p) => p.id !== id)),
  stage: (id) => {
    const issues = problems(state.proposals.find((p) => p.id === id));
    if (issues.length) state.errors[id] = `Cannot be staged: ${issues.join(", ")}.`;
    else {
      delete state.errors[id];
      move(id, "proposals", "staged");
    }
  },
  unstage: (id) => {
    delete state.errors[id];
    move(id, "staged", "proposals");
  },
  upload: (id) => upload(state.staged.find((e) => e.id === id)),
  "upload-all": async () => {
    // One after the other, to stay far below the rate limit of the API
    for (const exercise of [...state.staged]) await upload(exercise);
  },
};

/** Writes the change of a form field into its proposed exercise. Does not render, to keep the focus. */
function editProposal(input) {
  const card = input.closest("[data-id]");
  const proposal = state.proposals.find((p) => p.id === card.dataset.id);
  const field = input.dataset.field;

  if (field === "aliases") {
    proposal.aliases = input.value.split(",").map((alias) => alias.trim()).filter(Boolean);
  } else if (field.endsWith("_muscle_ids")) {
    const id = Number(input.value);
    proposal[field] = input.checked ? [...proposal[field], id] : proposal[field].filter((other) => other !== id);
    // A muscle is either primary or secondary
    const otherField = field === "primary_muscle_ids" ? "secondary_muscle_ids" : "primary_muscle_ids";
    if (input.checked && proposal[otherField].includes(id)) {
      proposal[otherField] = proposal[otherField].filter((other) => other !== id);
      card.querySelector(`[data-field="${otherField}"][value="${id}"]`).checked = false;
    }
    const body = card.querySelector(".body");
    body.dataset.primary = proposal.primary_muscle_ids.join(",");
    body.dataset.secondary = proposal.secondary_muscle_ids.join(",");
    fillBody(body);
  } else if (field.endsWith("_id")) {
    proposal[field] = Number(input.value) || null;
  } else {
    proposal[field] = input.type === "checkbox" ? input.checked : input.value;
  }
  save();
}

// ---------- Events ----------

$("#token").value = state.token;

$("#token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.token = $("#token").value.trim();
  localStorage.setItem("token", JSON.stringify(state.token));
  loadData();
});

$("#tabs").addEventListener("click", (event) => {
  const tab = event.target.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  render();
});

$("#view").addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  const result = actions[action](event.target.closest("[data-id]")?.dataset.id);
  // The asynchronous actions render themselves
  if (!(result instanceof Promise)) {
    save();
    render();
  }
});

$("#view").addEventListener("input", (event) => {
  const input = event.target;
  if (input.dataset.field) editProposal(input);
  if ("note" in input.dataset) state.notes[input.closest("[data-id]").dataset.id] = input.value;
  if (input.dataset.bind) state[input.dataset.bind] = input.value;
  if (input.dataset.bind === "filter") {
    $("#library-rows").innerHTML = libraryRows();
    fillBodies();
  }
});

$("#view").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.dataset.form === "add-idea") {
    if (!state.title.trim()) return;
    state.ideas.unshift({ id: crypto.randomUUID(), name: state.title.trim(), reason: "" });
    state.title = "";
    save();
    render();
  } else {
    generateIdeas();
  }
});

addEventListener("pagehide", saveNow);

render();
loadState().then(() => {
  render();
  if (state.token) loadData();
});
