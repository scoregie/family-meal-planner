# Helper tools

Scripts you run by hand, from the project folder. The Python ones need Python 3 and nothing else.

| Script | What it does | Changes the plan? |
| --- | --- | --- |
| `estimate_macros.py` | Estimates protein, carbs and fat for one serve of each recipe, from the recipe's ingredients. | Only with `--write` |
| `estimate_groups.py` | Estimates the food groups in each dish and snack (vegetables, fruit, grains, protein foods, dairy and more), for the healthy-eating guidelines on the Macros tab. | Only with `--write` |
| `check_shopping.py` | Checks each week's shopping list buys enough for that week's recipes and snacks. | Never |
| `build_library.py` | Builds `api/library.json` (the plan builder's ingredients, meals and snacks) from USDA nutrition data. See the README. | No (writes the library) |
| `build_prices.py` | Builds `api/library-prices.json`: local shop names, pack sizes and prices for each country. Edit its tables and run it again. | No (writes the price list) |
| `claude-code-plan.sh` | Lets Claude Code draft the family's plan (`prompt`, then `submit`). See CLAUDE.md. | No (makes a draft to approve) |
| `library-pr.sh` | Shares new library meals and exercises with everyone through a GitHub pull request. | No |
| `test.sh` | Runs the automated tests in `tests/` (see `tests/README.md`). Uses a throwaway container; your data isn't touched. | Never |
| `page-check.sh` | Proves a change didn't alter what the pages do: it presses every button on every page, before and after, and compares. See below. | Never |
| `offsite-backup.sh` | Encrypts the whole app folder and uploads it to a private GitHub repository. See the README. | No |

## estimate_macros.py

    python3 tools/estimate_macros.py site/plan.json                       # show the estimates
    python3 tools/estimate_macros.py site/plan.json --write               # fill in dishes with no macros
    python3 tools/estimate_macros.py site/plan.json --write --overwrite   # replace all recipe macros

It reads each recipe's `items` (see [docs/plan-format.md](../docs/plan-format.md)), turns every item into grams, and uses typical Australian nutrition per 100 g. Dishes called "... leftovers" get the macros of the recipe they come from. Snacks and packed lunches have no recipe, so add those on the **Macros** tab of **Edit plan**.

If it says "no nutrition rule for ...", add a line to `RULES` (and to `NUTRITION` for a new food) near the top of the script. Keep a copy of `plan.json` before using `--write`. The admin page also keeps backups in `data/plan-backups/`.

## estimate_groups.py

    python3 tools/estimate_groups.py site/plan.json            # show the estimates
    python3 tools/estimate_groups.py site/plan.json --write    # save them in plan.json as "groups"

It uses the same ingredient rules as `estimate_macros.py`, plus what each food counts as (for example 75 g of vegetables is one Australian serve, and 30 g of oats is one grain serve). Snacks and packed lunches have no recipe, so it reads their description instead: "2 boiled eggs and an apple" becomes 1 serve of protein and 1 of fruit. Anything it can't read is listed. Run it again after changing recipes or snacks. See [docs/plan-format.md](../docs/plan-format.md#food-groups) for what each number means.

## check_shopping.py

    python3 tools/check_shopping.py site/plan.json

It prints items bought in a much bigger amount than needed ("spare"), then any **shortfalls**. A shortfall that rounds to 0 means you are short by part of an item (for example 2.2 limes needed and 2 bought), which is usually fine. Fresh food is checked week by week. Pantry and freezer food is checked over each fortnight (stock-up week plus its two weeks), with leftovers carried forward.

The pack sizes (in `bought()`) and the weekly snacks (in `SNACKS`) are written for the current plan. When the shopping list or snacks change, update them to match. Things the checker can't see, like chicken frozen in one week and used the next, show up as a shortfall you can ignore.

## page-check.sh

For changes that shouldn't alter what the app does, such as tidying code:

    tools/page-check.sh record before          # 1. record the code as it is now
    # ...make your change...
    tools/page-check.sh record after           # 2. record it again
    tools/page-check.sh compare before after   # 3. "All 26 pages are the same", or what differs

Each recording opens every page in a pretend browser (jsdom) against a throwaway copy of the server, presses every button, tick box and fold in turn (about 1,900 presses), uploads a file and reads the charts with the keyboard, and writes down the page after each press. When two recordings differ, `compare` names the page, the press after which it differed, and the piece of the page that changed.

Your family's data is never touched: the throwaway server has its own empty data folder, the example plan and a made-up person. Recordings are kept in `.page-check/` (not saved to git). It needs Docker, and the first run downloads jsdom into `.page-check/`; the app itself doesn't use it.

What it can't see: layout, touch and drag and drop (it isn't a real browser), and anything that needs an AI key (Ask AI answers, AI-written plans). A change that is meant to alter a page will show as a difference there, which is a handy way to see exactly what it altered.
