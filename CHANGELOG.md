# Changelog

Each release is tagged on GitHub (see Releases) with these notes. To update a server, see
"Updating" in the README.

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
