#!/usr/bin/env python3
"""Checks each week's shopping list buys enough for that week's recipes and snacks.

How it works:
  - "Needed": adds up every recipe item (with repeats from the recipe's "others" notes,
    see docs/plan-format.md) plus the weekly snacks in SNACKS below.
  - "Bought": reads the shopping list, working out how much each item gives you
    (a "12-pack" of eggs is 12 eggs, "Turkey mince 500 g × 2" is 1000 g, and so on).
  - Fresh food must be bought in the same week. Pantry and freezer food (FORTNIGHT below) can
    come from the stock-up week before, so it is checked over the whole fortnight, and anything
    left over carries into the next fortnight.

Usage (from the project folder):
  python3 tools/check_shopping.py site/plan.json

It prints anything bought in a much bigger amount than needed ("spare"), then SHORTFALLS.
A shortfall of under 1 (like half a lime) is usually fine.

This is written for the current plan: the pack sizes in bought() and the snacks in SNACKS
match its shopping list. When the plan changes, update those to match.
"""
import collections
import json
import re
import sys

# ---------------------------------------------------------------------------
# What is needed
# ---------------------------------------------------------------------------

def times_made(recipe):
    """How many times a recipe is made in the week, from its "others" notes."""
    times = 1.0
    for note in recipe.get('others', []):
        same = re.match(r'Also on (.*): same amounts', note)   # "Also on Thu breakfast, Sun breakfast: same amounts"
        if same:
            times += len(same.group(1).split(','))
        scaled = re.search(r'use about ([\d.]+)×', note)       # "Sat lunch: use about 1.4× these amounts"
        if scaled:
            times += float(scaled.group(1))
    return times


# Recipe item labels -> the name used to compare with the shopping list. Checked in order.
NEED_RULES = [
    (r'eggs?$', 'eggs'), (r'slices wholegrain bread', 'bread slices'), (r'^wraps$', 'wraps'),
    (r'ml milk', 'milk ml'), (r'g plain yoghurt', 'yoghurt g'), (r'g chicken breast', 'chicken g'),
    (r'g turkey mince', 'turkey g'), (r'g pork mince', 'pork g'), (r'beef sausages', 'sausages'),
    (r'g bacon', 'bacon g'), (r'g basa', 'basa g'), (r'cans? tuna', 'tuna cans'),
    (r'g mozzarella', 'mozzarella g'), (r'cheese slices', 'cheese slices'), (r'g tasty cheese', 'tasty g'),
    (r'g apple', 'apple g'), (r'g potatoes', 'potato g'), (r'g sweet potato', 'sweet potato g'),
    (r'g brown onion', 'onion g'), (r'capsicum', 'capsicum'), (r'cucumber', 'cucumber'),
    (r'^(?!.*can).*tomatoes$', 'tomatoes'),   # fresh tomatoes, not "can diced tomatoes"
    (r'g carrots', 'carrot g'), (r'g baby spinach', 'spinach g'),
    (r'lime', 'limes'), (r'lemon', 'lemons'), (r'g butter chicken sauce', 'bc sauce g'),
    (r'cos lettuce', 'cos packs'), (r'g salsa', 'salsa g'),
    # Pantry and freezer
    (r'g rice', 'rice g'), (r'g pasta', 'pasta g'), (r'g macaroni', 'macaroni g'), (r'g egg noodles', 'noodles g'),
    (r'g passata', 'passata g'), (r'can diced tomatoes', 'diced tomato cans'), (r'can red kidney', 'kidney cans'),
    (r'can cannellini', 'cannellini cans'), (r'can chickpeas', 'chickpea cans'), (r'can brown lentils', 'lentil cans'),
    (r'can black beans', 'black bean cans'), (r'can corn', 'corn cans'), (r'can coconut', 'coconut cans'),
    (r'can baked beans', 'baked bean cans'), (r'g red lentils', 'red lentils g'), (r'g rolled oats', 'oats g'),
    (r'g frozen peas', 'peas g'), (r'g frozen stir-fry', 'stir-fry veg g'), (r'g frozen mixed berries', 'berries g'),
    (r'g frozen mixed veg', 'mixed veg g'), (r'g breadcrumbs', 'breadcrumbs g'), (r'g peanut butter', 'pb g'),
    (r'Weet-Bix', 'weetbix g'), (r'taco', 'taco sachets'), (r'curry paste', 'curry paste tbsp'), (r'soy sauce', 'soy ml'),
]


def need_name(label):
    """The comparison name for a recipe item label, or None if it isn't checked."""
    for pattern, name in NEED_RULES:
        if re.search(pattern, label, re.I):
            return name
    return None


