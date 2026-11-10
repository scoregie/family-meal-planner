# Family Health Planner

A self-hosted family meal, shopping and exercise planner. `api/` is the Node server (no framework),
`site/` the pages Caddy serves, `docs/plan-format.md` the plan.json format. `docs/how-it-works.md`
explains the code for beginners. The README covers the rest.

The owner wants the code readable by someone with minimal coding experience: every file starts with
a plain note saying what it does, and every new function gets a one-line plain comment above it.

Run `tools/test.sh` before opening a PR, and add a test when fixing a bug (see `tests/README.md`).

## "Draft our family plan with Claude Code"

The family may have no AI API key, so a Claude Code session can write the 4-week plan instead:

1. Run `tools/claude-code-plan.sh prompt "<any note the user gives>"`. It writes
   `data/claude-code/prompt.md`: the app's own drafting instructions, the format guide, an example
   plan, and everyone's About me answers.
2. Read the whole of `data/claude-code/prompt.md` and follow its instructions exactly. Write the
   complete plan as one JSON object (including `notesForAdmin`) to `data/claude-code/plan.json`.
   If the prompt lists blood test files (people who said yes to sharing them in About me), read
   each one where it is, under `data/uploads/`, before writing; the prompt says how to use them.
   It is long (around 100 KB): write it in parts if needed, then check it parses
   (`python3 -m json.tool data/claude-code/plan.json > /dev/null`).
3. Run `tools/claude-code-plan.sh submit`. If the app reports a problem, fix the plan and submit again.
4. Tell the user it is waiting on **Plan setup** for them to review and approve. Don't approve it yourself.

The prompt file and the blood test files hold health details: never commit them or copy them out of `data/`.

## "Write new meals and exercises for the library"

New entries for the built-in builder go in `api/library-community.json` (bump `version`), shaped like
the entries there. Dishes may only use ingredient keys from `api/library.json` (amounts per average
adult serve); leave out macros, groups, tags and cost, because `api/libraryupdates.js` works them
out. Write recipes in your own words, never copied. Check them with `checkSet` in that file
(run node inside the api container), then open a PR: `tools/library-pr.sh <file>` does it from a file.

Local names, packs and prices for other countries are in `api/library-prices.json`, made by
`tools/build_prices.py`; after adding an ingredient to `api/library.json`, run it again.

## What comes first in a plan

Whoever writes a plan (the builder, an AI, or a Claude Code session) uses this order: (1) allergies,
diets and medicine rules; (2) each person's vegetable and fruit serves for their age and sex
(`api/healthtargets.js`), children included; (3) safe foods and textures, which decide the form
food comes in; (4) likes and dislikes. A sweeping dislike from a child ("most veggies") changes the
form, not the amount; a named food is still left out. Each person picks the pace for (2) in About me
(`eating_change`): from week 1, building up by week 3, or keeping close to what they eat now.

## Rules for health text

Health notes say "considerations", never "advice"; no absolutes ("always", "never", "must");
report what people said ("you said your physio…"); defer to their GP, dietitian or physio.
