# Changelog

Each release is tagged on GitHub (see Releases) with these notes. To update a server, see
"Updating" in the README.

## v1.4.4 (2026-11-10)

A fix for plans built without AI. Restart the api after updating (`docker restart shopping-list-api`).

- **Fixed: "Australian classics".** Choosing it in "Kinds of food you'd like more of" did nothing in
  the built-in plan builder, because its dishes are labelled "Australian". It now favours them as
  intended. A new test checks that every cuisine choice matches dishes in the library.
- **10 French dishes** in the shared meal library: omelette, French toast, quiche, croque monsieur,
  niçoise salad, lentil soup, chicken ratatouille, chicken fricassee, salmon parcels and a
  slow-cooker beef bourguignon. Servers download them within 2 weeks.
- **Fixed: `tools/library-pr.sh`** crashed whenever the shared library already had exercises, so
  sharing new meals had stopped working.

## v1.4.3 (2026-11-10)

Two new About me choices. No restart needed.

- **French** is now in "Kinds of food you'd like more of".
- **Cordial** is now in "What do you usually drink?".

## v1.4.2 (2026-11-10)

Automated tests, and a fix they found. Restart the api after updating
(`docker restart shopping-list-api`).

- **Fixed: wheat or gluten allergies.** The built-in plan builder couldn't make a plan for a family
  with a wheat or gluten allergy (or coeliac disease), because every breakfast and lunch in its
  library had gluten. It now has 6 gluten-free breakfasts and 6 gluten-free lunches, which also
  give more choice for milk, egg and dairy-free families. If a meal ever can't be matched to
  everyone, the plan says "your own choice" for it instead of failing.
