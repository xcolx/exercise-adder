# Exercise Adder

A small local add-on for admins of [Gym 2.0](https://github.com/xcolx/Gym-2.0) (hosted at
[gym2.app](https://gym2.app)). It finds exercises that are still missing in the exercise library, lets the
local [Claude Code CLI](https://claude.com/claude-code) fill in all their fields and creates them on gym2.app
after you reviewed them.

## The idea

The exercise library of Gym 2.0 is shared by all users. Adding an exercise by hand means thinking of
what is missing, writing a description and picking equipment, muscle group, muscles and tracked metrics.
This tool does the tedious part and leaves the decisions to you:

| Screen | What happens |
| --- | --- |
| **Library** | The exercises that exist on gym2.app with all their properties (without images), with a filter. |
| **1 · Ideas** | Type an exercise title yourself, or press **Generate 10 ideas** (with optional instructions like "focus on kettlebell exercises"). Claude gets the existing library and only suggests exercises that do not exist yet. **Search in internet** opens a web search for an idea in a new tab, to check what it is. **Generate** on an idea lets Claude fill in its fields and moves it to the next screen, **Generate all** does so for all ideas that do not exist yet (3 at a time). |
| **2 · Proposed** | The generated exercises: name, description, aliases, equipment, muscle group, primary and secondary muscles and tracked metrics. Edit them, then **Stage** or **Delete** them. **Regenerate** lets Claude revise an exercise, with an optional note like "shorter, and it is a cable exercise". |
| **3 · Staging** | The exercises that are ready. **Upload** creates a single one on gym2.app, **Upload all** creates all of them. |

Nothing is sent to gym2.app before you press an upload button. The ideas and the proposed and staged
exercises are stored in the file `data.json` next to `server.js`, so they survive a reload and a restart
and are the same in every browser. The file is ignored by git; delete it to start from scratch.

Uploaded exercises are created like exercises of the app: they belong to your account and are
**unverified**, so only you see them. Verify them in the admin of Gym 2.0 to publish them for everyone, and
add images there or in the app.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer (there are no npm dependencies)
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/setup), installed and logged in
  (`claude` has to work in your terminal). The generations use the model `claude-opus-5-5` and run on your
  own Claude account: every "Generate 10 ideas", "Generate" and "Regenerate" is one request that counts
  against the usage limits of your plan or is billed to you. "Generate all" starts one request per idea.
- An account on gym2.app

## Installation and start

```bash
git clone https://github.com/xcolx/exercise-adder.git
cd exercise-adder
npm start
```

Then open <http://localhost:4321>. The server only listens on your own computer (`127.0.0.1`) and only answers
requests that were made to `localhost`.

## Getting the session token

Gym 2.0 identifies you with the cookie `session_token`:

1. Log in at [gym2.app](https://gym2.app) in your browser.
2. Open the developer tools (F12 or ⌥⌘I) and go to **Application** (Chrome, Edge) or **Storage** (Firefox,
   Safari) → **Cookies** → `https://gym2.app`.
3. Copy the value of `session_token`, paste it into the field at the top of the Exercise Adder and press
   **Load exercises**.

The token is stored in the `localStorage` of your browser for `localhost:4321` and is only sent to your
local server, which passes it on to the Gym 2.0 API. Treat it like a password: whoever has it is logged in
as you. Logging out on gym2.app makes it invalid.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | Port of the local server |
| `GYM_API_URL` | `https://api.gym2.app/v1` | API of another Gym 2.0 instance, e.g. `http://localhost:5000/v1` for a local backend |
| `DATA_FILE` | `data.json` in this folder | File with the ideas and the proposed and staged exercises |
| `CLAUDE_BIN` | `claude` | Path of the claude CLI if it is not in the `PATH` |

```bash
GYM_API_URL=http://localhost:5000/v1 PORT=8080 npm start
```

## Changing what Claude generates

The instructions for Claude are plain Markdown files, they are read for every generation, so a change
applies without a restart:

- [prompts/ideas.md](prompts/ideas.md): how to find 10 exercises that are missing
- [prompts/exercise.md](prompts/exercise.md): how to fill in the fields of one exercise

## How it works

```
Browser (public/)  ──►  server.js  ──►  Gym 2.0 API   (session_token cookie)
                            │
                            └────────►  claude -p     (model claude-opus-5-5)
```

- [server.js](server.js) serves the page and has these endpoints: `GET /api/data` (exercises, equipment,
  muscle groups and muscles of gym2.app), `GET /api/images/{hash}`, `GET` and `POST /api/state` (reads and
  writes `data.json`), `POST /api/ideas`, `POST /api/generate`
  and `POST /api/upload`.
  A server is needed because a browser page on localhost cannot send the session cookie to gym2.app, and
  cannot start the claude CLI.
- For a generation the server runs `claude -p` with the prompt file as system prompt, without tools and
  with a JSON schema, so the answer always has the expected fields.
- Every proposed exercise gets a `client_uuid`. The Gym 2.0 API returns the existing exercise for a UUID it
  already knows, so uploading the same exercise twice does not create a duplicate.
- The proposed and staged exercises and the library show the **highlighted body** of the Gym 2.0 app: the
  primary muscles in red and the secondary muscles in orange. The body updates while you change the muscles
  of a proposed exercise. Like in the app, the server's image of each muscle (`GET /api/images/{hash}`,
  passed on from the Gym 2.0 API) is turned into a mask and drawn below the outline of the body
  (`public/body_black.png`, `public/body_white.png`, taken from the Gym 2.0 repository).
- [public/](public) is plain HTML, CSS and JavaScript without a build step.

## Limits of the Gym 2.0 API

- Name and aliases have at most 50 characters, the description at most 1000, there are at most 20 aliases.
- An exercise has to track at least one metric.
- Loading the exercises is limited to 10 requests per minute, creating exercises to 100 per minute.

## License

[MIT](LICENSE)
