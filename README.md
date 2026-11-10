# Family Health Planner

A self-hosted web app that plans a household's food, shopping and exercise together, for everyone in the family at once. Each person answers some questions about themselves, the app drafts a 4-week plan that fits all of them (with the AI you choose, or with its built-in plan builder and no AI at all), an adult approves it, and then the whole family uses it day to day from their phones.

It runs on your own server (two small Docker containers, for example in a Proxmox container), so the family's health details stay with you. It installs on a phone's home screen like an app and works offline.

## What it does

**Getting started**

- **About me:** each person answers questions about their goals, health, food likes and dislikes, budget, week, exercise and any support needs (for example ADHD or autism-friendly routines). Adults can answer for kids.
- **Plan setup:** an admin chooses the family's AI (Claude, OpenAI, Google Gemini, a local Ollama model, or no AI). When everyone is finished, they tap **Draft our plan**: the AI (or the built-in plan builder) writes 4 weeks of meals, snacks, recipes, priced shopping lists and an exercise plan for each person. The admin reviews it, then approves or discards it, and can rebuild it any time answers change.

**Every day**

- **Today:** the front page. Today's meals and snacks to tick (with the energy eaten so far), today's exercise to tick, the newest numbers from the phone (steps, active energy, food logged), and what's left to buy this week. Each card opens the full page. Along the bottom: **Today, Meals, Shopping, Exercise** and **More** (About me, Progress, Ask AI, the exercise library, Settings, Account, My files, and for admins Family, Plan setup, Edit plan and meal ratings).
- **Shopping:** one list per week, shared by the family, grouped by supermarket aisle. Pantry and freezer "stock-up" items fold into the week they're bought with. Tick things off (everyone sees who ticked what), mark things you already have **At home**, and use **Shop mode** to go through the list one item at a time while you walk the shop. Each item links to your chosen stores (Coles, Woolworths, IGA and others), and **Pin product** makes a link go straight to the exact product you buy.
- **Meals:** one day at a time, starting today, swipe or tap between days. Each person sees their own meals and snacks (snacks can follow their exercise, like a bigger snack on strength days), recipes scaled to their portion, and that day's considerations. Tick what you ate and rate meals out of 10, so admins can see which dishes to change.
- **Exercise:** each person's own plan, one day at a time, with the workouts for that day, tips, and the medical considerations they told the app about (written as reported, for example "you said your physio is happy for you to…"). **Swap** next to an exercise changes it for another of the same kind that suits you, and can leave the old one out of future plans.
- **Exercise library:** 94 exercises (bodyweight, bands, dumbbells, gym and seated), each with plain how-to steps, a level, and what it loads (knees, back, shoulders, wrists, floor work). Browse and search it from More.
- **Macros and guidelines** (Meals → Macros): each person's week compared with official healthy-eating guidelines (Australia, New Zealand, UK, Japan or Korea).
- **Ask AI:** a chat that can see the plan, using the family's AI or your own key. Ask it to swap a dinner, make a week cheaper or ease off an exercise day. It can only **suggest** changes; an admin approves them first.

**Tracking progress**

- **Progress dashboard:** weekly charts of weight, food energy and protein, steps, workouts and meals ticked, in kilojoules or Calories.
- **Health sync:** an iPhone Shortcut sends each day's Apple Health numbers (steps, Move, weight, and food from Lose It if it writes to Apple Health) automatically.
- **Files:** upload Lose It and Apple Health exports, blood tests and photos. Each person sees only their own; admins can see everyone's.
- **Calendar:** add suggested eating times to Apple, Google or Outlook calendars as reminders.

**The family's accounts**

- Logins by email, or a username for kids. Sign-ups wait for an admin to approve them. Roles: owner, admins and members. Meal ticks, ratings, answers and progress are private to each person and the admins.
- **Settings:** light or dark, colours, fonts, text size, kJ or Calories, the stores you shop at, the app icon, and an optional personal AI key (Claude, OpenAI or Gemini).
- **Backups:** every plan change is backed up, and a script can send encrypted offsite backups to a private GitHub repository.

**Things to know**