- **Automated tests:** `tools/test.sh` runs 35 checks in a few seconds, covering logins and the
  wrong-password limit, safe redirects, the plan builder (allergies, diets, children's portions,
  injuries, pregnancy, every country's prices), Apple Health imports, and the wording rules for
  health text. GitHub runs them on every pull request. See `tests/README.md`.
- **Wording:** three health notes no longer say "never" or "always", and About me says "What they
  told you comes first" for a doctor's guidance.

## v1.4.1 (2026-11-10)

Fixes from a full code review. After updating, restart both containers
(`docker compose restart`), because the Caddyfile changed too.

- **Privacy and legal:**
  - The fonts are now served from your own server, so pages never contact Google Fonts (which
    would share each visitor's address with Google).
  - Plan setup and About me now say that, with an AI chosen, About me answers (including health
    and medicines) are sent to that AI company. With No AI they stay on your server.
  - More has an "About this app" note: general information, not medical advice; AI can make
    mistakes; in an emergency call your local emergency number; store and brand names belong to
    their owners.
  - Health notes on About me, Progress and Ask AI follow the wording rules ("what your GP tells
    you comes first", no "always").
  - The README has a "Legal and privacy" section, and `NOTICE.md` lists the fonts, data and
    packages the app uses, with their licences.
- **Security:**
  - The limit on wrong passwords can no longer be bypassed by sending a made-up
    `X-Forwarded-For` header. Caddy now works out the visitor's real address and passes it on.
  - A crafted `next=` link can no longer send people to another website after they log in.
- **Country choice on a new server:** the country list on the first-account form was empty,
  because `regions.js` needed a login. Fixed.
- **Exercise:**
  - Pregnant people get bodyweight exercises only again, as their note says.
  - Injury words are matched as whole words, and "no knee problems" no longer counts as a knee
    problem. Hip problems now leave out deep knee-bend moves.
  - Swapping an exercise is now checked on the server too.
- **Names in any alphabet:** names like 유나 or ゆき can now be used. Uploaded files are now deleted
  with the account for names that start with an accented letter (like Émile).
- **Reliability:**
  - A download that fails part-way no longer stops the server.
  - A damaged or unusual zip can't use up the memory, and an empty file inside one no longer
    fails the import.
  - The encryption key for saved AI keys is never replaced. If it can't be read, saving a key
    shows an error.
  - "Too big" errors reach the page instead of showing as a dropped connection.
  - A failed download of the shared meals and exercises is tried again within 6 hours.
  - Reminders at 11:30 pm or ending at midnight make valid calendar events.
  - Offsite backups of 2 GB or more are uploaded in parts. docs/restore.md shows how to join them.
- **Wording:**
  - The plan draft and its approval summary show the plan's own currency.
  - Ask AI no longer calls prices Coles estimates.
  - Plans written by the AI and by Claude Code no longer interfere with each other.

## v1.4.0 (2026-11-10)

- **Local prices for plans built without AI:** in every country, the built-in builder's shopping
  lists use local shop names, pack sizes and prices in local currency (pounds and ounces in the
  US). The About me budget is compared in your own currency too.
- **Local words in recipes:** "pepper" for capsicum and "courgette" for zucchini in the UK, "bell
  pepper", "ground beef" and "cilantro" in the US, Weetabix and Marmite where those are sold.
- Dishes that need something hard to find locally (such as Vegemite or halloumi in Japan) are
  left out.
- Prices are estimates: typical local prices for about a dozen staples per country, and the rest
  scaled from Australian prices by local price levels. They're in `api/library-prices.json`, made
  by `tools/build_prices.py`.
- Australian plans are unchanged.

## v1.3.0 (2026-11-10)

- **Countries:** the planner now works outside Australia. Choose your country when you create the
  first account, or later on Plan setup. There are 22: Australia, New Zealand, the UK, Ireland, the
  US, Canada, Japan, South Korea, Singapore, Germany, France, the Netherlands, Belgium, Spain,
  Italy, Portugal, Austria, Switzerland, Sweden, Norway, Denmark and Finland.
- The country sets:
  - **grocery stores** for the shopping list links (122 stores, for example Tesco, Walmart,
    Albert Heijn and Aeon);
  - **currency** and the date and number style;
  - **kilojoules or Calories** to start with;
  - **healthy-eating guidelines** shown first.
- AI-written plans, Ask AI and AI-written library meals use your country's stores, spelling,
  currency and local ingredients.
- Prices show in the plan's own currency. Plans from the built-in builder are still priced in
  Australian dollars (shown as A$ outside Australia); local price lists are planned next.
- Existing servers stay on Australia with the same stores and choices.

## v1.2.0 (2026-11-10)

- **New meals and exercises every 2 weeks** for the built-in plan builder (Plan setup → New meals
  and exercises):
  - **From the project, no AI needed:** the server downloads the project's shared additions from
    GitHub every 2 weeks. The first batch: 6 meals, 2 snacks and 6 exercises.
  - **Written by your AI:** with an AI chosen, it can write about 5 meals, a snack and 3 exercises
    aimed at your family every 2 weeks. They wait for an admin to add or discard them.
  - Every new entry is checked first. Dishes only use ingredients already in the library, and the
    app works out their nutrition, allergens and cost itself.
- `tools/library-pr.sh` shares approved additions with everyone through a pull request.

## v1.1.1 (2026-11-10)

- Today: no Shopping card while the plan has no shopping list yet (for example after clearing the
  plan to start again), and "1 item left" instead of "1 items left".

## v1.1.0 (2026-11-09)

- **Today page:** the app now opens on a summary of the day: today's meals and snacks to tick, with
  the energy eaten so far; today's exercise to tick; the newest steps, active energy and food from
  Health sync; and what's left to buy this week. Each card opens the full page.
- **New bottom bar:** Today, Meals, Shopping, Exercise and **More**. More replaces the long account
  menu, with the pages grouped under "You" and "Family" (admins). Tapping your initial (top right)
  opens it too. Macros moved into Meals (a Day plan / Macros switch), and meal ratings into More.
- **Settings:** each section folds away and opens with a tap.
- **Exercise library:** 94 exercises for bodyweight, bands, dumbbells, the gym and seated
  exercise, with plain how-to steps, a level and what each one loads. Browse it from More, and
  choose any to leave out of your plans.
- **Built-in plan builder:** strength workouts are now picked from the library for each person:
  their equipment, injuries they mentioned (knees, back, shoulders, wrists, balance), pregnancy,
  wheelchair use and what they've left out. Weeks 3 and 4 get a harder pair of workouts.
- **Swap** next to an exercise on the Exercise tab changes it for another of the same kind that
  suits you, and can leave the old one out of future plans.
- **Draft the plan with Claude Code:** `tools/claude-code-plan.sh` lets a Claude Code session on
  the server write the family's plan on a Claude subscription instead of an API key. The draft
  waits on Plan setup to approve, like any other.

## v1.0.4 (2026-11-09)

- Health sync: **install the shortcut with one tap.** An admin downloads the shortcut file from the
  Health sync page, signs it on a Mac (`shortcuts sign`, one Terminal command) and uploads it. Then
  everyone gets an Install button, and the shortcut asks for their sync key and kJ or kcal when it's added.
- Health sync: first-run tips (Turn On All for Health data, Allow Sharing Large Amounts of Data,
  Always Allow, and home Wi-Fi when the address is a number).
- Health sync: if a number arrives but can't be read, the notification and the page say which one and
  what came, instead of skipping it quietly.
- Progress: an **Apple Health sync** card at the top, with the last sync on one line and Show/Hide
  for the details and settings link.

## v1.0.3 (2026-11-08)

- Health sync: a quick way to make the iPhone shortcut on iOS 27 and later. Copy the ready-made
  description (with your sync address and key filled in) and paste it into the Shortcuts app's
  "what do you want your shortcut to do?" box. The step-by-step instructions are still there,
  folded away, with a note about the new + screen.

## v1.0.2 (2026-11-08)

- Exercise: each of today's workouts now starts with **Today:** and that day's amount from the plan
  (for example "Today: Easy walk, 25 minutes."), so the general workout steps no longer seem to
  disagree with the day. The workout's general time is hidden when today's amount is shown.
- AI plans: workouts describe how to do a session; lengths and distances go in each day's session
  and build up over the weeks.

## v1.0.1 (2026-11-08)

- The project is now open source under the MIT licence (see LICENSE).

## v1.0.0 (2026-11-08)

The first tagged release: everything built so far.

**Planning**
- About me questions for each person: goals, body, health (including medicines that affect food
  or exercise), food, week, exercise, budget and support needs. Adults can answer for kids.
- Plan setup: choose the family's AI (Claude, OpenAI, Google Gemini, a local Ollama server, or no
  AI), then draft a 4-week plan for everyone and approve it.
- Built-in plan builder that needs no AI, using a meal library with nutrition from USDA FoodData
  Central.
- Ask AI: a chat that can see the plan and suggest changes for an admin to approve. People can use
  their own Claude, OpenAI or Gemini key.
- Warnings to check the meal and exercise plan with a GP, dietitian or physio.

**Every day**
- Shopping by aisle with shared ticks, At home, Shop mode (one item at a time) and pinned products
  for Coles, Woolworths and other stores.
- Meals and Exercise one day at a time, with recipes, ticks, ratings and considerations.
- Macros and healthy-eating guidelines (Australia, New Zealand, UK, Japan, Korea), in kJ or Calories.

**Tracking and accounts**
- Progress dashboard, Apple Health sync from an iPhone Shortcut, Lose It and Apple Health imports,
  and private file uploads.
- Email logins with an owner, admins and members; sign-ups wait for approval; username logins for kids.
- Settings for colours, fonts, text size, the app icon and stores.
- Plan backups, and encrypted offsite backups to a private GitHub repository.
