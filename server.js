// Exercise Adder: a tiny local server with no dependencies.
// It serves the page in public/, forwards requests to the Gym 2.0 API (the browser cannot send
// the session cookie to another origin itself) and runs the local claude CLI for the generations.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT) || 4321;
const GYM_API_URL = process.env.GYM_API_URL || "https://api.gym2.app/v1";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = "claude-opus-5-5";

// The ideas, the proposed and the staged exercises
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const PUBLIC_DIR = path.join(__dirname, "public");
const PROMPT_DIR = path.join(__dirname, "prompts");
const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Gym 2.0 API ----------

async function gym(token, apiPath, options = {}) {
  if (!token) throw new HttpError(401, "Enter your session token first.");

  let res;
  try {
    res = await fetch(GYM_API_URL + apiPath, { ...options, headers: { Cookie: `session_token=${token}` } });
  } catch (e) {
    throw new HttpError(502, `Could not reach ${GYM_API_URL}: ${e.message}`);
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const detail = body?.detail ?? text.slice(0, 300);
    throw new HttpError(res.status, `Gym 2.0 answered ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return body;
}

async function loadData(token) {
  const [list, equipment, muscleGroups, muscles] = await Promise.all([
    gym(token, "/exercises"),
    gym(token, "/exercises/equipment"),
    gym(token, "/exercises/muscle-groups"),
    gym(token, "/exercises/muscles"),
  ]);
  return {
    // The images of the exercises are left out on purpose
    exercises: list.exercises.map(({ image_urls, client_uuid, ...exercise }) => exercise),
    equipment,
    muscleGroups,
    muscles, // with image_url, the hash of the image that shows where the muscle is on the body
  };
}

/** Passes an image of the API on, used for the images of the muscles on the highlighted body. */
async function sendImage(token, hash, res) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(404, "Not found.");
  const image = await fetch(`${GYM_API_URL}/images/${hash}`, { headers: { Cookie: `session_token=${token}` } });
  if (!image.ok) throw new HttpError(image.status, `Gym 2.0 answered ${image.status} for the image.`);
  // An image never changes under the same hash
  res.writeHead(200, { "Content-Type": image.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
  res.end(Buffer.from(await image.arrayBuffer()));
}

function uploadExercise(token, exercise) {
  // The endpoint takes multipart/form-data, lists are sent as repeated fields
  const form = new FormData();
  form.append("client_uuid", exercise.client_uuid);
  form.append("name", exercise.name);
  if (exercise.description) form.append("description", exercise.description);
  for (const alias of exercise.aliases || []) form.append("aliases", alias);
  form.append("muscle_group_id", String(exercise.muscle_group_id));
  form.append("equipment_id", String(exercise.equipment_id));
  for (const id of exercise.primary_muscle_ids || []) form.append("primary_muscle_ids", String(id));
  for (const id of exercise.secondary_muscle_ids || []) form.append("secondary_muscle_ids", String(id));
  for (const metric of ["reps", "weights", "time", "intensity", "distance"]) form.append(metric, String(Boolean(exercise[metric])));

  return gym(token, "/exercises", { method: "POST", body: form });
}

// ---------- Stored state ----------

function readState() {
  const state = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : {};
  return { ideas: state.ideas || [], proposals: state.proposals || [], staged: state.staged || [] };
}

function writeState({ ideas, proposals, staged }) {
  if (![ideas, proposals, staged].every(Array.isArray)) throw new HttpError(400, "Invalid state.");
  // Written to a second file first, so that a crash while writing cannot destroy the data
  fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify({ ideas, proposals, staged }, null, 2) + "\n");
  fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  return {};
}

// ---------- Claude CLI ----------

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, reason: { type: "string" } },
        required: ["name", "reason"],
      },
    },
  },
  required: ["ideas"],
};

const EXERCISE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    equipment_id: { type: "integer" },
    muscle_group_id: { type: "integer" },
    primary_muscle_ids: { type: "array", items: { type: "integer" } },
    secondary_muscle_ids: { type: "array", items: { type: "integer" } },
    reps: { type: "boolean" },
    weights: { type: "boolean" },
    time: { type: "boolean" },
    intensity: { type: "boolean" },
    distance: { type: "boolean" },
  },
  required: [
    "name", "description", "aliases", "equipment_id", "muscle_group_id", "primary_muscle_ids",
    "secondary_muscle_ids", "reps", "weights", "time", "intensity", "distance",
  ],
};

/** Runs `claude -p` with the prompt file as system prompt and returns the JSON that matches the schema. */
function askClaude(promptFile, schema, message) {
  const args = [
    "-p",
    "--model", CLAUDE_MODEL,
    "--system-prompt", fs.readFileSync(path.join(PROMPT_DIR, promptFile), "utf8"),
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--tools", "", // plain text generation, no tools
  ];

  return new Promise((resolve, reject) => {
    // Started outside the project, so that no project settings or CLAUDE.md are picked up
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (e) => reject(new HttpError(500, `Could not start the claude CLI (${e.message}). Is it installed?`)));
    child.on("close", () => {
      try {
        const output = JSON.parse(stdout);
        if (output.is_error) throw new Error(output.result);
        resolve(output.structured_output ?? JSON.parse(output.result));
      } catch (e) {
        reject(new HttpError(502, `Claude did not return a usable answer: ${(stderr || e.message).slice(0, 300)}`));
      }
    });
    child.stdin.end(message);
  });
}

// Only ID and name go to Claude
const idList = (items) => items.map((item) => `${item.id}: ${item.name}`).join("\n");

async function generateIdeas({ existing = [], pending = [], prompt = "" }) {
  const message = [
    "# Exercises that already exist in Gym 2.0 (other names in brackets)",
    existing.map((e) => `- ${e.name}${e.aliases?.length ? ` [${e.aliases.join(", ")}]` : ""}`).join("\n") || "(none)",
    "# Exercises that are already suggested or in preparation (do not suggest them again)",
    pending.map((name) => `- ${name}`).join("\n") || "(none)",
    "# Additional instructions of the admin",
    prompt.trim() || "(none)",
  ].join("\n\n");

  const { ideas } = await askClaude("ideas.md", IDEAS_SCHEMA, message);
  return { ideas: ideas.map((idea) => ({ name: idea.name.trim().slice(0, 50), reason: idea.reason })) };
}

async function generateExercise({ title, equipment, muscleGroups, muscles, examples = [], current, note }) {
  const message = [
    `# Exercise to describe\n\n${title}`,
    `# Equipment (id: name)\n\n${idList(equipment)}`,
    `# Muscle groups (id: name)\n\n${idList(muscleGroups)}`,
    `# Muscles (id: name)\n\n${idList(muscles)}`,
    `# Existing exercises as examples of the style\n\n${JSON.stringify(examples, null, 2)}`,
    // Only when an admin regenerates a proposed exercise
    current && `# Current version to revise\n\n${JSON.stringify(current, null, 2)}`,
    current && `# Note of the admin\n\n${note?.trim() || "(none, create a better version)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const exercise = await askClaude("exercise.md", EXERCISE_SCHEMA, message);

  // The limits of the API, and no IDs that do not exist
  const validIds = (ids, items) => [...new Set(ids)].filter((id) => items.some((item) => item.id === id));
  const primary = validIds(exercise.primary_muscle_ids, muscles);
  return {
    ...exercise,
    name: exercise.name.trim().slice(0, 50),
    description: exercise.description.trim().slice(0, 1000),
    aliases: exercise.aliases.map((alias) => alias.trim().slice(0, 50)).filter(Boolean).slice(0, 20),
    primary_muscle_ids: primary,
    secondary_muscle_ids: validIds(exercise.secondary_muscle_ids, muscles).filter((id) => !primary.includes(id)),
  };
}

// ---------- HTTP server ----------

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] || "").startsWith("application/json")) {
      return reject(new HttpError(415, "Expected application/json."));
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function serveFile(urlPath, res) {
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath === "/" ? "/index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, "Not found.");
  }
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(file));
}

async function route(req, res) {
  // Only requests that were made to localhost itself. Otherwise a website could reach this server
  // through a domain that points to 127.0.0.1 (DNS rebinding) and read the data or start generations.
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new HttpError(403, "Only available on localhost.");

  const urlPath = new URL(req.url, "http://localhost").pathname;
  const token = (req.headers["x-session-token"] || "").trim();
  const key = `${req.method} ${urlPath}`;

  if (req.method === "GET" && !urlPath.startsWith("/api/")) return serveFile(urlPath, res);
  if (req.method === "GET" && urlPath.startsWith("/api/images/")) return sendImage(token, urlPath.slice("/api/images/".length), res);

  let result;
  if (key === "GET /api/data") result = await loadData(token);
  else if (key === "GET /api/state") result = readState();
  else if (key === "POST /api/state") result = writeState(await readJson(req));
  else if (key === "POST /api/ideas") result = await generateIdeas(await readJson(req));
  else if (key === "POST /api/generate") result = await generateExercise(await readJson(req));
  else if (key === "POST /api/upload") result = await uploadExercise(token, await readJson(req));
  else throw new HttpError(404, "Not found.");

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

http
  .createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!e.status) console.error(e);
      res.writeHead(e.status || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  })
  // Only reachable from this computer
  .listen(PORT, "127.0.0.1", () => console.log(`Exercise Adder runs at http://localhost:${PORT} (API: ${GYM_API_URL}, data: ${DATA_FILE})`));
