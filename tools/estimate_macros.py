#!/usr/bin/env python3
"""Estimates protein, carbs and fat for one average serve of every recipe in plan.json.

How it works:
  1. For each recipe, it looks at the "items" list (quantity "q" and label "l").
  2. It works out the grams of each ingredient (labels like "g rice" are already grams;
     counted things like "eggs" or "× 400 g can chickpeas" use the typical weights below).
  3. It multiplies by typical Australian supermarket nutrition per 100 g (label or AUSNUT style).
  4. It divides by the recipe's "units" (the number of average serves it makes).
"Leftovers" dishes get the macros of the recipe they come from.

Usage (from the project folder):
  python3 tools/estimate_macros.py site/plan.json            # print a table, change nothing
  python3 tools/estimate_macros.py site/plan.json --write    # also fill in dishes with no macros yet
  python3 tools/estimate_macros.py site/plan.json --write --overwrite   # replace existing ones too

Snacks and packed lunches have no recipe, so they are listed as "not estimated". Add those
on the Macros tab of Edit plan, or by hand in plan.json. These are estimates, not lab values.
"""
import json
import os
import re
import sys

# Nutrition per 100 g (or 100 ml): (protein, carbs, fat) in grams.
# Raw weights for meat and veg; dry weights for rice, pasta, lentils and oats; canned beans drained.
NUTRITION = {
    'yoghurt': (5.0, 6.0, 4.0), 'oats': (12.0, 58.0, 8.5), 'berries': (0.8, 8.0, 0.3),
    'tuna': (25.0, 0.0, 1.0), 'bread': (11.0, 38.0, 3.0), 'spinach': (2.9, 0.6, 0.4),
    'tomato': (0.9, 2.6, 0.2), 'lime': (0.5, 5.0, 0.1), 'lemon': (0.5, 3.0, 0.1),
    'turkey': (19.5, 0.0, 7.5), 'pork': (19.0, 0.0, 12.0), 'chicken': (23.0, 0.0, 2.5),
    'sausage': (13.0, 6.0, 19.0), 'bacon': (15.0, 1.0, 17.0), 'basa': (14.0, 0.0, 2.5),
    'egg': (12.6, 0.6, 10.0), 'milk': (3.4, 4.8, 3.4), 'mozzarella': (24.0, 1.0, 21.0),
    'tasty cheese': (25.0, 0.5, 33.0), 'cheese slice': (19.0, 5.0, 24.0),
    'rice': (7.0, 79.0, 0.6), 'pasta': (12.5, 70.0, 1.5), 'noodles': (12.0, 70.0, 2.0),
    'wrap': (9.5, 57.0, 7.0), 'breadcrumbs': (12.0, 72.0, 4.0), 'weet-bix bites': (9.0, 70.0, 1.5),
    'red lentils': (24.0, 48.0, 1.5), 'beans (drained)': (7.0, 12.5, 0.5), 'chickpeas': (7.0, 14.0, 2.4),
    'black beans': (6.5, 13.0, 0.5), 'baked beans': (4.7, 11.0, 0.4), 'corn': (2.8, 15.0, 1.3),
    'canned tomatoes': (1.2, 3.5, 0.2), 'passata': (1.5, 6.0, 0.2), 'coconut milk': (1.8, 3.0, 17.0),
    'onion': (1.1, 7.0, 0.1), 'carrot': (0.8, 6.0, 0.2), 'capsicum': (1.0, 5.0, 0.3),
    'cucumber': (0.6, 2.5, 0.1), 'potato': (2.2, 13.5, 0.1), 'sweet potato': (1.6, 17.0, 0.1),
    'apple': (0.3, 12.0, 0.2), 'peas': (5.2, 8.0, 0.4), 'stir-fry veg': (1.8, 5.0, 0.3),
    'mixed veg': (3.0, 8.0, 0.4), 'cos lettuce': (1.2, 1.5, 0.3), 'salsa': (1.3, 7.0, 0.2),
    'peanut butter': (25.0, 12.0, 50.0), 'soy sauce': (7.0, 6.0, 0.0), 'curry paste': (2.0, 10.0, 8.0),
    'butter chicken sauce': (1.6, 9.0, 7.5), 'taco seasoning': (6.0, 60.0, 3.0),
}

