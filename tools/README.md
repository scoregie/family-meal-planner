# Helper tools

Small Python scripts for checking and filling in `site/plan.json`. They need Python 3 and nothing else. Run them from the project folder.

| Script | What it does | Changes the plan? |
| --- | --- | --- |
| `estimate_macros.py` | Estimates protein, carbs and fat for one serve of each recipe, from the recipe's ingredients. | Only with `--write` |
| `check_shopping.py` | Checks each week's shopping list buys enough for that week's recipes and snacks. | Never |

## estimate_macros.py

    python3 tools/estimate_macros.py site/plan.json                       # show the estimates
    python3 tools/estimate_macros.py site/plan.json --write               # fill in dishes with no macros
    python3 tools/estimate_macros.py site/plan.json --write --overwrite   # replace all recipe macros

It reads each recipe's `items` (see [docs/plan-format.md](../docs/plan-format.md)), turns every item into grams, and uses typical Australian nutrition per 100 g. Dishes called "... leftovers" get the macros of the recipe they come from. Snacks and packed lunches have no recipe, so add those on the **Macros** tab of **Edit plan**.

If it says "no nutrition rule for ...", add a line to `RULES` (and to `NUTRITION` for a new food) near the top of the script. Keep a copy of `plan.json` before using `--write`. The admin page also keeps backups in `data/plan-backups/`.

## check_shopping.py

    python3 tools/check_shopping.py site/plan.json

It prints items bought in a much bigger amount than needed ("spare"), then any **shortfalls**. A shortfall that rounds to 0 means you are short by part of an item (for example 2.2 limes needed and 2 bought), which is usually fine. Fresh food is checked week by week. Pantry and freezer food is checked over each fortnight (stock-up week plus its two weeks), with leftovers carried forward.

The pack sizes (in `bought()`) and the weekly snacks (in `SNACKS`) are written for the current plan. When the shopping list or snacks change, update them to match. Things the checker can't see, like chicken frozen in one week and used the next, show up as a shortfall you can ignore.