# Snacks and the child's packed food in a normal week, written out by hand from the plan's
# "people" block (they are text, not recipes, so they can't be read automatically).
SNACKS = {
    'yoghurt g': 150 * 5 + 150 * 7 + 100 * 5,
    'eggs': 2 * 5 + 1 + 2,
    'apple g': 180 * 5 + 75 * 4,
    'bread slices': 2 * 7 + 2,
    'pb g': 20 * 7,
    'milk ml': 300 * 7,
    'oats g': 15 * 7,
    'cheese slices': 4 + 1,
    'wraps': 1,
    'chicken g': 70,
}
# (The Weet-Bix recipe already counts the child's breakfasts, so it isn't in SNACKS.)


def needed(week):
    """Returns (amount needed of each thing, recipe labels that aren't checked) for a week."""
    amounts = collections.Counter()
    unchecked = set()
    for recipe in week.get('recipes', []):
        times = times_made(recipe)
        for item in recipe.get('items', []):
            name = need_name(item['l'])
            if name:
                amounts[name] += item['q'] * times
            else:
                unchecked.add(item['l'])
    return amounts, unchecked


# ---------------------------------------------------------------------------
# What is bought
# ---------------------------------------------------------------------------

def size_in_grams(text):
    """The pack size in an item name in grams or ml: "Passata 700 g" gives 700, "Milk 2 L" gives 2000."""
    match = re.search(r'([\d.]+) ?(kg|g|l|ml)\b', text)
    return float(match.group(1)) * (1000 if match.group(2) in ('kg', 'l') else 1)


def bought(week):
    """How much of each thing a week's shopping list buys."""
    amounts = collections.Counter()
    for items in week['shopping'].values():
        for item in items:
            name, price = item[0], item[1]
            if price == 0:
                continue   # "you probably have this already"
            n = name.lower()
            count = re.search(r'× (\d+)', n)   # "× 2" on the end means two of them
            packs = int(count.group(1)) if count else 1

            # Each check below is one kind of item, with the amount one pack gives you.
            if n.startswith('eggs'): amounts['eggs'] += 12 * packs
            elif 'bread' in n and 'crumb' not in n: amounts['bread slices'] += 20 * packs
            elif 'wraps' in n: amounts['wraps'] += 8 * packs
            elif 'milk 2 l' in n: amounts['milk ml'] += 2000 * packs
            elif 'yoghurt' in n: amounts['yoghurt g'] += 1000 * packs
            elif 'chicken breast' in n: amounts['chicken g'] += 1500 if 'large' in n or '1.5' in n else 600 * packs
            elif 'turkey' in n: amounts['turkey g'] += 500 * packs
            elif 'pork' in n: amounts['pork g'] += 500 * packs
            elif 'sausages' in n: amounts['sausages'] += 6        # a 550 g pack is about 6 sausages
            elif 'bacon' in n: amounts['bacon g'] += 250 * packs
            elif 'basa' in n: amounts['basa g'] += 1000
            elif 'tuna' in n: amounts['tuna cans'] += packs
            elif 'mozzarella' in n: amounts['mozzarella g'] += size_in_grams(n)
            elif 'cheese slices' in n: amounts['cheese slices'] += 24 if '24' in n else 12 * packs
            elif 'tasty' in n: amounts['tasty g'] += 500
            elif 'apples' in n: amounts['apple g'] += 1000 * packs
            elif n.startswith('potatoes'): amounts['potato g'] += 2000
            elif 'sweet potato' in n: amounts['sweet potato g'] += 500 * round(price / 1.75)   # sold by weight
            elif 'onions' in n: amounts['onion g'] += size_in_grams(n)
            elif 'capsicum' in n: amounts['capsicum'] += packs
            elif 'cucumber' in n: amounts['cucumber'] += packs
            elif 'tomatoes ×' in n or n == 'tomatoes': amounts['tomatoes'] += packs
            elif 'carrots' in n: amounts['carrot g'] += size_in_grams(n)
            elif 'spinach' in n: amounts['spinach g'] += 280
            elif 'limes' in n: amounts['limes'] += packs
            elif 'lemons' in n: amounts['lemons'] += packs
            elif 'butter chicken' in n: amounts['bc sauce g'] += 485 * packs
            elif 'cos lettuce' in n: amounts['cos packs'] += 1
            elif 'salsa' in n: amounts['salsa g'] += 300
            elif 'rice' in n: amounts['rice g'] += 1000 * packs
            elif n.startswith('pasta'): amounts['pasta g'] += 500 * packs
            elif 'macaroni' in n: amounts['macaroni g'] += 500
            elif 'noodles' in n: amounts['noodles g'] += 440
            elif 'passata' in n: amounts['passata g'] += 700
            elif 'diced tomatoes' in n: amounts['diced tomato cans'] += packs
            elif 'kidney' in n: amounts['kidney cans'] += packs
            elif 'cannellini' in n: amounts['cannellini cans'] += packs
            elif 'chickpeas' in n: amounts['chickpea cans'] += packs
            elif 'brown lentils' in n: amounts['lentil cans'] += packs
            elif 'black beans' in n: amounts['black bean cans'] += packs
            elif 'corn' in n: amounts['corn cans'] += packs
            elif 'coconut' in n: amounts['coconut cans'] += packs
            elif 'baked beans' in n: amounts['baked bean cans'] += packs
            elif 'red split lentils' in n or 'red lentils' in n: amounts['red lentils g'] += size_in_grams(n)
            elif 'oats' in n: amounts['oats g'] += 1000 * packs
            elif 'frozen peas' in n: amounts['peas g'] += 1000
            elif 'stir-fry' in n: amounts['stir-fry veg g'] += 500 * packs if '500' in n else 1000
            elif 'berries' in n: amounts['berries g'] += 500 * packs
            elif 'mixed veg' in n: amounts['mixed veg g'] += 1000
            elif 'breadcrumbs' in n: amounts['breadcrumbs g'] += 300 * packs
            elif 'peanut butter' in n: amounts['pb g'] += 375 * packs
            elif 'weet-bix' in n: amounts['weetbix g'] += 500 * packs
            elif 'taco' in n: amounts['taco sachets'] += packs
            elif 'curry paste' in n: amounts['curry paste tbsp'] += 15
            elif 'soy sauce' in n: amounts['soy ml'] += 250
            elif 'bananas' in n: amounts['bananas'] += 10 if '10' in n else 3
    return amounts