# Matching rules, checked in order: (pattern in the item label, food above, grams for each one).
# The grams are None when the label is already in grams or millilitres ("g rice", "ml milk").
RULES = [
    (r'can (red kidney beans|cannellini beans|brown lentils)', 'beans (drained)', 240),
    (r'can chickpeas', 'chickpeas', 240),
    (r'can black beans', 'black beans', 240),
    (r'can baked beans', 'baked beans', 420),     # eaten with the sauce, so the whole can
    (r'can corn', 'corn', 300),                   # 420 g can, drained
    (r'can diced tomatoes', 'canned tomatoes', 400),
    (r'can coconut', 'coconut milk', 400),
    (r'cans? tuna', 'tuna', 95),
    (r'slices? .*bread', 'bread', 40),
    (r'^eggs?$', 'egg', 50),                      # the part you eat
    (r'^wraps?$', 'wrap', 42),
    (r'cheese slices?', 'cheese slice', 21),
    (r'sausages?', 'sausage', 70),
    (r'^tomato(es)?$', 'tomato', 120),
    (r'^cucumbers?$', 'cucumber', 300),
    (r'^capsicums?$', 'capsicum', 160),
    (r'^limes?$', 'lime', 60),
    (r'^lemons?$', 'lemon', 60),
    (r'cos lettuce', 'cos lettuce', 300),         # one pack of hearts
    (r'taco seasoning', 'taco seasoning', 30),    # one sachet
    (r'tbsp curry paste', 'curry paste', 17),     # one tablespoon
    # Labels already in grams or millilitres.
    (r'^(g|ml) .*weet-bix', 'weet-bix bites', None),
    (r'^(g|ml) .*yoghurt', 'yoghurt', None),
    (r'^(g|ml) .*oats', 'oats', None),
    (r'^(g|ml) .*berries', 'berries', None),
    (r'^(g|ml) .*spinach', 'spinach', None),
    (r'^(g|ml) .*turkey', 'turkey', None),
    (r'^(g|ml) .*pork', 'pork', None),
    (r'^(g|ml) .*chicken breast', 'chicken', None),
    (r'^(g|ml) .*butter chicken', 'butter chicken sauce', None),
    (r'^(g|ml) .*bacon', 'bacon', None),
    (r'^(g|ml) .*basa', 'basa', None),
    (r'^(g|ml) .*milk', 'milk', None),
    (r'^(g|ml) .*mozzarella', 'mozzarella', None),
    (r'^(g|ml) .*tasty', 'tasty cheese', None),
    (r'^(g|ml) .*rice', 'rice', None),
    (r'^(g|ml) .*(pasta|macaroni)', 'pasta', None),
    (r'^(g|ml) .*noodles', 'noodles', None),
    (r'^(g|ml) .*breadcrumbs', 'breadcrumbs', None),
    (r'^(g|ml) .*red lentils', 'red lentils', None),
    (r'^(g|ml) .*passata', 'passata', None),
    (r'^(g|ml) .*onion', 'onion', None),
    (r'^(g|ml) .*carrot', 'carrot', None),
    (r'^(g|ml) .*sweet potato', 'sweet potato', None),
    (r'^(g|ml) .*potato', 'potato', None),
    (r'^(g|ml) .*apple', 'apple', None),
    (r'^(g|ml) .*peas', 'peas', None),
    (r'^(g|ml) .*stir-fry', 'stir-fry veg', None),
    (r'^(g|ml) .*mixed veg', 'mixed veg', None),
    (r'^(g|ml) .*salsa', 'salsa', None),
    (r'^(g|ml) .*peanut butter', 'peanut butter', None),
    (r'^(g|ml) .*soy sauce', 'soy sauce', None),
]


def food_and_grams(item):
    """Returns (food name, grams) for one recipe item, or (None, 0) if no rule matches."""
    label = item['l']
    for pattern, food, grams_each in RULES:
        if re.search(pattern, label, re.I):
            if grams_each is None:
                return food, item['q']               # already in g or ml
            return food, item['q'] * grams_each      # a count of things
    return None, 0


def per_serve(recipe):
    """Returns ({'p', 'c', 'f'} per average serve, [labels with no rule]) for a recipe."""
    totals = [0.0, 0.0, 0.0]
    unknown = []
    for item in recipe.get('items', []):
        food, grams = food_and_grams(item)
        if not food:
            unknown.append(item['l'])
            continue
        for i in range(3):
            totals[i] += NUTRITION[food][i] * grams / 100
    serves = recipe.get('units') or 1
    protein, carbs, fat = (round(x / serves) for x in totals)
    return {'p': protein, 'c': carbs, 'f': fat}, unknown


