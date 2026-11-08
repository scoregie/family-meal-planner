# Changelog

Each release is tagged on GitHub (see Releases) with these notes. To update a server, see
"Updating" in the README.

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
