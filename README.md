# Family meal planner

A small self-hosted web app for a household's weekly shopping lists, meal plan and exercise plan. It works well on phones and can be added to the home screen like an app.

- **Shopping lists** for each week, shared by everyone. Tick items off, mark things you already have "At home", search each item at Coles, and see who ticked what and when.
- **Meal plan** with recipes that scale to each person's portion. Everyone ticks the meals they have eaten and can **rate each meal out of 10** with a note about what they did not like.
- **Exercise plan**, either one plan for everyone or a separate plan for each person, with sessions to tick off.
- **Ratings summary** for admins: every dish with everyone's scores and notes, lowest first, so you can see which meals to change.
- **Calendar**: add a person's suggested eating times to Apple Calendar, Google Calendar or Outlook as repeating events.
- **Logins** for each person with a proper login page. People stay logged in on their devices. Admins can see everyone's ticks, ratings and notes, and other people only see their own.
- Works offline once installed (over HTTPS), and syncs when back online.

Everything the app shows comes from one file, `site/plan.json`, which you can write by hand or ask an AI to write for you (see below).

Built with [Claude Code](https://claude.com/claude-code).

## How it is built

Two small Docker containers, no database and no npm packages:

- **Caddy** serves the page (`site/`) and checks every request is logged in.
- **A tiny Node server** (`api/`) handles logins, saves ticks and ratings to one file (`data/state.json`) and makes calendar files.

## Quick start

You need a Linux machine (or a Proxmox container, see below) with Docker.

    git clone https://github.com/scoregie/family-meal-planner.git
    cd family-meal-planner
    cp .env.example .env
    cp site/plan.example.json site/plan.json

Make a password hash for each person and add it to `.env`:

    docker compose run --rm api node /app/hash-password.js 'their password'
    nano .env      # one line per person: LOGIN_<USERNAME>=<hash>

Then start it:

    docker compose up -d

Open `http://<server-ip>/` and log in. Logs: `docker compose logs -f`.

### Running it in a Proxmox container

1. Download a **Debian 12** template (Node > local storage > CT Templates).
2. Create a CT with 1 core, 512 MB RAM and a 4 GB disk on your LAN.
3. Before starting it, open the CT > Options > Features and tick **Nesting** and **keyctl** (needed for Docker in an unprivileged container).
4. Start it, then install Docker and git: `apt update && apt install -y curl git && curl -fsSL https://get.docker.com | sh`
5. Follow the quick start above.

## People, logins and admins

People in the app (whose ticks and ratings are whose) come from the `"people"` block in `plan.json`. Logins are set in `.env`:

    LOGIN_ALEX=scrypt....          # one line per login, made with hash-password.js
    LOGIN_SAM=scrypt....
    ADMIN_USERS=alex               # admins see everyone's ticks, ratings and notes, and can reset everything
    PERSON_ALEX=alex               # which person a login ticks as (default: the username)

- **Shopping lists** are shared by everyone. Each ticked item shows who ticked it and when.
- **Meal and exercise ticks, ratings and notes** are private. Each person only sees their own. Admins get a "Ticks for" picker to see anyone's, plus a **Ratings** tab.
- Usernames are not case-sensitive. After changing `.env`, run `docker compose up -d`.
- **Changing a password:** make a new hash, replace that person's line, then `docker compose up -d`. This logs that person out on every device.
- People stay logged in on each device until they press **Log out**. A login lasts 400 days and renews each day the app is opened.
- 10 wrong passwords from one address locks logins from that address for 15 minutes.
- The login cookie is signed with a random key in `data/session-secret`. Deleting it logs everyone out.

## Adding people and the About me questions

Admins can add someone from **Edit plan → People**: their name, a username, a starting password, their portion and whether they are an admin. They can log in straight away, and they are added to the plan with a backup kept first. Logins added this way are stored in `data/app.db`. Logins in `.env` keep working as before.

Everyone has an **About me** page in the account menu, with questions about their goals, health, food, week, exercise and budget (the questions are in `site/questions.json`, so you can change them). Answers save as you type. Only the person and admins can see them. Until someone has answered, the app shows a small prompt asking them to. People with a login added from the app can change their password on the same page.

## Uploading files

Everyone gets a **My files** page in the account menu (top right) for things that help with the plan: Lose It exports, Apple Health exports, blood tests, photos and anything else. Each person only sees their own files. Admins can see, add and delete everyone's.

Files are stored in plain folders on the server, one per person and then one per type, with the upload date at the front of the name:

    data/uploads/alex/blood-tests/2026-11-08 Blood results.pdf

The types are `lose-it`, `apple-health`, `blood-tests`, `photos` and `other`. `data/uploads/README.txt` explains the layout. Files can be up to 2 GB, which is enough for an Apple Health export. You can also add or remove files in these folders directly; the page just lists what is there.

## Meal history (the database)

The app keeps a small database, `data/app.db` (SQLite, built into Node, so nothing to install). `plan.json` is still the current plan and `data/state.json` still holds this fortnight's ticks. The database is for the long run:

- **Meal history:** every meal someone ticks as eaten or rates, with the dish, score, note and when it was eaten. It is kept after **Reset all** and after loading a new plan, so you can look back week on week.
- **Dishes:** every dish and recipe that has been in a plan, with its macros, how often it has been eaten and its average score, even after it leaves the plan.
- Room for weigh-ins, people's answers to the getting-started questions, change requests and settings (coming next).

`GET /api/history` gives your own history (admins can add `?person=`), and `GET /api/dishes` (admins) lists every dish. To look inside it yourself, use any SQLite viewer, or `sqlite3 data/app.db ".tables"`.

## Changing the plan

Everything the page shows (meals, recipes, shopping lists and exercise) comes from `site/plan.json`. Replace that file to change the plan. No restart is needed.

**Edit it in the app.** Admins get an **Edit plan** link in the account menu (top right). It edits meals (including a different meal for one person on a day), macros for each dish, and shopping items and prices, and has a raw JSON editor for everything else. Each save keeps the previous plan in `data/plan-backups/` (the last 30), and you can restore one from the Backups tab. Shopping ticks stay with an item as long as its name does not change. After updating to this version, run `docker compose up -d` once so the api container can write to `site/`.

**Ask an AI to write it.** Fill in the [brackets] in `plan-prompt.example.txt`, send it to Claude (or another AI) with your current `plan.json` attached as the format example, and save the JSON it gives you as `site/plan.json`. Keep a copy of the old one first.

**Or edit it by hand.** [docs/plan-format.md](docs/plan-format.md) explains every field in plain English. The scripts in [tools/](tools/README.md) can estimate macros and check the shopping lists cover the recipes. Each week looks like this:

    {
      "name": "Week 1",
      "meals":   [ {"day": "Mon", "breakfast": "...", "lunch": "...", "dinner": "..."} ],
      "recipes": [ "Chilli: turkey mince, kidney beans, ..." ],
      "shopping": {
        "Fruit and veg": [ ["Tomatoes × 2", 2.5], ["Baby spinach 280 g", 5] ],
        "Meat and fish": [ ["Turkey mince 500 g × 2", 13] ]
      },
      "exercise": { "focus": "...", "targets": ["..."], "days": [ {"day": "Mon", "morning": "...", "afternoon": "..."} ] }
    }

- Any number of weeks and any section names. Items are `["name", price]` with the price as a plain number.
- A week with `"kind": "stockup"` is a shopping-only week (for pantry and freezer items).
- Change the top-level `"id"` when you load a brand new plan, so everyone starts with clean ticks.
- "At home" marks are remembered by ingredient name across plans.
- Check the file before saving: `python3 -m json.tool site/plan.json > /dev/null && echo OK`. If it has a mistake, the page shows a red message saying what is wrong.

### People and portions

The optional top-level `"people"` block lists each person: `name`, `portion` (1.0 is an average serve), `guide`, `snacks`, and optionally `times` (suggested eating times, which can be added to a calendar). A child can have a `breakfast` and a `weekday` map (Mon to Fri) with a packed `lunch` and school `snack`.

Recipe objects can include `"items": [{"q": 350, "l": "g yoghurt", "i": 0}]` and `"units"`. With these, picking a person on the Meals tab scales the recipe to one serve for them.

### Exercise for each person

A week's `"exercise"` can be one plan for everyone (`{"focus", "targets", "days"}`), or one plan per person, keyed by the person's key in `"people"`:

    "exercise": {
      "adult1": { "focus": "...", "targets": ["..."], "days": [ ... ] },
      "adult2": { "focus": "...", "targets": ["..."], "days": [ ... ] }
    }

The top-level `"exercise"` block (workout details in `"workouts"`, tips in `"notes"`, demo links in `"videos"`) can be shared or per person in the same way. Each person sees their own plan on the Exercise tab. See `site/plan.example.json` for a full example.

## Calendar

On the Meals tab, pick a person whose guide has suggested eating times. Under the times:

- **Apple Calendar** opens a calendar file with every time as a repeating event (4 weeks from tomorrow, with a 10-minute reminder). On iPhone, tap **Add All**. Outlook can open the same file.
- **Google Calendar** lists one "Add" link per time. To add them all at once, save the Apple file and import it at calendar.google.com (Settings, Import and export).

Times like "6:30 to 7:30 am (Mon to Fri)" repeat on weekdays only.

## Using it on an iPhone

1. Open the address in **Safari** and log in.
2. Tap Share, then **Add to Home Screen**.
3. Open it from the new icon. It runs full screen like an app.

- **HTTPS is needed for offline use.** On plain `http://` the app works but needs a connection to open.
- The home-screen app has its own login, separate from Safari, so log in once inside the app.

## HTTPS and access away from home

Logging in over plain HTTP sends the password unencrypted, which is fine on your own network but not over the internet. Pick one:

- **VPN (safest):** keep it on your LAN and reach it through Tailscale or WireGuard.
- **Automatic HTTPS:** set `SITE_ADDRESS=list.yourdomain.com` in `.env`, point that DNS name at your public IP, forward ports 80 and 443 to the server, uncomment the `443:443` port in `docker-compose.yml`, then `docker compose up -d`.
- **Nginx Proxy Manager:** keep `SITE_ADDRESS=:80`, add a proxy host pointing at the server's port 80 (Cache Assets off), and request an SSL certificate on the SSL tab with Force SSL on. Do not add an NPM Access List on top, as the app has its own login.

## Backups

Back up `.env` (logins), `site/plan.json` (your plan) and `data/` (ticks, ratings, meal history in `app.db`, uploads and the login key). None of these are in git. To copy `app.db` while the app is running, use `sqlite3 data/app.db ".backup app-backup.db"`, or stop the app first.

## Notes

- The page loads a font from Google Fonts and falls back to a system font without it.
- Prices are rough estimates for Coles in Australia. The "Search Coles" links open a search for each item.