def macro_key(name):
    """How the app matches a dish to its macros: lower case, ignoring a trailing "(packed)"."""
    return re.sub(r'\s*\(packed\)\s*$', '', str(name), flags=re.I).strip().lower()


def all_dishes(plan):
    """Every dish name anyone eats: shared meals, per-person meals, breakfasts, school lunches and snacks."""
    dishes = set()
    for week in plan['weeks']:
        for day in week.get('meals', []):
            for meal in ('breakfast', 'lunch', 'dinner'):
                if day.get(meal):
                    dishes.add(day[meal])
            for own in (day.get('people') or {}).values():
                for meal in ('breakfast', 'lunch', 'dinner'):
                    if own.get(meal):
                        dishes.add(own[meal])
    for person in (plan.get('people') or {}).values():
        if not isinstance(person, dict) or not person.get('name'):
            continue
        if person.get('breakfast'):
            dishes.add(person['breakfast'])
        for school_day in (person.get('weekday') or {}).values():
            for key in ('lunch', 'snack'):
                if school_day.get(key):
                    dishes.add(school_day[key])
        for snack in person.get('snacks') or []:
            if snack.get('what'):
                dishes.add(snack['what'])
    return dishes


def leftovers_source(dish, recipe_names):
    """For "Chilli leftovers", finds the recipe it comes from (one whose name contains "chilli")."""
    if not dish.lower().endswith('leftovers'):
        return None
    words = dish.lower().replace('leftovers', '').split()
    for name in recipe_names:
        if all(word in name.lower() for word in words):
            return name
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    plan_path = sys.argv[1]
    write = '--write' in sys.argv
    overwrite = '--overwrite' in sys.argv
    raw = open(plan_path, encoding='utf-8').read()
    plan = json.loads(raw)

    # Estimate each recipe once (a recipe can appear in several weeks).
    estimates = {}
    for week in plan['weeks']:
        for recipe in week.get('recipes', []):
            if not isinstance(recipe, dict) or recipe['name'] in estimates or not recipe.get('items'):
                continue
            macros, unknown = per_serve(recipe)
            if unknown:
                print(f"  {recipe['name']}: no nutrition rule for {unknown}, so it is left out (add a rule to RULES)")
            estimates[recipe['name']] = macros
    for dish in sorted(all_dishes(plan)):
        source = leftovers_source(dish, list(estimates))
        if source and dish not in estimates:
            estimates[dish] = dict(estimates[source])

    current = {macro_key(name): (name, value) for name, value in (plan.get('macros') or {}).items()}
    print(f"\n{'Dish':52} {'estimate':>20}   {'in plan.json now':>20}")
    for name in sorted(estimates):
        e = estimates[name]
        now = current.get(macro_key(name))
        now_text = f"P{now[1].get('p', 0):>4} C{now[1].get('c', 0):>4} F{now[1].get('f', 0):>4}" if now else 'none'
        kj = round(17 * e['p'] + 17 * e['c'] + 37 * e['f'])
        print(f"{name[:52]:52} P{e['p']:>4} C{e['c']:>4} F{e['f']:>4} {kj:>6} kJ   {now_text}")

    not_estimated = sorted(d for d in all_dishes(plan) if macro_key(d) not in {macro_key(n) for n in estimates})
    print('\nNot estimated (no recipe):')
    for dish in not_estimated:
        print(f"  {dish}{'' if macro_key(dish) in current else '   <- no macros yet'}")

    if write:
        macros = dict(plan.get('macros') or {})
        changed = 0
        for name, value in estimates.items():
            existing = current.get(macro_key(name))
            if existing and not overwrite:
                continue
            if existing:
                del macros[existing[0]]
            macros[name] = value
            changed += 1
        plan['macros'] = macros
        out = json.dumps(plan, indent=1, ensure_ascii=False) + ('\n' if raw.endswith('\n') else '')
        temp = plan_path + '.tmp'
        open(temp, 'w', encoding='utf-8').write(out)
        os.replace(temp, plan_path)   # swap in the new file in one step
        print(f'\nWrote macros for {changed} dishes to {plan_path}.')


if __name__ == '__main__':
    main()
