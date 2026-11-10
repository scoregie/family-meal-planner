# How the app works

This is a guide for anyone who wants to understand or change the code, even with little coding
experience. It explains the big picture first, then what happens when you tap something, then
where each part lives. Every file also starts with a note saying what it does, and most functions
have a one-line comment above them.

## The big picture

The app is a small website that runs on your own computer or server. It has two parts, each
running in its own Docker container (a self-contained box with just what that part needs):

```
 Your phone or computer (a web browser)
            │   asks for pages and data
            ▼
 ┌─────────────────────┐   pages and pictures come straight from site/
 │  caddy (web server) │──────────────────────────────────────────────▶ site/*.html, *.js, *.png
 └─────────────────────┘
            │   /api/... and /auth/... requests are passed on
            ▼
 ┌─────────────────────┐   reads and writes
 │  api (Node.js)      │──────────────────────────────────────────────▶ data/app.db, site/plan.json,
 └─────────────────────┘                                                 data/state.json, data/uploads/
            │   only if the family chose an AI
            ▼
   Claude, OpenAI, Gemini or a local Ollama
```

- **Caddy** (`Caddyfile`) is the front door. It hands out the pages in `site/`, but first asks the
  api whether the visitor is logged in. Anything under `/api/` or `/auth/` it passes on to the api.
- **The api** (`api/`) is a Node.js program: JavaScript that runs on the server rather than in a
  browser. It checks logins, keeps the database, works out the plan, and talks to the AI.