# Pantry and freezer things, checked over a whole fortnight instead of week by week.
FORTNIGHT = {
    'rice g', 'pasta g', 'macaroni g', 'noodles g', 'passata g', 'diced tomato cans', 'kidney cans',
    'cannellini cans', 'chickpea cans', 'lentil cans', 'black bean cans', 'corn cans', 'coconut cans',
    'baked bean cans', 'red lentils g', 'oats g', 'peas g', 'stir-fry veg g', 'berries g', 'mixed veg g',
    'breadcrumbs g', 'pb g', 'weetbix g', 'taco sachets', 'tasty g', 'basa g', 'curry paste tbsp', 'soy ml',
}

# Each fortnight: (stock-up week, first week, second week), by position in "weeks".
FORTNIGHTS = [(0, 1, 2), (3, 4, 5)]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    plan = json.load(open(sys.argv[1], encoding='utf-8'))
    weeks = plan['weeks']
    shortfalls = []
    carried = collections.Counter()   # pantry food left over from the fortnight before

    for number, (stock_up, first, second) in enumerate(FORTNIGHTS, 1):
        fortnight_need = collections.Counter()
        fortnight_bought = bought(weeks[stock_up])
        for index in (first, second):
            week = weeks[index]
            need, unchecked = needed(week)
            need.update(SNACKS)
            got = bought(week)
            if unchecked:
                print(f"  {week['name']}: ingredients not checked: {sorted(unchecked)}")
            for thing in sorted(set(need) | set(got)):
                if thing in FORTNIGHT:
                    fortnight_need[thing] += need[thing]
                    fortnight_bought[thing] += got[thing]
                    continue
                # Allow 3% for rounding.
                if got[thing] + 1e-6 < need[thing] * 0.97:
                    shortfalls.append(f"{week['name']:7} {thing:18} needs {need[thing]:7.0f}  buys {got[thing]:7.0f}  short {need[thing] - got[thing]:6.0f}")
                elif got[thing] > need[thing] * 1.6 and got[thing] - need[thing] > 1:
                    print(f"  {week['name']:7} {thing:18} needs {need[thing]:7.0f}  buys {got[thing]:7.0f}  (spare {got[thing] - need[thing]:.0f})")

        for thing in sorted(set(fortnight_need) | set(fortnight_bought)):
            available = fortnight_bought[thing] + carried[thing]
            carried[thing] = max(0, available - fortnight_need[thing])
            if available + 1e-6 < fortnight_need[thing] * 0.97:
                shortfalls.append(f"Fortnight {number} {thing:18} needs {fortnight_need[thing]:7.0f}  buys {available:7.0f}  short {fortnight_need[thing] - available:6.0f}")

    print("\nSHORTFALLS:")
    print("\n".join(shortfalls) if shortfalls else "  none")


if __name__ == '__main__':
    main()
