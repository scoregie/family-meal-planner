# The plan file (`site/plan.json`), field by field

Everything the app shows comes from one file, `site/plan.json`. This guide explains every part of it in plain English, with small examples. For a complete working file, open `site/plan.example.json`.

## A two-minute JSON refresher

JSON is a way of writing data as text. You only need four shapes:

| Shape | Looks like | Used for |
| --- | --- | --- |
| Text (a "string") | `"Yoghurt bowl"` | names, notes, instructions |
| Number | `12.5` | prices, grams, portions (no `$`, no units, no quotes) |
| List (an "array") | `[ "a", "b", "c" ]` | several things in order |
| Object | `{ "name": "Alex", "portion": 1.1 }` | named fields ("keys") and their values |

Common mistakes: a comma after the last item in a list, or a missing comma between items. Check the file with:

    python3 -m json.tool site/plan.json > /dev/null && echo OK

If the file has a mistake, the app shows a red message saying what is wrong and uses a built-in plan until you fix it.

## The overall shape

    {
      "id": "plan-2026-11",
      "title": "Meal and exercise plan",
      "subtitle": "Fortnight 1 about $459, fortnight 2 about $464.",
      "weeks":    [ ...one object per week, in order... ],
      "people":   { ...one object per person... },
      "exercise": { ...workout details, tips and video links... },
      "macros":   { ...protein, carbs and fat for each dish... }
    }

