#!/usr/bin/env python3
"""Estimates the food groups in one average serve of every dish in plan.json, for the
healthy-eating guidelines card on the Macros tab (see site/guidelines.json).

Each country counts food differently (Australia and New Zealand in "serves" of food groups,
the UK in 80 g portions of fruit and veg, Japan in servings of whole dishes), so this keeps
both Australian-style serves and the raw amounts the other countries need:

  veg, fruit, grain, protein, dairy   Australian serves (75 g veg, 150 g fruit, 1 slice of bread, ...)
  fv     grams of fruit and veg that count for the UK's 5 a day (not potatoes or legumes)
  leg    grams of beans and lentils (the UK counts these as one portion a day at most)
  red    grams of red and processed meat, cooked weight (the UK says 70 g a day or less)
  fish   grams of fish, and "oily" grams of oily fish (salmon, sardines, mackerel, trout)
  side   grams of vegetables, potatoes and mushrooms (Japan: 70 g is one side-dish serving)
  gc     grams of carbohydrate from grain foods (Japan: 40 g is one staple serving)
  mp     grams of protein from meat, fish, eggs, soy and legumes (Japan: 6 g is one main-dish serving)
  ca     milligrams of calcium from dairy (Japan: 100 mg is one dairy serving)

Recipes are read from their "items", using the same ingredient rules as estimate_macros.py.
Snacks and packed lunches have no recipe, so their description is read instead ("2 boiled eggs
and an apple"). Anything it can't read is listed so you can check it.

Usage (from the project folder):
  python3 tools/estimate_groups.py site/plan.json            # print a table, change nothing
  python3 tools/estimate_groups.py site/plan.json --write    # save them in plan.json under "groups"

These are estimates for comparing a week with the guidelines, not exact values.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_macros import NUTRITION, food_and_grams, all_dishes, leftovers_source, macro_key  # noqa: E402

# What each food counts as. kind: veg, potato, fruit, grain, red, processed, poultry, fish, oily,
# egg, legume, tofu, nut, dairy, or None (sauces and flavourings, which don't count).
# serve: grams for one Australian serve of that food (raw or dry weight, as the recipes list it).
# ca: calcium in mg per 100 g, for dairy.
KINDS = {
    'spinach': ('veg', 75), 'tomato': ('veg', 75), 'canned tomatoes': ('veg', 75), 'passata': ('veg', 75),
    'onion': ('veg', 75), 'carrot': ('veg', 75), 'capsicum': ('veg', 75), 'cucumber': ('veg', 75),
    'sweet potato': ('veg', 75), 'peas': ('veg', 75), 'stir-fry veg': ('veg', 75), 'mixed veg': ('veg', 75),
    'cos lettuce': ('veg', 75), 'corn': ('veg', 75), 'salsa': ('veg', 150),   # salsa is about half vegetables
    'zucchini': ('veg', 75), 'bok choy': ('veg', 75), 'mushrooms': ('veg', 75), 'pumpkin': ('veg', 75),
    'broccoli': ('veg', 75), 'coleslaw': ('veg', 75), 'lettuce': ('veg', 75), 'cabbage': ('veg', 75),
    'avocado': ('veg', 75), 'mandarin': ('fruit', 150), 'strawberries': ('fruit', 150),
    'potato': ('potato', 75),
    'berries': ('fruit', 150), 'apple': ('fruit', 150), 'banana': ('fruit', 150), 'dried fruit': ('fruit', 30),
    'oats': ('grain', 30), 'bread': ('grain', 40), 'rice': ('grain', 30), 'pasta': ('grain', 30),
    'noodles': ('grain', 30), 'wrap': ('grain', 40), 'breadcrumbs': ('grain', 30), 'weet-bix bites': ('grain', 30),
    'crackers': ('grain', 35), 'croissant': ('grain', 40),
    'pork': ('red', 90), 'beef': ('red', 90), 'lamb': ('red', 90),
    'sausage': ('processed', None), 'bacon': ('processed', None), 'ham': ('processed', None),
    'turkey': ('poultry', 100), 'chicken': ('poultry', 100),
    'basa': ('fish', 115), 'tuna': ('fish', 100), 'salmon': ('oily', 115), 'sardines': ('oily', 100),
    'egg': ('egg', 100),
    'red lentils': ('legume', 60), 'beans (drained)': ('legume', 150), 'chickpeas': ('legume', 150),
    'black beans': ('legume', 150), 'baked beans': ('legume', 150),
    'tofu': ('tofu', 170), 'peanut butter': ('nut', 30),
    'milk': ('dairy', 250), 'yoghurt': ('dairy', 200), 'tasty cheese': ('dairy', 40),
    'mozzarella': ('dairy', 40), 'cheese slice': ('dairy', 40),
}
CALCIUM = {'milk': 120, 'yoghurt': 150, 'tasty cheese': 750, 'mozzarella': 500, 'cheese slice': 550}
# Extra foods that only appear in snacks: (protein, carbs, fat) per 100 g, like NUTRITION.
EXTRA_NUTRITION = {
    'banana': (1.2, 20.0, 0.3), 'dried fruit': (1.5, 75.0, 0.5), 'crackers': (9.0, 70.0, 12.0),
    'croissant': (8.0, 45.0, 21.0), 'ham': (17.0, 1.5, 4.0), 'beef': (21.0, 0.0, 8.0), 'lamb': (20.0, 0.0, 10.0),
    'salmon': (20.0, 0.0, 13.0), 'sardines': (24.0, 0.0, 11.0), 'tofu': (12.0, 2.0, 7.0),
}
COOKED = {'red': 0.7, 'processed': 0.85}   # cooked weight from raw, for the UK's 70 g


# Protein, carbs and fat per 100 g for a food, from the tables above (zeros if it isn't listed).
def nutrition(food):
    return NUTRITION.get(food) or EXTRA_NUTRITION.get(food) or (0, 0, 0)


# A fresh set of food-group totals, all zero.
def empty():
    return {k: 0.0 for k in ('veg', 'fruit', 'grain', 'protein', 'dairy', 'fv', 'leg', 'red', 'fish', 'oily', 'side', 'gc', 'mp', 'ca')}


def add_food(totals, food, grams):
    """Adds `grams` of `food` to the running totals. Returns False if the food doesn't count anywhere."""
    if food not in KINDS:
        return False
    kind, serve = KINDS[food]
    protein, carbs, _ = nutrition(food)
    if kind == 'veg':
        totals['veg'] += grams / serve
        totals['fv'] += grams * (0.5 if food == 'salsa' else 1)
        totals['side'] += grams
    elif kind == 'potato':
        totals['veg'] += grams / serve
        totals['side'] += grams
    elif kind == 'fruit':
        totals['fruit'] += grams / serve
        totals['fv'] += grams * (80 / 30 if food == 'dried fruit' else 1)
    elif kind == 'grain':
        totals['grain'] += grams / serve
        totals['gc'] += carbs * grams / 100
    elif kind in ('red', 'poultry', 'fish', 'oily', 'egg', 'legume', 'tofu', 'nut'):
        totals['protein'] += grams / serve
        totals['mp'] += protein * grams / 100
        if kind == 'red':
            totals['red'] += grams * COOKED['red']
        if kind in ('fish', 'oily'):
            totals['fish'] += grams
        if kind == 'oily':
            totals['oily'] += grams
        if kind == 'legume':
            totals['leg'] += grams * (2.5 if food == 'red lentils' else 1)   # dry lentils swell to about 2.5 times
    elif kind == 'processed':
        # Processed meat isn't a serve of "lean meat" in Australia, but it counts for the UK's red meat limit.
        totals['red'] += grams * COOKED['processed']
        totals['mp'] += protein * grams / 100
    elif kind == 'dairy':
        totals['dairy'] += grams / serve
        totals['ca'] += CALCIUM.get(food, 120) * grams / 100
    return True