- **The pages** (`site/*.html`) run in the browser. Each one is a single file with three parts: a
  `<style>` section (how it looks), HTML (what's on the page) and a `<script>` (what it does).

`docker-compose.yml` starts both containers. Run `docker compose up -d` to start them, and
`docker restart shopping-list-api` after changing anything in `api/`. Changes to `site/` show up
straight away, because Caddy reads the files fresh each time.

## What happens when you tap something

Take ticking off "milk" on the shopping list:

1. **The page** (`site/index.html`) notices the tap. Its script calls `fetch()`, the browser's way
   of sending a request to a web address: here `PUT /api/shared`, with the item that was ticked.
2. **Caddy** checks the login cookie by asking the api (`/auth/check` in `api/auth.js`). A cookie
   is a small note the browser keeps and sends with every request, which proves who you are.
3. **The api** gets the request in `api/server.js`. server.js offers the request to each file in
   turn (accounts, appearance, exercises and so on). Each file has a `handle()` function that
   answers if the address is one of its own, or says "not mine" so the next file can try.
4. The file that answers does the work (here, `putShared` in `server.js` saves the tick in
   `data/state.json`) and sends back an answer as **JSON**, a plain-text way of writing data like
   `{"ok": true}`.
5. **The page** gets the answer and redraws the list. Other people's phones ask the server for
   the latest ticks every 30 seconds while the app is open (`GET /api/state`), so they see it too.

Every feature works this way: a page asks, a file in `api/` answers.

## Where things are kept

| Where | What | Notes |
| --- | --- | --- |
| `site/plan.json` | The current 4-week plan: meals, recipes, shopping, exercise | Its format is explained in `docs/plan-format.md`. Old versions are in `data/plan-backups/`. |
| `data/state.json` | This fortnight's ticks (shopping, meals, exercise) | |
| `data/app.db` | The database: accounts, About me answers, history, ratings, settings, chats and more | One SQLite file. The list of tables is at the top of `api/db.js`. |
| `data/uploads/` | Files people uploaded on "My files" | One folder per person. |
| `data/encryption-key` | The key that locks saved AI keys | Back it up. Without it, saved AI keys can't be read. |
| `data/session-secret` | The secret that makes login cookies impossible to fake | |
| `.env` | Server settings: AI keys, email settings, the site address | Never shared or committed. |

Each person has a **key** made from their name: "Alex Smith" becomes `alex-smith`. Their answers,
ticks and files are all stored under that key (`toKey` in `api/server.js`).

## The files, folder by folder

### `api/`: the server

| File | What it does |
| --- | --- |
| `server.js` | The starting point. Receives every request and passes it to the right file. Also saves the plan and the ticks. |
| `auth.js` | Logging in and out, login cookies, and the "too many wrong passwords" limit. |
| `accounts.js` | Email accounts: the first account, invites, sign-ups, password resets and deleting an account. |
| `people.js` | The people in the plan and the About me questions and answers. |
| `db.js` | Every database read and write. Each function does one small job, like "get this account". |
| `appearance.js` | The household's look, country, stores, energy unit and pinned products. |
| `plandraft.js` | Plan setup: who has finished About me, which AI to use, and drafting a new plan. |
| `planbuilder.js` | The built-in plan builder: makes a whole plan from everyone's answers, with no AI. |
| `planextras.js` | What the plan writer is told about each person besides About me: their meal scores and notes, the health numbers they've logged or uploaded, and their "small steps" record. |
| `healthtargets.js` | The serves of vegetables and fruit each person's plan aims for (by age and sex), and how a plan measures up. Used by the builder, the AI's instructions and the draft preview. |
| `planchange.js` | Small, checked edits to the plan (used when someone's suggested change is approved). |
| `assistant.js` | Ask AI: the chat, the tools the AI can use to look things up, and suggested changes. |
| `ai.js` | Which AI the family uses, and talking to OpenAI, Gemini and Ollama. |
| `libraryupdates.js` | New meals and exercises every 2 weeks, shared or written by the family's AI. |
| `exercises.js` | The exercise library page: what suits whom, leaving exercises out, and swapping them. |
| `progress.js` | The progress charts, weigh-ins, and reading Lose It and Apple Health exports. |
| `healthsync.js` | Receiving numbers from the iPhone Health sync Shortcut. |
| `shortcutfile.js` | Builds the Health sync Shortcut file. |
| `uploads.js` | Uploading, downloading and deleting files on "My files". |
| `zip.js` | Reads files from inside a .zip without unpacking it (for exports). |
| `calendar.js` | Turns suggested eating times into calendar events. |
| `mailer.js` | Sends emails (invites, password resets) if email is set up. |
| `secrets.js` | Locks (encrypts) saved AI keys before they go in the database. |
| `handoff-cli.js` | Lets Claude Code draft the plan (see CLAUDE.md). |
| `hash-password.js` | Makes a password hash for the older `.env` logins. |
| `names.js` | Turns a person's name into their key (`toKey`). |

Data files: `library.json` (the builder's ingredients, meals and snacks), `library-prices.json`
(local names and prices for other countries), `library-community.json` (shared new meals),
`exercises.json` (the exercise library).

### `site/`: the pages

| File | The page |
| --- | --- |
| `index.html` | The main app: Today, Meals, Shopping, Exercise and More. The biggest file. |
| `login.html` | Logging in, the first account, invites, sign-ups and password resets. |
| `profile.html` | About me. The questions come from `questions.json`. |
| `setup.html` | Plan setup (admins). |
| `settings.html` | Settings. |
| `assistant.html` | Ask AI. |
| `progress.html` | Progress charts. |
| `exercises.html` | The exercise library. |
| `files.html` | My files. |
| `health-sync.html` | Health sync setup. |
| `family.html` | Family logins (admins). |
| `account.html` | Your account. |
| `admin.html` | Editing the plan by hand (admins). |

Shared by every page: `appearance.js` (the look, country, money and dates) and `regions.js`
(countries and their stores). Also used: `page.css` (styles shared by a few pages),
`guidelines.js` and `guidelines.json` (the healthy-eating guidelines on Meals → Macros),
`questions.json` (the About me questions), and `sw.js`, the "service worker" that keeps a copy of the app so it
still opens without a signal.

### `tools/`: scripts you run by hand

These are explained in `tools/README.md`. They build the meal library and price lists, check plans,
make offsite backups, and let Claude Code draft a plan.

## Making a change safely

1. **Find the right file** with the tables above, or search for some words you can see on the
   screen (for example `grep -rn "Plan setup" site api`).
2. **Read the comments** at the top of the file and above the function you're changing.
3. **Change a page** (`site/`): save, then reload the page in your browser.
   **Change the server** (`api/`): save, then run `docker restart shopping-list-api`.
4. **Run the tests**: `tools/test.sh` checks logins, the plan builder, allergies and more in a
   few seconds (see `tests/README.md`). Every line should show ✔.
5. **If something breaks**, the server's messages are in `docker logs shopping-list-api`, and the
   browser's are in its developer tools (F12, then Console).
6. **Undo** with git: `git diff` shows what changed, and `git checkout -- <file>` puts a file back.

Health wording has its own rules (see CLAUDE.md): health notes say "considerations", never
"advice", report what people said, and defer to their GP, dietitian or physio.