| Field | Needed? | What it does |
| --- | --- | --- |
| `id` | Yes | A name for this version of the plan. Ticks are saved against it, so **change it when you load a brand new plan** and everyone starts with clean ticks. Keep it the same when you only make small edits. |
| `title` | No | The big heading at the top of the page and the browser tab name. |
| `subtitle` | No | The line under the title, often the cost summary. |
| `currency` | No | The currency of the prices, as a three-letter code like `"AUD"`, `"GBP"` or `"EUR"`. Leave it out for Australian dollars. Prices are shown in this currency. |
| `weeks` | Yes | The weeks, in the order they appear along the top. See [Weeks](#weeks). |
| `people` | No | Who is in the household and how much they eat. See [People](#people). |
| `exercise` | No | Workout instructions, tips and video links shared by all weeks. See [Exercise](#exercise). |
| `macros` | No | Nutrition for each dish, used by the Macros tab. See [Macros](#macros). |
| `groups` | No | Food groups in each dish, for the healthy-eating guidelines card. See [Food groups](#food-groups). |

## Weeks

Each meal week is one tab along the top of the page. A stock-up week has no tab of its own: its items are added to the list of the week straight after it (see `kind`).

    {
      "name": "Week 1",
      "cost": 175.40,
      "shopping": { ... },
      "meals":    [ ... ],
      "recipes":  [ ... ],
      "exercise": { ... }
    }

| Field | Needed? | What it does |
| --- | --- | --- |
| `name` | Yes | The label on the tab, such as `"Week 1"` or `"Stock-up 1"`. |
| `kind` | No | Set to `"stockup"` for a shopping-only week (pantry and freezer items bought once a fortnight). It has no meals. Its items show on the shopping list of the week right after it, tagged "Stock-up", with buttons to show everything, just that week's items, or just the stock-up. |
| `cost` | No | The week's total, shown on the tab. The admin editor works it out for you when you save. |
| `useUp` | Optional. Fresh food likely to be left over at the end of this week, as a list of short strings ("about half of the Baby spinach 120 g"). The Shopping page lists them under "Likely left over this week". |
| `shopping` | Yes | The shopping list. |
| `meals` | No | What everyone eats each day. |
| `recipes` | No | How to cook each dish, with amounts. |
| `exercise` | No | The exercise plan for this week. |

### Shopping

`shopping` is an object. Each key is a section heading (any name you like) and each value is a list of items. An item is a small list of exactly two things: the name and the price as a plain number.

    "shopping": {
      "Fruit and veg": [ ["Tomatoes × 3", 3.6], ["Baby spinach 280 g", 5] ],
      "Meat and fish": [ ["Turkey mince 500 g × 2", 13] ]
    }

- **The app groups the list by aisle**, whatever your section names: Fruit and veg; Meat, fish and eggs; Dairy and fridge; Bread and wraps; Frozen; Pantry. It goes by the section name first (a section with "freezer", "meat", "fruit", "dairy" or "pantry" in its name), and by the item name for eggs, bread and wraps. Anything it can't place goes under Other.
- **Ticks follow the item name.** If you rename an item, its tick is cleared. If you only change the price, the tick stays.
- "At home" marks are remembered by item name, even across plans.

### Meals

`meals` is a list with one object per day.

    "meals": [
      { "day": "Mon", "breakfast": "Yoghurt bowl", "lunch": "Tuna salad", "dinner": "Turkey chilli with rice" }
    ]

| Field | What it does |
| --- | --- |
| `day` | Short day name: `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat` or `Sun`. |
| `breakfast`, `lunch`, `dinner` | The dish names. Use the same name as the recipe and the `macros` entry so they match up. |
| `people` | Optional. A different meal for one person that day, keyed by their person key (see [People](#people)). |
| `note` | Optional. Advice for that day, shown under the day's meals (for example "Cook a double batch of chilli tonight for tomorrow's lunch."). |

The Meals tab shows one day at a time. Under the meals it shows "Today's considerations": the `note`, the person's exercise that day (and which snacks that changes), and one of their `tips`.

Example of a different dinner for one person:

    { "day": "Fri", "breakfast": "Eggs on toast", "lunch": "Leftovers", "dinner": "Wrap pizzas",
      "people": { "kid": { "dinner": "Plain cheese wrap pizza" } } }

### Recipes

`recipes` is a list. The simplest recipe is one line of text: the name, a colon, then the details.

    "recipes": [ "Chilli: turkey mince, kidney beans, diced tomatoes, onion, taco seasoning" ]

A full recipe is an object. The amounts are for **the whole household**.

    {
      "name": "Yoghurt bowl",
      "makes": "breakfast for 2 adults",
      "ingredients": ["230 g plain yoghurt", "70 g rolled oats", "150 g frozen mixed berries"],
      "items": [
        { "q": 230, "l": "g plain yoghurt",       "i": 0 },
        { "q": 70,  "l": "g rolled oats",         "i": 0 },
        { "q": 150, "l": "g frozen mixed berries", "i": 0 }
      ],
      "units": 2.3,
      "steps": ["Spoon the yoghurt into bowls.", "Top with the oats and berries."],
      "leftoverStep": "",
      "kid": "Plain yoghurt with a few berries on the side.",
      "pantry": ["honey"],
      "others": ["Also on Thu breakfast, Sun breakfast: same amounts."]
    }

| Field | What it does |
| --- | --- |
| `name` | The dish name. Match the name used in `meals`. |
| `makes` | A short note about how much it makes. |
| `ingredients` | The ingredient list as plain text. Shown if there are no `items`. |
| `items` | The same ingredients split into parts so the app can scale them. **`q`** is the quantity (a number), **`l`** is the label after the number (`"g plain yoghurt"`, `"eggs"`, `"× 400 g can chickpeas"`), and **`i`** is `1` for things you count whole (eggs, slices, cans) or `0` for things you weigh or measure. |
| `units` | How many average serves the recipe makes in total. Each person's portion is added together, for example 1.1 + 1.2 = 2.3 for two adults. |
| `steps` | The method, one step per line. |
| `leftoverStep` | Optional extra step, such as "Pack the rest for tomorrow's lunch". It is hidden when one person's amounts are shown. |
| `kid` | Optional. How to make a plainer version for the child. |
| `pantry` | Optional. Things you are expected to have already. |
| `others` | Optional notes about repeats, shown under the recipe. |

**How one person's amount is worked out.** When you pick a person on the Meals tab, each item becomes:

    one person's amount = q × that person's portion ÷ units

For example, 230 g of yoghurt for Alex (portion 1.1) with `units` 2.3 is 230 × 1.1 ÷ 2.3 = 110 g. Part-cans are shown in grams, for example "about 130 g chickpeas (from a 400 g can)".

**Repeats in `others`.** Two phrases are understood by the helper tools in `tools/`:

- `"Also on Thu breakfast, Sun breakfast: same amounts."` The dish is made again on those days.
- `"Sat lunch: use about 1.4× these amounts"` The dish is made again, bigger or smaller.

## People

`people` is an object. Each key is a short **person key** (for example `"adult1"`, `"adult2"` or `"kid"`) that the rest of the file uses to refer to that person.

    "people": {
      "adult1": {
        "name": "Alex",
        "portion": 1.1,
        "guide": "Serves are about 10% bigger because Alex trains most days.",
        "snacks": [
          { "when": "Mid-morning", "what": "150 g plain yoghurt", "days": ["Mon","Tue","Wed","Thu","Fri"] },
          { "when": "Evening", "what": "1 apple", "optional": true }
        ],
        "times": [ { "when": "6:30 to 7:30 am (Mon to Fri)", "what": "Easy cardio" } ],
        "timesNote": "Shift these to suit your day.",
        "tips": ["Eat the whole plan. Skipping meals leads to takeaway later."]
      },
      "kid": {
        "name": "Riley",
        "portion": 1.0,
        "breakfast": "Weet-Bix with milk",
        "weekday": { "Mon": { "lunch": "Chicken and cheese wrap", "snack": "Crackers and cheese" } }
      }
    }

| Field | What it does |
| --- | --- |
| `name` | The name shown in the app. |
| `portion` | How much this person eats compared with an average serve. `1.0` is average, `1.2` is 20% more. |
| `guide` | A paragraph of advice shown on the Meals tab for this person. |
| `steps` | Optional "small steps": one new food to try each week for someone who isn't keen on vegetables or fruit, each a short step on from a food they like. A list of `{ "week": 1, "food": "Sweet potato wedges", "from": "chips", "how": "A few next to the usual chips." }`. The Meals page shows the week's step with "Tried it", "Liked it" and "Not this time" buttons, and the next plan carries on from the answers. |
| `snacks` | A list of snacks, each with `when` and `what`. Add `days` (a list of short day names) if it is not every day, and `"optional": true` for "if hungry" snacks, which are left out of the Macros totals. Add `exercise` to tie a snack to that day's exercise: `"strength"` (only on days with a strength session, like a glass of milk after weights), `"rest"` (only on days without one), `"active"` (days with any session) or `"inactive"`. Add `weeks` (a list of meal week numbers, like `[3, 4]`) for a snack that only runs in some weeks, for someone building up to more vegetables and fruit. A vegetable side or extra fruit that goes with a meal is written the same way, with `when` set to "With dinner", "With lunch" or "With breakfast": it counts towards that person's serves on the Macros tab. |
| `times` | Suggested eating or exercise times, each with `when` and `what`. These can be added to a phone calendar. A `when` like `"6:30 to 7:30 am (Mon to Fri)"` repeats on weekdays only. |
| `timesNote` | A note shown under the times. |
| `tips` | A list of tips, shown under "Cravings and energy". |
| `breakfast` | Optional. A breakfast this person always has instead of the shared one. |
| `weekday` | Optional, for a child at school. Monday to Friday, each with a packed `lunch` and a school `snack`. A lunch starting with "School" (for example "School provides lunch") is not marked "(packed)". |

Logins are linked to person keys in `.env` with `PERSON_<USERNAME>=<key>`. See the README.

## Exercise

### Each week's plan

A week's `exercise` can be **one plan for everyone**:

    "exercise": {
      "focus": "Build the habit",
      "targets": ["3 strength sessions", "8,000 steps a day"],
      "days": [ { "day": "Mon", "morning": "Easy cardio 20 min", "strength": "Strength A" } ]
    }

or **one plan per person**, keyed by person key:

    "exercise": {
      "adult1": { "focus": "...", "targets": ["..."], "days": [ ... ] },
      "adult2": { "focus": "...", "targets": ["..."], "days": [ ... ] }
    }

| Field | What it does |
| --- | --- |
| `focus` | One line about what this week is for. |
| `targets` | A list of goals for the week. |
| `days` | One object per day. Besides `day`, it can have any of these slots, each shown as a line you can tick: `morning`, `afternoon`, `cardio` (shown as "Easy cardio"), `strength`, `mobility` and `session`. Leave out the slots you don't need. |

### Shared details (top level)

The top-level `exercise` holds things that apply to every week. Like the weekly plan, it can be shared or one per person key.

    "exercise": {
      "workouts": [ { "name": "Strength A", "time": "About 50 minutes", "items": ["Warm-up (5 minutes): easy walk", "Goblet squat (3 × 10): feet shoulder-width apart"] } ],
      "videos": { "Goblet squat": "https://example.com/goblet-squat" },
      "notes": ["If a session feels too hard, do less rather than skipping it."],
      "medical": ["You said your physio is happy for you to do squats and lunges, and to avoid running and jumping for now."]
    }

| Field | What it does |
| --- | --- |
| `workouts` | Each workout's `name`, rough `time`, and `items` (the exercises, one per line). |
| `videos` | Exercise name → link to a demo video. A workout item written as `"Goblet squat (3 × 10): ..."` gets a **Demo** link when the text before the colon (without the brackets) matches a name here, plus a YouTube search link. |
| `notes` | General tips, shown in a "Good to know" box (closed until tapped) near the bottom of the Exercise tab. |
| `medical` | What the person said their doctor, physio or other health professional told them, and when to stop and get checked. Shown in its own "Medical considerations" box (closed until tapped) at the bottom of the Exercise tab, with a line saying it is general information and their health professional comes first. Write it as what the person reported ("You said your physio is happy for you to do squats"), not as fact or instruction ("Your physio has cleared squats"). |

The Exercise tab shows one day at a time. A workout shows open under the day when that day's session mentions its name (the part before the colon, such as "Strength A"), so it's easy to follow mid-workout.

## Macros

`macros` gives the nutrition for **one average serve** of each dish or snack. The key is the dish name exactly as written in `meals` or in a snack's `what` (capital letters don't matter, and a trailing "(packed)" is ignored).

    "macros": {
      "Yoghurt bowl": { "p": 14, "c": 40, "f": 6 },
      "300 ml glass of full cream milk": { "p": 10, "c": 14, "f": 10 }
    }

| Field | What it does |
| --- | --- |
| `p` | Protein, in grams. |
| `c` | Carbohydrate, in grams. |
| `f` | Fat, in grams. |
| `kj` | Optional. Energy in kilojoules. If left out, it is worked out as 17 × protein + 17 × carbs + 37 × fat. |
| `kcal` | Optional, older plans only. Calories, converted to kJ by multiplying by 4.184. |

Each person's numbers are scaled by their `portion`. Snacks are not scaled, because their amounts are already written for that person. Dishes without an entry show "no macros yet", and an admin can fill them in on the Macros tab of **Edit plan**.

## Food groups

`groups` gives the food groups in **one average serve** of each dish or snack, matched by name the same way as `macros`. The Macros tab uses it to compare a person's week with healthy-eating guidelines (Australia, New Zealand, the UK, Japan or Korea, from `site/guidelines.json`). You don't need to write it by hand: `python3 tools/estimate_groups.py site/plan.json --write` works it out from the recipes and snack descriptions.

    "groups": {
      "Tuna salad": { "veg": 0.9, "grain": 2.2, "protein": 0.8, "fv": 65, "fish": 83, "side": 65, "gc": 33, "mp": 21 }
    }

| Field | Meaning |
| --- | --- |
| `veg`, `fruit`, `grain`, `protein`, `dairy` | Australian serves (75 g vegetables, 150 g fruit, a slice of bread, 65 g cooked red meat, 250 ml milk, and so on). New Zealand uses the same serve sizes. |
| `fv` | Grams of fruit and vegetables that count towards the UK's 5 a day (potatoes don't count). |
| `leg` | Grams of beans and lentils (the UK counts them as one portion a day at most). |
| `red` | Grams of red and processed meat, cooked weight. |
| `fish`, `oily` | Grams of fish, and of oily fish. |
| `side` | Grams of vegetables, potatoes and mushrooms (Japan: 70 g is one side-dish serving). |
| `gc` | Grams of carbohydrate from grain foods (Japan: 40 g is one staple serving). |
| `mp` | Grams of protein from meat, fish, eggs, soy and legumes (Japan: 6 g is one main-dish serving). |
| `ca` | Milligrams of calcium from dairy (Japan: 100 mg is one dairy serving). |

Missing fields count as 0. Like macros, each person's numbers are scaled by their `portion`, except snacks.