# The totals divided by the number of serves and rounded (serves to 1 decimal place, grams to whole numbers).
def rounded(totals, serves):
    out = {}
    for k, v in totals.items():
        v = v / serves
        v = round(v, 1) if k in ('veg', 'fruit', 'grain', 'protein', 'dairy') else round(v)
        if v:
            out[k] = v
    return out


def recipe_groups(recipe):
    """({groups per average serve}, [items that matched no rule]) for a recipe."""
    totals = empty()
    unknown = []
    for item in recipe.get('items', []):
        food, grams = food_and_grams(item)
        if not food:
            unknown.append(item['l'])
        elif not add_food(totals, food, grams):
            pass   # a sauce or flavouring: it has macros but no food group
    return rounded(totals, recipe.get('units') or 1), unknown


# ---------- snacks and packed lunches, read from their description ----------

# (pattern, food, default grams when no amount is given, grams for each one when counted)
SNACK_WORDS = [
    (r'weet-?bix', 'weet-bix bites', 45, None),
    (r'yoghurt', 'yoghurt', 150, None),
    (r'milk', 'milk', 250, None),
    (r'cheese slice', 'cheese slice', 21, 21),
    (r'cheese', 'tasty cheese', 20, None),
    (r'boiled eggs?|^eggs?$', 'egg', 50, 50),
    (r'toast|slices? .*bread', 'bread', 40, 40),
    (r'peanut butter', 'peanut butter', 20, None),
    (r'banana', 'banana', 120, 120),
    (r'mandarins?', 'mandarin', 100, 100),
    (r'strawberr', 'strawberries', 150, None),
    (r'handful of berries', 'berries', 50, None),
    (r'berries', 'berries', 50, None),
    (r'apple slices', 'apple', 75, None),       # part of an apple
    (r'apple', 'apple', 150, 150),
    (r'dried mango|dried fruit|sultanas|raisins', 'dried fruit', 30, None),
    (r'crackers', 'crackers', 25, None),
    (r'croissant', 'croissant', 60, 60),
    (r'ham', 'ham', 30, None),
    (r'chicken', 'chicken', 60, None),
    (r'tuna', 'tuna', 95, 95),
    (r'oats', 'oats', 10, None),                 # "a spoon of oats"
    (r'wrap', 'wrap', 42, 42),
]
# Whole foods that stand for several things.
SNACK_DISHES = {
    r'egg sandwich': [('bread', 80), ('egg', 75)],
    r'sandwich': [('bread', 80)],
}
NUMBER_WORDS = {'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'half a': 0.5}


def amount(part):
    """(grams or ml, count) found in a snack part: "150 g ..." gives (150, None), "2 boiled eggs" gives (None, 2)."""
    m = re.search(r'(\d+(?:\.\d+)?)\s*(g|ml)\b', part)
    if m:
        return float(m.group(1)), None
    m = re.match(r'\s*(\d+(?:\.\d+)?)\b', part)
    if m:
        return None, float(m.group(1))
    for word, n in NUMBER_WORDS.items():
        if re.match(r'\s*' + word + r'\b', part, re.I):
            return None, n
    return None, None


def food_in_part(part):
    """The first food named in a part of a snack description, or None."""
    for pattern, food, _, _ in SNACK_WORDS:
        if re.search(pattern, part, re.I):
            return food
    return None


def written_later(food, later_parts):
    """True if a later part names `food` with an amount ("150 ml milk")."""
    return any(food_in_part(p) == food and amount(p) != (None, None) for p in later_parts)


def snack_groups(text):
    """({groups}, [parts it couldn't read]) for a snack description like "2 boiled eggs and an apple"."""
    totals = empty()
    unknown = []
    # Leave out things in brackets that say what NOT to have: "(no banana)".
    clean = re.sub(r'\((?:no|without)\b[^)]*\)', '', text, flags=re.I)
    for pattern, foods in SNACK_DISHES.items():
        if re.search(pattern, clean, re.I):
            for food, grams in foods:
                add_food(totals, food, grams)
            clean = re.sub(pattern, '', clean, flags=re.I)
            break
    # "Weet-Bix ... (about 45 g with 150 ml milk)": split into parts, and find the foods in each.
    # An amount written in the text ("150 ml milk") wins over the usual amount for that food.
    found = {}   # food -> (grams, written in the text?)
    order = []   # the first food named in each part, in order (None for a part with no food)
    parts = re.split(r',|\band\b|\bwith\b|\(|\)', clean, flags=re.I)
    for index, part in enumerate(parts):
        part = part.strip()
        if not part:
            continue
        grams, count = amount(part)
        rest = part
        for pattern, food, default, each in SNACK_WORDS:
            if not re.search(pattern, rest, re.I):
                continue
            rest = re.sub(pattern, ' ', rest, count=1, flags=re.I)   # so "cheese wrap" finds both
            if grams is not None:
                g, written = grams, True
            elif count is not None and each:
                g, written = count * each, True
            else:
                g, written = default, False
            if food not in found or (written and not found[food][1]):
                found[food] = (g, written)
            grams = count = None   # an amount belongs to the first food in the part
        order.append(food_in_part(part))
        if grams is not None and not order[-1]:
            # A bare amount, like "(about 100 g)", is for the food just before it, unless that
            # food has its own amount written later ("milk (about 45 g with 150 ml milk)").
            for earlier in reversed(order[:-1]):
                if earlier and not (earlier in found and found[earlier][1]) and not written_later(earlier, parts[index + 1:]):
                    found[earlier] = (grams, True)
                    break
        leftover = re.sub(r'\d+(\.\d+)?\s*(g|ml)?|\b(about|plain|sliced|boiled|full cream|glass of|a spoon of|an?|of|mixed berry|bites|wholegrain|slices?)\b', ' ', rest, flags=re.I)
        if leftover.strip() and not re.search(r'school provides', part, re.I):
            unknown.append(part)
    for food, (g, _) in found.items():
        add_food(totals, food, g)
    return rounded(totals, 1), unknown


# Reads the plan named on the command line, works out food groups for every dish, and prints them
# (or saves them into the plan with --write).
def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    plan_path = sys.argv[1]
    write = '--write' in sys.argv
    raw = open(plan_path, encoding='utf-8').read()
    plan = json.loads(raw)

    estimates = {}
    for week in plan['weeks']:
        for recipe in week.get('recipes', []):
            if not isinstance(recipe, dict) or recipe['name'] in estimates or not recipe.get('items'):
                continue
            groups, unknown = recipe_groups(recipe)
            if unknown:
                print(f"  {recipe['name']}: no rule for {unknown}, so it is left out")
            estimates[recipe['name']] = groups
    recipe_names = list(estimates)
    for dish in sorted(all_dishes(plan)):
        key = macro_key(dish)
        if key in {macro_key(n) for n in estimates}:
            continue
        source = leftovers_source(dish, recipe_names)
        if source:
            estimates[dish] = dict(estimates[source])
            continue
        if re.search(r'school provides|work provides|eat out|takeaway', dish, re.I):
            continue   # we can't know what's in it
        groups, unknown = snack_groups(dish)
        if unknown:
            print(f"  {dish}: couldn't read {unknown}")
        if groups:
            estimates[dish] = groups

    print(f"\n{'Dish':50} {'veg':>4} {'fruit':>5} {'grain':>5} {'prot':>5} {'dairy':>5}  {'UK f&v g':>8} {'red g':>5} {'fish g':>6}")
    for name in sorted(estimates):
        g = estimates[name]
        print(f"{name[:50]:50} {g.get('veg', 0):>4} {g.get('fruit', 0):>5} {g.get('grain', 0):>5} {g.get('protein', 0):>5} {g.get('dairy', 0):>5}  {g.get('fv', 0):>8} {g.get('red', 0):>5} {g.get('fish', 0):>6}")
    missing = sorted(d for d in all_dishes(plan) if macro_key(d) not in {macro_key(n) for n in estimates})
    if missing:
        print('\nNot estimated:')
        for dish in missing:
            print('  ' + dish)

    if write:
        plan['groups'] = {name: estimates[name] for name in sorted(estimates)}
        out = json.dumps(plan, indent=1, ensure_ascii=False) + ('\n' if raw.endswith('\n') else '')
        temp = plan_path + '.tmp'
        open(temp, 'w', encoding='utf-8').write(out)
        os.replace(temp, plan_path)   # swap in the new file in one step
        print(f'\nWrote food groups for {len(estimates)} dishes to {plan_path}.')


if __name__ == '__main__':
    main()