- It's a planning tool, not medical advice. Health notes are written as what people reported, and a GP, dietitian or physio comes first.
- Prices are estimates. Supermarkets don't let other apps add to a cart, so the app links to each item instead.
- AI features need an API key from the AI company you choose (you pay them for what you use), or a local Ollama server. Everything else, including drafting a plan with the built-in builder, works without one. If you have Claude Code on the server, it can draft the plan on your Claude subscription instead (see [Drafting the plan with Claude Code](#drafting-the-plan-with-claude-code)).

Built with [Claude Code](https://claude.com/claude-code).

**Licence:** [MIT](LICENSE). Use, change and share it freely. The meal library's nutrition data is from USDA FoodData Central, which is public domain (CC0).

## How it is built

Two small Docker containers. The only npm package is Anthropic's SDK for the optional Claude features (installed when the container starts):

- **Caddy** serves the page (`site/`) and checks every request is logged in.
- **A small Node server** (`api/`) handles logins, ticks, ratings, uploads, progress and the Claude features. This fortnight's ticks are in `data/state.json`; everything else (accounts, history, answers, measurements, chats, settings) is in a SQLite database, `data/app.db`, built into Node.
- The plan itself is one file, `site/plan.json`, which Plan setup writes for you (or you can write it by hand, see below).

## Quick start

You need a Linux machine (or a Proxmox container, see below) with Docker.

    git clone https://github.com/scoregie/family-meal-planner.git
    cd family-meal-planner
    cp .env.example .env
    cp site/plan.example.json site/plan.json

Then start it:

    docker compose up -d

Open `http://<server-ip>/` and create the family's first account (you'll be the owner), then invite everyone else from **Family** in More. Logs: `docker compose logs -f`.

### Running it in a Proxmox container

1. Download a **Debian 12** template (Node > local storage > CT Templates).
2. Create a CT on your LAN with **2 cores, 2 GB RAM (plus 512 MB swap) and a 16 GB disk**. See the sizes below.
3. Before starting it, open the CT > Options > Features and tick **Nesting** and **keyctl** (needed for Docker in an unprivileged container).
4. Start it, then install Docker and git: `apt update && apt install -y curl git && curl -fsSL https://get.docker.com | sh`
5. Follow the quick start above.

**How big?** Day to day the app is tiny (both containers together use about 30 to 50 MB of memory when idle), but some jobs need room:

| | Minimum | Recommended | Why |
|---|---|---|---|
| CPU | 1 core | 2 cores | Updates, Docker image pulls and reading big health exports go faster. |
| RAM | 1 GB | 2 GB, plus 512 MB swap | Uploading an Apple Health export (often hundreds of MB) and building plans, alongside Debian and Docker themselves. |
| Disk | 8 GB | 16 GB or more | Debian and Docker (about 2 GB), the app's images (about 350 MB), and `data/`: uploads, health exports and plan backups grow over time. |

Add more disk if the family uploads lots of photos or yearly health exports. A local **Ollama** AI needs far more (a modern GPU, or 16 GB+ of RAM for small models), so run it on a separate, more powerful machine and point `OLLAMA_URL` at it rather than putting it in this container.

### Updating

Changes are published as [releases](https://github.com/scoregie/family-meal-planner/releases), each with notes on what changed (also in [CHANGELOG.md](CHANGELOG.md)). To update, back up first (see Backups below), then in the app folder:

    git fetch --tags
    git checkout v1.0.0        # the release you want; or `git pull` to follow the latest code
    docker compose up -d
    docker compose restart api

Your `.env`, `site/plan.json` and `data/` aren't in git, so updating doesn't touch them. The database updates itself the first time the new version starts.

## People, logins and admins

Everyone logs in with their **email address (or, for kids, a username) and a password**. One family uses each server.

1. **The first account:** open the site on a new server and you're asked to create the first account. That person is the family's **owner**.
2. **Inviting people:** the owner and admins open **Family** (More) and make an invite: a name, an optional email, a portion size and (for the owner) whether they're an admin. They get a link to send by text or any messaging app. The person opens it, chooses a password and is logged in. Links work for 7 days and only once. New people are added to the plan's `"people"` block automatically (with a backup of the plan first).
3. **Signing up:** anyone can tap **Sign up** on the login page and enter their name, email and a password. They can't log in until an admin approves them under **Waiting for approval** on the Family page (or declines it), so someone who finds the address can't let themselves in. If email is set up, admins get an email about each sign-up, and the person gets one when they're approved. An invite link skips the wait.
4. **Kids without an email:** on **Plan setup** (More, admins), **Add someone without an email** adds a child to the plan. Tick **Give them a login** to choose a username and password for them; they log in with the username. Usernames must be different from everyone else's, and so must names in the family (answers, ticks and logins are matched by name). Without a login, an admin answers About me for them.
5. **Forgotten passwords:** an admin taps **Reset link** next to the person on the Family page and sends them the link (it works for 24 hours). If email is set up (below), **Forgot your password?** on the login page emails a link instead.
6. **Your own account:** **Account** (More) changes your email or password, logs you out on your other devices, or deletes your account (and, if you choose, your history: About me answers, weigh-ins, ratings, exercise and chats).

**Roles:**

- **Owner:** one person. Can do everything, including making and removing admins. They can hand ownership to someone else.
- **Admins:** edit the plan, approve changes suggested by Ask AI, see everyone's ticks, ratings and answers, invite members and make reset links.
- **Members:** see the plan, tick things off, and manage their own answers, progress and chats.

**What everyone sees:**

- **Shopping lists** are shared by everyone. Each ticked item shows who ticked it and when.
- **Meal and exercise ticks, ratings and notes** are private. Each person only sees their own. Admins get a "Ticks for" picker to see anyone's, plus a **Ratings** tab.

**Staying logged in and security:**

- People stay logged in on each device until they log out. A login lasts 400 days and renews each day the app is opened. Changing a password logs that person out everywhere else.
- 10 wrong tries from one address (logging in, invites or reset links) locks that address for 15 minutes.
- Passwords are stored scrambled with scrypt, never as plain text. Invite and reset links are stored only as hashes, so someone who reads the database can't use them.
- The login cookie is signed with a random key in `data/session-secret`. Deleting it logs everyone out.

**Older username logins:** servers set up before email accounts used `LOGIN_<NAME>=<hash>` lines in `.env` (made with `hash-password.js`) and usernames added from Edit plan. These keep working. When someone logs in with one, the app asks them to add their email on the Account page. That turns the username into an account and keeps all their history (the username keeps working as another way to log in, with the account's password). The first admin to add their email becomes the owner. `ADMIN_USERS` and `PERSON_<NAME>` in `.env` still apply to usernames that haven't been turned into accounts yet.

**Emails (optional):** without email, invites and resets are links you share yourself. To have the server send them, add to `.env` and run `docker compose up -d`:

    SMTP_URL=smtps://you%40gmail.com:your-app-password@smtp.gmail.com:465
    MAIL_FROM=Family Health Planner <you@gmail.com>
    APP_URL=https://planner.example.com      # the address people use; links in emails point here

Any email provider's SMTP settings work (for Gmail, make an "app password" in your Google account's security settings). In `SMTP_URL`, write `@` in the username as `%40`.

## About me questions

Everyone has an **About me** page in More, with questions about their goals, health, food, week, exercise and budget (the questions are in `site/questions.json`, so you can change them). Answers save as you type. Only the person and admins can see them. Until someone has answered, the app shows a small prompt asking them to. The Health section asks about medicines that can affect food or exercise (blood thinners, diabetes medicines and injections, blood pressure and heart medicines, statins, thyroid medicine, steroids, ADHD stimulants, MAOIs, supplements). These only add things to check with a doctor or pharmacist to the plan; for an MAOI the built-in builder also leaves out high-tyramine foods. At the bottom, **I'm finished** tells the admins their answers are ready for the family's plan (they can still change them afterwards).

## Plan setup: drafting the family's plan

Admins have **Plan setup** in More (and a banner on the main page while the example plan is in use):

1. **Everyone's About me answers:** who is in the plan and who has finished. Admins can answer for people without a login, and add children.
2. **Choose your AI:** Claude, OpenAI, Google Gemini or a local Ollama model (any the server has a key or address for, see [Choosing an AI](#choosing-an-ai)), and which model. Or **No AI**, which uses the built-in plan builder and turns off Ask AI for people without their own key.
3. **Draft the plan:** once everyone is finished (or earlier, if you choose), **Draft our plan** asks the AI to write a whole 4-week plan from everyone's answers and the stores you shop at: meals, snacks tied to exercise days, recipes, shopping lists with prices, exercise for each person, and medical considerations from what people said. Add a note for anything that applies to everyone. It runs in the background and takes about 5 to 10 minutes. It uses the admin's own key if they've saved one in Settings, otherwise the family's, and as one long request it costs noticeably more than a chat. **Build it without AI** uses the built-in plan builder instead (see below); it takes a second and costs nothing.
4. **Review and approve:** the draft shows each week's cost and dinners, and everyone's snacks and exercise focus. **Approve** replaces the plan (the old one is backed up first in `data/plan-backups/`) and everyone's ticks start fresh. **Discard** throws it away. After approving, Ask AI can make smaller tweaks.

**Rebuild our plan** on the same page does it again whenever answers change, for example after a new person joins.

Everyone should check their meals and exercise with their GP, dietitian or physio before starting, especially if they have a health condition, are pregnant, or take medicines. Plan setup, About me and the plan itself all say so.

### Drafting the plan with Claude Code

Chat subscriptions (Claude Pro or Max) can't be plugged into the app, but if you run [Claude Code](https://claude.com/claude-code) on the server you can ask it to write the plan, using your subscription instead of an API key. The result goes through the same checks as an AI draft and waits on Plan setup for you to approve.

1. Get everyone's About me answers in, as usual.
2. In the project folder, start Claude Code and ask: *"Draft our family plan with Claude Code"* (CLAUDE.md tells it the steps). Or by hand:
   - `tools/claude-code-plan.sh prompt "any note for the plan"` writes `data/claude-code/prompt.md`: the same instructions, format guide, example and About me answers the app's AI would get.
   - Claude Code writes the plan to `data/claude-code/plan.json`.
   - `tools/claude-code-plan.sh submit` sends it to the app.
3. Open **Plan setup**, review the draft and approve or discard it.

`data/claude-code/` holds everyone's health answers, so it stays in `data/` (which git ignores). Delete it when you're done if you like. Ask AI in the app still needs an API key; the built-in builder works without anything.

### The built-in plan builder (no AI)

The builder follows rules instead of an AI. From everyone's About me answers it:

- leaves out allergens, and anything that doesn't fit a person's diet (vegetarian, vegan, gluten free, halal and so on) or that they said they won't eat, and gives someone their own dinner on nights the family dinner doesn't suit them;
- prefers dishes that match their liked cuisines, cooking time, kitchen equipment, spice level, textures and budget, with leftovers for lunches where they can;
- sizes each person's portions from their age, height, weight, activity and goal (Mifflin-St Jeor), adds snacks tied to their exercise days, and builds shopping lists in whole packs that carry over what's left;
- writes an exercise plan that builds over 4 weeks: strength workouts picked from the exercise library (`api/exercises.json`) for the equipment they have, leaving out exercises that load anything they mentioned in their injuries (knees, back, shoulders, wrists, balance), lying on the back or front when pregnant, standing work for wheelchair users, and anything they chose to leave out; easier workouts for weeks 1 and 2 and harder ones for weeks 3 and 4, gentler where they asked, with play-based activity for kids;
- notes what people said about their health, injuries and medicines as considerations to check with their GP or pharmacist. It doesn't give medical advice.

Its meals come from `api/library.json`: 59 meals and 16 snacks, with recipes written for this project. Nutrition for each ingredient comes from **USDA FoodData Central** (U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. fdc.nal.usda.gov. SR Legacy data, public domain under CC0 1.0), with the food's id noted for each one; a few Australian products that aren't in it use typical label values, marked "label". Prices are rough Coles estimates. To change the library, edit `tools/build_library.py`, download SR Legacy (CSV) from [fdc.nal.usda.gov](https://fdc.nal.usda.gov/download-datasets) and run `python3 tools/build_library.py <the unzipped folder>`.

### New meals and exercises every 2 weeks

The builder's library grows by itself. **Plan setup → New meals and exercises** has two switches:

- **Get new ones from the Family Health Planner project** (on by default, no AI needed). Every 2 weeks the server downloads `api/library-community.json` from this project on GitHub. It's a list of meals, snacks and exercises, never code, and nothing about your family is sent. **Check now** does it straight away.
- **Have your AI write new ones for your family** (off by default; needs an AI chosen in step 2). Every 2 weeks the family's AI writes about 5 meals, a snack and 3 exercises in its own words, aimed at the cuisines you like, what people can't eat and how meals were rated (no health details are sent). They wait on Plan setup until an admin adds or discards them.

Either way, every new entry is checked before it's used: dishes may only use ingredients already in the library, with sensible amounts and energy, and the app works out their nutrition (USDA FoodData Central), allergen tags and cost itself rather than trusting the source. New entries are used the next time the plan is built or rebuilt.

**Sharing additions with everyone:** `tools/library-pr.sh` adds the ones your admins approved (`data/library-additions.json`), or any file shaped `{dishes, snacks, exercises}`, to `api/library-community.json` and opens a pull request. Once it's merged, every family's server picks them up. `DRY_RUN=1` shows what it would do. To run it every 2 weeks, add a cron line on the server such as `0 9 1,15 * * cd /path/to/project && tools/library-pr.sh >> data/library-pr.log 2>&1`. To use a different source, set `LIBRARY_UPDATES_URL` in `.env`.

## Shopping

- Each meal week has one list. The 2-week **stock-up** (pantry and freezer) is shown with the week it's bought in; **Everything / This week / 2-week stock-up** filters the list.
- Items are grouped by aisle: fruit and veg, meat and eggs, dairy, bread, frozen, pantry.
- Ticks are shared, and each shows who ticked it and when. **At home** takes an item off the total in every week.
- **Shop mode** shows one item at a time in aisle order with big **Got it**, **Skip** and **At home** buttons, then offers to go back through anything skipped. It keeps the screen awake where the browser allows.
- **Pin product:** open the product you buy on the store's website, copy its address and paste it in. The item's link then goes straight to that product instead of a search. Pins are shared by the family and only accept https pages on that store's own website.
- **Copy list** copies what's left as text, grouped by aisle.

## Uploading files

Everyone gets a **My files** page in More for things that help with the plan: Lose It exports, Apple Health exports, blood tests, photos and anything else. Each person only sees their own files. Admins can see, add and delete everyone's.

Files are stored in plain folders on the server, one per person and then one per type, with the upload date at the front of the name:

    data/uploads/alex/blood-tests/2026-11-08 Blood results.pdf

The types are `lose-it`, `apple-health`, `blood-tests`, `photos` and `other`. `data/uploads/README.txt` explains the layout. Files can be up to 2 GB, which is enough for an Apple Health export. You can also add or remove files in these folders directly; the page just lists what is there.

## Meal history (the database)

The app keeps a small database, `data/app.db` (SQLite, built into Node, so nothing to install). `plan.json` is still the current plan and `data/state.json` still holds this fortnight's ticks. The database is for the long run:

- **Meal history:** every meal someone ticks as eaten or rates, with the dish, score, note and when it was eaten. It is kept after **Reset all** and after loading a new plan, so you can look back week on week.
- **Dishes:** every dish and recipe that has been in a plan, with its macros, how often it has been eaten and its average score, even after it leaves the plan.
- **Exercise history:** every exercise session ticked as done, kept the same way.
- **Measurements:** weigh-ins typed in on the Progress page, and numbers read from Lose It and Apple Health exports.
- People's answers to the About me questions, plus room for change requests and settings (coming next).

`GET /api/history` gives your own history (admins can add `?person=`), and `GET /api/dishes` (admins) lists every dish. To look inside it yourself, use any SQLite viewer, or `sqlite3 data/app.db ".tables"`.

## Progress dashboard

Account menu → **Progress** shows week-by-week charts for one person (admins can switch between people): weight, energy and protein eaten, steps, workout time, exercise sessions ticked and meals ticked. Choose 4 weeks, 12 weeks, 6 months or a year. Every chart has hover (or tap, or the arrow keys) for each week's number, and there is a table view of the same numbers.

Where the numbers come from:

- **Weight:** weigh-ins typed in on the page come first, then Apple Health, then Lose It, for the same day. The chart shows each week's average, so one heavy or light day doesn't swing it. A goal weight from About me shows as a dashed line.
- **Lose It and Apple Health:** upload the export zips on **My files** (Lose It: Settings → Export data; Apple Health: your picture → Export All Health Data). The Progress page notices a new file and reads it. Only the parts it needs are read straight out of the zip, with size limits; nothing is unpacked. A large Apple Health export takes a few seconds.
- **Food:** Lose It's food log if there is one. Otherwise an estimate from the meals ticked as eaten in this app, using each dish's macros and the person's portion (these bars are hatched).
- **Steps and workouts:** Apple Health (if a phone and a watch both count steps, the bigger total is used, not both added together), then Lose It.

Weeks start on Monday and use the browser's time zone.

### Connecting Apple Health (every day, from an iPhone Shortcut)

Apple Health has no web connection, so the iPhone sends the numbers itself with a Shortcut. It sends the day's **steps**, **Move** (active energy) and **weight**, and, if Lose It (or another food app) writes to Apple Health, **food energy, protein, carbs and fat**. The same steps are in the app under **Progress → Apple Health sync**, with copy buttons for your address and key.

The phone has to be able to reach the site when the shortcut runs: on home Wi-Fi, or anywhere if the site is reachable from outside (see [HTTPS and access away from home](#https-and-access-away-from-home)). Menu names can differ a little between iOS versions.

**1. Make your sync key**

On the Health sync page, tap **Make my sync key**. Copy the key and the sync address (`https://<your site>/auth/health-sync`). The key is shown once; only a hash of it is stored. It can only add numbers for you: it can't read anything or log in. Making a new key, or **Turn sync off**, stops the old one.

**2a. Install it with one tap** (easiest)

An admin makes an install file once, on a Mac signed into iCloud (iPhones only open shortcut files a Mac has signed):

1. On the Mac, open **Health sync → Make or update the install file** and click **Download the shortcut file**.
2. In Terminal: `cd ~/Downloads && shortcuts sign --mode anyone --input "Health sync (unsigned).shortcut" --output "Health sync.shortcut"`
3. Upload **Health sync.shortcut** on the same page.

Then everyone taps **Install the Health sync shortcut** on their iPhone, taps **Add Shortcut**, and pastes their sync key. On the first run, tap **Turn On All** for Health data and **Always Allow** to connect. If it says it can't send a large amount of data, turn on Settings → Apps → Shortcuts → Advanced → **Allow Sharing Large Amounts of Data**. The file holds the site's address, so make it again if that changes. On iOS 27 and later you can also paste a ready-made description into the Shortcuts app instead (on the same page).

**2b. Or make the shortcut by hand** (about 10 minutes, once)

Open the **Shortcuts** app, tap **+**, and name the shortcut **Health sync**. Add these actions (search for each one in the bar at the bottom):

1. **Steps:** *Find Health Samples*, type **Steps**, filter **Start Date is today**. Then *Calculate Statistics*: **Sum** of Health Samples. Then *Set Variable* named `Steps`, set to Statistics.
2. **Move:** the same three actions with type **Active Energy**, variable `Move`.
3. **Weight:** *Find Health Samples*, type **Weight**, Start Date is today, sort by Start Date, **Latest First**, limit **1**. Then *Set Variable* named `Weight`.
4. **Food (optional, if Lose It writes to Apple Health):** repeat step 1 four times with types **Dietary Energy**, **Protein**, **Carbohydrates** and **Total Fat**, and variables `Food`, `Protein`, `Carbs` and `Fat`.
5. **The date:** *Date* (Current Date), then *Format Date* → Custom → `yyyy-MM-dd`, then *Set Variable* named `Day`.
6. **Send it:** *Get Contents of URL* with your sync address. Tap the arrow to show more:
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your sync key>` (the word Bearer, a space, then the key)
   - Request Body: **JSON**, with these fields:

     | Key | Kind | Value |
     |---|---|---|
     | `date` | Text | `Day` |
     | `steps` | Number | `Steps` |
     | `active_energy` | Number | `Move` |
     | `weight` | Text | `Weight` |
     | `energy_unit` | Text | type `kJ` (or `kcal` if your Health app shows Calories) |
     | `food_energy` | Number | `Food` (optional) |
     | `protein` | Number | `Protein` (optional) |
     | `carbs` | Number | `Carbs` (optional) |
     | `fat` | Number | `Fat` (optional) |

7. **(Optional)** *Get Dictionary Value* for key `message` from Contents of URL, then *Show Notification*, so you see "Synced steps, Move, weight…".

Tap **Done**, then tap the shortcut once to run it. Allow it to read Health data and to connect to your site. The **Last sync** line on the Health sync page shows what arrived.

**3. Make it run by itself**

In Shortcuts, tap **Automation** → **+** → **Charger** → **Is Connected** → **Run Immediately**, and choose the Health sync shortcut. The iPhone keeps Health data locked while the phone is locked, so running it when you plug in at night works better than a fixed time. You can add a Time of Day automation as a backup: each run replaces that day's numbers, so extra runs are fine.

**How it's protected:** wrong keys count towards the same 15-minute lock-out as wrong passwords, each key can sync up to 30 times an hour, and silly numbers (like 500,000 steps) are ignored. Synced numbers are used after a full Apple Health export for the same day. To test the key without saving anything, send `{"test": true}` as the body.

**Lose It** has no public connection for other apps, so its food log can't be read directly. Either turn on writing food and nutrients to Apple Health in Lose It's settings (then the optional food steps bring them across), or upload Lose It's export on **My files**.

**Older data:** for history from before the shortcut, export everything from the Health app (your picture → **Export All Health Data**) and upload the zip on **My files**. The Progress page reads it.

## Healthy-eating guidelines

On the **Macros** tab, pick a person to see how their week compares with official healthy-eating guidelines from **Australia**, **New Zealand**, the **UK**, **Japan** or **Korea**:

- Australia and New Zealand: serves a day of vegetables, fruit, grains, protein foods and dairy, using the person's age and sex from About me.
- UK: fruit and veg portions (5 a day), red and processed meat, and fish twice a week (one oily).
- Japan: servings of staple, side and main dishes, dairy and fruit from the Spinning Top, for the person's planned energy.
- Korea: whether every food group appears every day.

Anything that falls short gets a suggestion, and each country's key messages, serve sizes, limits (salt, saturated fat, sugar, alcohol) and official sources are listed underneath. People can choose their country in About me or on the card.

The numbers come from `site/guidelines.json` (with links to each official source, and notes on any figure still to be confirmed) and from the food groups worked out for each dish by `tools/estimate_groups.py`. They are estimates from the recipes, not exact values, and a doctor's or dietitian's advice comes first.

## Ask AI (the assistant)

**Ask AI** (in More) is a chat with the family's chosen AI (or the person's own, see Settings) that can see the plan. Anyone can use it to work out adjustments: swap a dinner they don't like, make a week cheaper, add vegetables, plan packed lunches, ease off an exercise day, or ask how they're tracking against the healthy-eating guidelines.

The AI can **suggest** a change to the plan, but it can't make one:

1. A suggestion shows up in the chat as a card listing exactly what would change.
2. People send it to the admins (or discard it). Admins see it under **Requests** (there's a link at the top of **Edit plan**).
3. An admin taps **Apply to the plan** (or **Decline**, with an optional reply). The plan is checked and saved, with a backup of the old one in `data/plan-backups/`, the same as saving from Edit plan. If the plan has changed since, the change is refused and the AI can suggest it again.

Admins can also chat about anyone's plan and apply their own suggestions straight away.

Coles and Woolworths have no way for other apps to add to a cart or list, so it points people to **Copy list**, **Shop mode** and the store links on the shopping list instead.

### Choosing an AI

The app works with four AIs. Consumer subscriptions (ChatGPT Plus, Gemini, Claude.ai) can't be used by other apps, so each needs an **API key**, paid per use, from that company. Add the ones you want to `.env`, run `docker compose up -d`, then pick one on **Plan setup**:

| AI | `.env` | Get a key |
|---|---|---|
| Claude (Anthropic) | `ANTHROPIC_API_KEY=sk-ant-...` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| OpenAI | `OPENAI_API_KEY=sk-...` | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google Gemini | `GEMINI_API_KEY=AIza...` | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Ollama (runs on your own computer, free) | `OLLAMA_URL=http://192.168.1.20:11434` | [ollama.com](https://ollama.com) |

People with an email login can also add their own Claude, OpenAI or Gemini key in **Settings → Your AI key**, so their chats use it (they pay for their own messages and the daily limit doesn't apply). The key is checked with the company first, then stored encrypted with a random key in `data/encryption-key`, and never sent back to the browser in full. Ollama is family-only, because the address is set on the server.

Notes:

- The app installs Anthropic's SDK the first time it starts (it needs the internet once; after that it's kept in a Docker volume). OpenAI, Gemini and Ollama need nothing extra.
- **Ollama:** pull a model first (for example `ollama pull qwen3:14b`) and make it listen on your network (`OLLAMA_HOST=0.0.0.0`). Plans and the assistant send long requests, so give it a big context window (`OLLAMA_CONTEXT_LENGTH=32768` or more) and pick a model that supports tool calls. Small local models write weaker plans than the big hosted ones; the built-in builder may do better on a small machine.
- `OPENAI_BASE_URL` and `GEMINI_BASE_URL` point those at another OpenAI-compatible address, if you need to.
- Without any key, everything else works and the page says the assistant isn't set up.

Optional settings in `.env`:

- `ASSISTANT_MODEL`: the Claude model (default `claude-opus-5-5`). For the others, choose the model on Plan setup.
- `ASSISTANT_EFFORT` (Claude only): `low`, `medium` (default) or `high`. Lower is faster and cheaper, higher thinks harder.
- `ASSISTANT_DAILY_LIMIT`: messages per login per day (default 40).

With Claude, if Anthropic's safety checks decline a request, it is automatically retried on another suitable Claude model ("fallbacks").

**Cost:** you pay the AI company for what you use. With Claude's default model and effort, a typical message, where it looks at a week of the plan and answers, is roughly 5 to 15 US cents (an estimate; check usage on the company's console). Other companies' prices differ by model. The daily limit stops runaway costs. Token counts per login per day are kept in `data/app.db` (`ai_usage`).

**Privacy:** to answer, the chosen AI company is sent the plan details it asks for and, for the person the chat is about, their About me answers, meal history and progress. Nothing is sent until someone types a message. Chats are kept in `data/app.db` so people can come back to them; people can delete their own chats. Check your chosen company's API terms on how they use data (Anthropic's, OpenAI's and Google's paid APIs don't train on it by default; with Ollama nothing leaves your network). AI can make mistakes, and a doctor's advice always comes first.

## Settings: colours, fonts, text size and the app icon

**Settings** (in More) changes how the app looks:

- **On this device:** anyone can pick light or dark, a colour, a font and a text size just for themselves. These are saved in their browser.
- **For everyone (admins):** the household's colour, font and text size, used by anyone who hasn't chosen their own. Saved in `data/app.db`.
- **App icon (admins):** pick a picture (or type up to two letters or an emoji) and a background colour. The icon is drawn in the browser and saved as `site/icon-512.png`, `site/icon-192.png` and `site/apple-touch-icon.png`. Old icons are kept in `data/icon-backups/`, and **Back to the original icon** restores the first one. On iPhone, remove the app from the home screen and add it again to see a new icon.

- **Country** (Plan setup, admins; also asked when the first account is made): sets the currency, date and number style, the energy unit to start with (kJ in Australia and New Zealand, Calories elsewhere), the healthy-eating guidelines shown first, the grocery stores on offer, and what AI-written plans assume. There are 22 countries: Australia, New Zealand, the UK, Ireland, the US, Canada, Japan, South Korea, Singapore and 13 in Europe. The list and each store's search address are in `site/regions.js`.
- **Where you shop:** everyone picks their supermarkets from those in the household's country (in Australia: Coles, Woolworths, Aldi, IGA, Foodland, Spudshed, Drakes, or a mix), and admins pick the household's default. The shopping list shows a search link for each. Most stores open their own search; shops that run online store by store get a link that searches their website; in-store-only shops (like Aldi and Lidl in most countries) have no link.
- **Kilojoules or Calories:** each person chooses how food and exercise energy is shown; admins set the household default.
- **Your AI key:** anyone with an email login can add their own Claude, OpenAI or Gemini API key and choose its model, so Ask AI and their plan drafts use it (see [Choosing an AI](#choosing-an-ai)).

The eight colours are checked for contrast in both light and dark mode, and text sizes scale with the phone's own text-size setting.

## Changing the plan

Everything the page shows (meals, recipes, shopping lists and exercise) comes from `site/plan.json`. Replace that file to change the plan. No restart is needed.

**Edit it in the app.** Admins get an **Edit plan** link in More. It edits meals (including a different meal for one person on a day), macros for each dish, and shopping items and prices, and has a raw JSON editor for everything else. Each save keeps the previous plan in `data/plan-backups/` (the last 30), and you can restore one from the Backups tab. Shopping ticks stay with an item as long as its name does not change. After updating to this version, run `docker compose up -d` once so the api container can write to `site/`.

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

**Offsite backup:** `tools/offsite-backup.sh` packs up the whole app folder (code, `.env`, `plan.json` and `data/`, with a safe copy of the database), encrypts it with [age](https://age-encryption.org), and uploads it to a **private** GitHub repository as a release, keeping the newest 14. GitHub only sees the encrypted file. Setup steps are at the top of the script; to run it every night, add a cron file such as `/etc/cron.d/family-planner-backup`:

    15 17 * * * root /home/shopping-list-selfhost/tools/offsite-backup.sh >> /var/log/family-planner-backup.log 2>&1

Keep the backup key (`~/.config/family-planner-backup/key.txt`) somewhere other than the server, like a password manager: without it the backups can't be opened. To restore on a new machine, see [docs/restore.md](docs/restore.md).


Back up `.env` (logins), `site/plan.json` (your plan) and `data/` (ticks, ratings, meal history in `app.db`, uploads and the login key). None of these are in git. To copy `app.db` while the app is running, use `sqlite3 data/app.db ".backup app-backup.db"`, or stop the app first.

## Notes

- The page loads a font from Google Fonts and falls back to a system font without it.
- Prices are rough estimates. Plans written by an AI are priced in your country's currency; plans from the built-in builder are priced in Australian dollars for now (shown as A$ outside Australia). The store links open a search for each item, or the pinned product.
