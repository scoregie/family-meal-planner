#!/usr/bin/env python3
"""Builds api/library-prices.json: local shopping names, pack sizes and prices for the built-in
plan builder's ingredients, for every country in site/regions.js except Australia (whose names
and prices are in api/library.json).

How the prices are made (all are estimates, in each country's own currency):
  - About a dozen staples per country (chicken, mince, milk, eggs, bread, rice, cheese, butter,
    bananas, potatoes, salmon) have a typical supermarket price and pack size set by hand below.
  - Everything else starts from the Australian price, is converted at RATES, and is scaled by how
    expensive that kind of food is there compared with Australia (LEVELS: meat, fish, dairy,
    fresh, bread, frozen, pantry).
  - In the US, pack sizes are converted to pounds and ounces.
Edit the tables and run it again:  python3 tools/build_prices.py
"""
import json, math, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = json.load(open(os.path.join(ROOT, 'api', 'library.json')))
ING = LIB['ingredients']
UPDATED = '2026-11'

# 1 Australian dollar in each currency (approximate, November 2026).
RATES = {'NZD': 1.10, 'GBP': 0.50, 'EUR': 0.58, 'USD': 0.66, 'CAD': 0.92, 'JPY': 100, 'KRW': 920,
         'CHF': 0.53, 'SEK': 6.4, 'NOK': 6.9, 'DKK': 4.3, 'SGD': 0.86}

# How expensive each kind of food is compared with Australia, after converting the currency.
CATS = ['meat', 'fish', 'dairy', 'fresh', 'bread', 'frozen', 'pantry']
LEVELS = {
    'nz': [1.05, 1.10, 1.10, 1.05, 1.00, 1.05, 1.05],
    'uk': [0.90, 0.95, 0.80, 0.75, 0.70, 0.80, 0.80],
    'ie': [0.95, 1.00, 0.85, 0.85, 0.80, 0.90, 0.90],
    'us': [0.95, 1.00, 1.00, 1.00, 1.20, 1.00, 1.05],
    'ca': [1.05, 1.10, 1.20, 1.05, 1.10, 1.05, 1.05],
    'jp': [1.00, 0.90, 1.10, 1.10, 0.90, 1.00, 1.00],
    'kr': [1.30, 1.10, 1.30, 1.50, 1.30, 1.10, 1.00],
    'de': [0.85, 0.95, 0.75, 0.80, 0.70, 0.80, 0.75],
    'fr': [0.95, 1.00, 0.85, 0.90, 0.90, 0.90, 0.85],
    'nl': [0.90, 1.00, 0.80, 0.85, 0.75, 0.85, 0.80],
    'be': [0.95, 1.05, 0.85, 0.90, 0.85, 0.90, 0.85],
    'es': [0.80, 0.90, 0.75, 0.70, 0.70, 0.80, 0.75],
    'it': [0.90, 1.00, 0.85, 0.80, 0.80, 0.85, 0.80],
    'pt': [0.80, 0.85, 0.75, 0.70, 0.70, 0.80, 0.80],
    'at': [1.00, 1.05, 0.90, 0.95, 0.85, 0.95, 0.90],
    'ch': [1.70, 1.50, 1.30, 1.30, 1.20, 1.30, 1.20],
    'se': [1.00, 1.00, 0.90, 0.95, 0.90, 0.95, 0.90],
    'no': [1.30, 1.00, 1.20, 1.20, 1.10, 1.20, 1.15],
    'dk': [1.05, 1.05, 0.90, 1.00, 1.00, 1.00, 1.00],
    'fi': [1.00, 1.00, 0.85, 0.95, 0.90, 0.95, 0.95],
    'sg': [1.00, 1.00, 1.30, 1.10, 1.00, 1.10, 1.00],
}
FISH = {'salmon', 'white fish', 'crumbed fish', 'tuna', 'tuna big'}

# Staples with a typical local price: {key: (name, pack in the ingredient's unit, price)}.
S = 'chicken breast', 'beef mince', 'milk', 'egg', 'bread', 'rice', 'cheddar', 'butter', 'banana', 'potato', 'salmon'
def staples(*rows):
    return {k: r for k, r in zip(S, rows) if r}
ANCHORS = {
    'nz': staples(('Chicken breast 1 kg', 1000, 16.0), ('Lean beef mince 500 g', 500, 11.0), ('Standard milk 2 L', 2000, 4.6),
                  ('Eggs 12-pack', 12, 9.5), ('Wholemeal bread 700 g', 700, 3.6), ('Jasmine rice 1 kg', 1000, 3.5),
                  ('Mild cheese 1 kg', 1000, 13.5), ('Butter 500 g', 500, 8.5), ('Bananas 1 kg', 1000, 3.5),
                  ('Potatoes 2 kg', 2000, 5.0), ('Salmon fillets 2-pack 250 g', 250, 13.0)),
    'uk': staples(('Chicken breast fillets 1 kg', 1000, 6.5), ('Lean beef mince 5% fat 500 g', 500, 4.25), ('Whole milk 4 pints', 2272, 1.65),
                  ('Free range eggs 12-pack', 12, 3.5), ('Wholemeal bread 800 g', 800, 1.4), ('Basmati rice 1 kg', 1000, 2.0),
                  ('Mature cheddar 400 g', 400, 3.6), ('Butter 250 g', 250, 2.2), ('Bananas 1 kg', 1000, 0.95),
                  ('Potatoes 2 kg', 2000, 1.5), ('Salmon fillets 2-pack 240 g', 240, 4.0)),
    'ie': staples(('Chicken breast fillets 1 kg', 1000, 9.0), ('Lean beef mince 500 g', 500, 5.0), ('Whole milk 2 L', 2000, 2.2),
                  ('Free range eggs 12-pack', 12, 4.5), ('Wholemeal bread 800 g', 800, 2.0), ('Basmati rice 1 kg', 1000, 2.3),
                  ('Cheddar 400 g', 400, 4.2), ('Butter 227 g', 227, 3.3), ('Bananas 1 kg', 1000, 1.5),
                  ('Potatoes 2 kg', 2000, 2.5), ('Salmon fillets 2-pack 240 g', 240, 5.0)),
    'us': staples(('Boneless chicken breast 2 lb', 907, 7.5), ('90% lean ground beef 1 lb', 454, 6.5), ('Whole milk half gallon', 1893, 2.9),
                  ('Eggs dozen', 12, 3.8), ('Whole wheat bread 20 oz', 567, 3.3), ('Jasmine rice 2 lb', 907, 3.5),
                  ('Cheddar block 8 oz', 227, 3.0), ('Butter 1 lb', 454, 4.8), ('Bananas 2 lb', 907, 1.3),
                  ('Potatoes 5 lb', 2268, 4.5), ('Salmon fillets 12 oz', 340, 9.0)),
    'ca': staples(('Boneless chicken breast 1 kg', 1000, 18.0), ('Lean ground beef 450 g', 450, 7.5), ('Homogenized milk 2 L', 2000, 5.0),
                  ('Large eggs dozen', 12, 4.6), ('Whole wheat bread 675 g', 675, 3.8), ('Jasmine rice 1 kg', 1000, 4.0),
                  ('Old cheddar 400 g', 400, 7.5), ('Butter 454 g', 454, 6.5), ('Bananas 1 kg', 1000, 1.7),
                  ('Potatoes 5 lb (2.27 kg)', 2270, 4.5), ('Atlantic salmon fillets 250 g', 250, 7.5)),
    'jp': staples(('Chicken breast 1 kg', 1000, 850), ('Beef mince 500 g', 500, 1100), ('Milk 1 L', 1000, 270),
                  ('Eggs 10-pack', 10, 280), ('Whole wheat bread 6 slices', 360, 260), ('Rice 2 kg', 2000, 1700),
                  ('Cheese block (cheddar or Gouda) 200 g', 200, 450), ('Butter 200 g', 200, 500), ('Bananas 1 kg', 1000, 330),
                  ('Potatoes 1 kg', 1000, 450), ('Salmon fillets 200 g', 200, 600)),
    'kr': staples(('Chicken breast 1 kg', 1000, 13000), ('Beef mince 500 g', 500, 12000), ('Milk 1 L', 1000, 2900),
                  ('Eggs 10-pack', 10, 4500), ('Whole wheat bread 400 g', 400, 4500), ('Rice 4 kg', 4000, 14000),
                  ('Cheddar cheese 200 g', 200, 6000), ('Butter 200 g', 200, 6500), ('Bananas 1 kg', 1000, 4000),
                  ('Potatoes 1 kg', 1000, 4500), ('Salmon fillets 250 g', 250, 11000)),
    'de': staples(('Chicken breast fillets 1 kg', 1000, 8.5), ('Beef mince 500 g', 500, 5.5), ('Whole milk 1 L', 1000, 1.09),
                  ('Eggs 10-pack', 10, 2.6), ('Wholegrain bread 500 g', 500, 1.79), ('Long-grain rice 1 kg', 1000, 2.0),
                  ('Cheddar or Gouda 400 g', 400, 3.6), ('Butter 250 g', 250, 2.0), ('Bananas 1 kg', 1000, 1.4),
                  ('Potatoes 2 kg', 2000, 2.5), ('Salmon fillets 250 g', 250, 4.5)),
    'fr': staples(('Chicken breast fillets 1 kg', 1000, 11.0), ('Beef mince 5% fat 500 g', 500, 6.5), ('Whole milk 1 L', 1000, 1.25),
                  ('Eggs 12-pack', 12, 4.0), ('Wholemeal sandwich bread 500 g', 500, 2.2), ('Long-grain rice 1 kg', 1000, 2.4),
                  ('Cheddar or Emmental 400 g', 400, 4.2), ('Butter 250 g', 250, 2.6), ('Bananas 1 kg', 1000, 2.0),
                  ('Potatoes 2 kg', 2000, 2.8), ('Salmon fillets 250 g', 250, 6.0)),
    'nl': staples(('Chicken breast fillets 1 kg', 1000, 10.0), ('Beef mince 500 g', 500, 5.5), ('Whole milk 1 L', 1000, 1.25),
                  ('Eggs 10-pack', 10, 3.3), ('Wholemeal bread 800 g', 800, 2.2), ('Long-grain rice 1 kg', 1000, 2.3),
                  ('Gouda block 400 g', 400, 4.2), ('Butter 250 g', 250, 2.6), ('Bananas 1 kg', 1000, 1.6),
                  ('Potatoes 2 kg', 2000, 2.6), ('Salmon fillets 250 g', 250, 5.5)),
    'be': staples(('Chicken breast fillets 1 kg', 1000, 11.0), ('Beef mince 500 g', 500, 6.0), ('Whole milk 1 L', 1000, 1.2),
                  ('Eggs 10-pack', 10, 3.3), ('Wholemeal bread 800 g', 800, 2.5), ('Long-grain rice 1 kg', 1000, 2.4),
                  ('Gouda block 400 g', 400, 4.3), ('Butter 250 g', 250, 2.7), ('Bananas 1 kg', 1000, 1.8),
                  ('Potatoes 2 kg', 2000, 2.4), ('Salmon fillets 250 g', 250, 6.0)),
    'es': staples(('Chicken breast fillets 1 kg', 1000, 7.5), ('Beef mince 500 g', 500, 5.0), ('Whole milk 1 L', 1000, 1.0),
                  ('Eggs 12-pack', 12, 2.9), ('Wholemeal sliced bread 600 g', 600, 1.9), ('Long-grain rice 1 kg', 1000, 1.6),
                  ('Cheddar or semi-cured cheese 400 g', 400, 4.0), ('Butter 250 g', 250, 2.5), ('Bananas 1 kg', 1000, 1.8),
                  ('Potatoes 2 kg', 2000, 2.6), ('Salmon fillets 250 g', 250, 5.0)),
    'it': staples(('Chicken breast fillets 1 kg', 1000, 10.0), ('Beef mince 500 g', 500, 6.0), ('Whole milk 1 L', 1000, 1.5),
                  ('Eggs 10-pack', 10, 3.2), ('Wholemeal sandwich bread 400 g', 400, 2.0), ('Long-grain rice 1 kg', 1000, 2.4),
                  ('Cheese block (cheddar or Asiago) 400 g', 400, 4.8), ('Butter 250 g', 250, 2.6), ('Bananas 1 kg', 1000, 1.9),
                  ('Potatoes 2 kg', 2000, 2.8), ('Salmon fillets 250 g', 250, 6.0)),
    'pt': staples(('Chicken breast fillets 1 kg', 1000, 6.5), ('Beef mince 500 g', 500, 4.8), ('Whole milk 1 L', 1000, 0.95),
                  ('Eggs 12-pack', 12, 3.2), ('Wholemeal bread 500 g', 500, 2.0), ('Long-grain rice 1 kg', 1000, 1.4),
                  ('Cheese block 400 g', 400, 4.0), ('Butter 250 g', 250, 2.6), ('Bananas 1 kg', 1000, 1.4),
                  ('Potatoes 2 kg', 2000, 2.0), ('Salmon fillets 250 g', 250, 4.5)),
    'at': staples(('Chicken breast fillets 1 kg', 1000, 12.0), ('Beef mince 500 g', 500, 6.5), ('Whole milk 1 L', 1000, 1.5),
                  ('Eggs 10-pack', 10, 3.6), ('Wholegrain bread 500 g', 500, 2.5), ('Long-grain rice 1 kg', 1000, 2.4),
                  ('Gouda block 400 g', 400, 4.6), ('Butter 250 g', 250, 2.8), ('Bananas 1 kg', 1000, 1.8),
                  ('Potatoes 2 kg', 2000, 2.6), ('Salmon fillets 250 g', 250, 6.0)),
    'ch': staples(('Chicken breast fillets 1 kg', 1000, 26.0), ('Beef mince 500 g', 500, 9.5), ('Whole milk 1 L', 1000, 1.6),
                  ('Eggs 10-pack', 10, 6.0), ('Wholegrain bread 500 g', 500, 2.8), ('Long-grain rice 1 kg', 1000, 3.0),
                  ('Emmental or cheddar 400 g', 400, 7.0), ('Butter 250 g', 250, 3.9), ('Bananas 1 kg', 1000, 2.4),
                  ('Potatoes 2 kg', 2000, 3.6), ('Salmon fillets 250 g', 250, 9.0)),
    'se': staples(('Chicken breast fillets 1 kg', 1000, 110), ('Beef mince 500 g', 500, 65), ('Whole milk 1 L', 1000, 15),
                  ('Eggs 12-pack', 12, 45), ('Wholegrain bread 700 g', 700, 35), ('Long-grain rice 1 kg', 1000, 30),
                  ('Hard cheese 500 g', 500, 55), ('Butter 500 g', 500, 60), ('Bananas 1 kg', 1000, 25),
                  ('Potatoes 2 kg', 2000, 28), ('Salmon fillets 250 g', 250, 60)),
    'no': staples(('Chicken breast fillets 1 kg', 1000, 160), ('Beef mince 400 g', 400, 60), ('Whole milk 1 L', 1000, 24),
                  ('Eggs 12-pack', 12, 50), ('Wholegrain bread 750 g', 750, 40), ('Long-grain rice 1 kg', 1000, 35),
                  ('Hard cheese 500 g', 500, 70), ('Butter 250 g', 250, 35), ('Bananas 1 kg', 1000, 30),
                  ('Potatoes 2 kg', 2000, 40), ('Salmon fillets 250 g', 250, 55)),
    'dk': staples(('Chicken breast fillets 1 kg', 1000, 85), ('Beef mince 500 g', 500, 50), ('Whole milk 1 L', 1000, 12.5),
                  ('Eggs 10-pack', 10, 30), ('Wholegrain bread 500 g', 500, 22), ('Long-grain rice 1 kg', 1000, 22),
                  ('Hard cheese 450 g', 450, 45), ('Butter 250 g', 250, 25), ('Bananas 1 kg', 1000, 18),
                  ('Potatoes 2 kg', 2000, 20), ('Salmon fillets 250 g', 250, 45)),
    'fi': staples(('Chicken breast fillets 1 kg', 1000, 10.0), ('Beef mince 400 g', 400, 4.6), ('Whole milk 1 L', 1000, 1.15),
                  ('Eggs 10-pack', 10, 2.9), ('Rye bread 500 g', 500, 2.2), ('Long-grain rice 1 kg', 1000, 2.2),
                  ('Edam block 500 g', 500, 6.0), ('Butter 500 g', 500, 5.5), ('Bananas 1 kg', 1000, 1.7),
                  ('Potatoes 2 kg', 2000, 2.2), ('Salmon fillets 250 g', 250, 6.5)),
    'sg': staples(('Chicken breast 1 kg', 1000, 11.0), ('Beef mince 500 g', 500, 9.5), ('Fresh milk 2 L', 2000, 7.0),
                  ('Eggs 10-pack', 10, 3.8), ('Wholemeal bread 400 g', 400, 2.8), ('Jasmine rice 2 kg', 2000, 6.0),
                  ('Cheddar 250 g', 250, 7.0), ('Butter 250 g', 250, 6.5), ('Bananas 1 kg', 1000, 3.0),
                  ('Potatoes 2 kg', 2000, 4.5), ('Salmon fillets 250 g', 250, 9.0)),
}

# Things that are hard to find there: the builder leaves out dishes that need them.
MISSING = {
    'jp': ['weet-bix', 'vegemite', 'halloumi', 'tzatziki'],
    'kr': ['weet-bix', 'vegemite', 'halloumi', 'tzatziki'],
    'sg': [],
}
for c in ['de', 'fr', 'nl', 'be', 'es', 'it', 'pt', 'at', 'ch', 'se', 'no', 'dk', 'fi']:
    MISSING[c] = ['weet-bix', 'vegemite']
for c in ['us', 'ca']:
    MISSING[c] = ['vegemite']

# Shop names without the size, where they differ from Australia's. "uk" is used everywhere
# except Australia, New Zealand, the US and Canada.
NAMES = {
    'uk': {'cheddar': 'Cheddar', 'cream': 'Double cream', 'cucumber': 'Cucumbers', 'capsicum': 'Red pepper',
           'zucchini': 'Courgettes', 'pumpkin': 'Butternut squash', 'pita': 'Pitta bread', 'fruit bread': 'Fruit loaf',
           'milk': 'Whole milk', 'tuna': 'Tuna in spring water', 'tuna big': 'Tuna in spring water', 'corn': 'Sweetcorn',
           'weet-bix': 'Weetabix', 'vegemite': 'Marmite', 'ham': 'Sliced ham', 'onion': 'Onions', 'lettuce': 'Romaine lettuce',
           'beef steak': 'Beef rump steak', 'mozzarella': 'Grated mozzarella'},
    'nz': {'cream': 'Cream', 'zucchini': 'Courgettes', 'pita': 'Pita bread', 'vegemite': 'Marmite', 'cucumber': 'Telegraph cucumber'},
    'us': {'chicken breast': 'Boneless chicken breast', 'chicken thigh': 'Boneless chicken thighs', 'beef mince': '90% lean ground beef',
           'beef steak': 'Sirloin steak', 'lamb mince': 'Ground lamb', 'pork mince': 'Ground pork', 'turkey mince': 'Ground turkey',
           'ham': 'Deli ham', 'tuna': 'Chunk light tuna in water', 'tuna big': 'Chunk light tuna in water', 'milk': 'Whole milk',
           'cheddar': 'Cheddar', 'mozzarella': 'Shredded mozzarella', 'cream': 'Heavy cream', 'cucumber': 'Cucumbers',
           'capsicum': 'Red bell pepper', 'pumpkin': 'Butternut squash', 'spring onion': 'Green onions', 'onion': 'Yellow onions',
           'lettuce': 'Romaine lettuce', 'bread': 'Whole wheat bread', 'wraps': 'Whole wheat tortillas', 'pita': 'Pita bread',
           'fruit bread': 'Raisin bread', 'corn': 'Corn kernels', 'weet-bix': 'Weetabix', 'stock': 'Low-sodium chicken broth',
           'veg stock': 'Low-sodium vegetable broth', 'soy sauce': 'Low-sodium soy sauce', 'tomato paste': 'Tomato paste',
           'canned tomatoes': 'Diced tomatoes', 'passata': 'Tomato puree (passata)', 'mandarin': 'Clementines',
           'coleslaw mix': 'Coleslaw mix', 'crackers': 'Water crackers', 'sour cream': 'Light sour cream'},
}
NAMES['ca'] = dict(NAMES['us'], **{'capsicum': 'Red pepper', 'beef mince': 'Lean ground beef', 'milk': 'Homogenized milk'})

# Words to change in recipe text (dish names, steps, ingredient labels): whole words, in order.
WORDS = {
    'uk': [['butternut pumpkin', 'butternut squash'], ['pumpkin', 'butternut squash'], ['capsicums', 'peppers'], ['capsicum', 'pepper'],
           ['zucchinis', 'courgettes'], ['zucchini', 'courgette'], ['Weet-Bix', 'Weetabix'], ['Lebanese bread', 'pitta bread'],
           ['Lebanese cucumbers', 'cucumbers'], ['Lebanese cucumber', 'cucumber'], ['thickened cream', 'double cream'],
           ['tasty cheese', 'cheddar'], ['springwater', 'spring water'], ['full cream milk', 'whole milk'], ['Vegemite', 'Marmite']],
    'nz': [['zucchinis', 'courgettes'], ['zucchini', 'courgette'], ['Lebanese bread', 'pita bread'], ['thickened cream', 'cream'],
           ['Lebanese cucumbers', 'cucumbers'], ['Lebanese cucumber', 'cucumber']],
    'us': [['butternut pumpkin', 'butternut squash'], ['pumpkin', 'butternut squash'], ['red capsicum', 'red bell pepper'],
           ['capsicums', 'bell peppers'], ['capsicum', 'bell pepper'], ['Weet-Bix', 'Weetabix'], ['Lebanese bread', 'pita bread'],
           ['Lebanese cucumbers', 'cucumbers'], ['Lebanese cucumber', 'cucumber'], ['thickened cream', 'heavy cream'],
           ['tasty cheese', 'cheddar'], ['beef mince', 'ground beef'], ['lamb mince', 'ground lamb'], ['pork mince', 'ground pork'],
           ['turkey mince', 'ground turkey'], ['mince', 'ground meat'], ['spring onions', 'green onions'], ['spring onion', 'green onion'],
           ['wholemeal', 'whole wheat'], ['coriander', 'cilantro'], ['rocket', 'arugula'], ['full cream milk', 'whole milk'],
           ['springwater', 'water'], ['salt-reduced', 'low-sodium'], ['chicken stock', 'chicken broth'],
           ['vegetable stock', 'vegetable broth'], ['veg stock', 'vegetable broth']],
}
STYLE = {'au': 'au', 'nz': 'nz', 'us': 'us', 'ca': 'us'}

SIZE = re.compile(r'^(.*?)(?:\s+((?:\d+-pack)?\s*(?:\d[\d.]*\s?(?:kg|g|L|ml))?(?:\s+can)?))?$')
def split(name):
    m = SIZE.match(name)
    return m.group(1).strip(), (m.group(2) or '').strip()

def us_size(size, pack, unit):
    """A metric size label in US units, and the US pack in grams or ml (None keeps the pack)."""
    m = re.search(r'(\d[\d.]*)\s?(kg|g|L|ml)', size)
    if not m:
        return size, None
    n, u = float(m.group(1)), m.group(2)
    can = size.endswith('can')
    grams = n * (1000 if u in ('kg', 'L') else 1)
    if u in ('L', 'ml'):
        if grams >= 1800: label, new = 'half gallon', 1893
        elif grams >= 900: label, new = '32 fl oz', 946
        else:
            oz = max(1, round(grams / 29.57)); label, new = str(oz) + ' fl oz', round(oz * 29.57)
    elif grams >= 900:
        lb = round(grams / 453.6 * 2) / 2; label, new = ('%g lb' % lb), round(lb * 453.6)
    elif grams >= 440:
        label, new = '1 lb', 454
    else:
        oz = max(1, round(grams / 28.35)); label, new = str(oz) + ' oz', round(oz * 28.35)
    prefix = size[:m.start()].strip()
    label = (prefix + ' ' + label).strip() + (' can' if can else '')
    # Cans keep the drained amount the recipes use; other packs change to the US size.
    if can or unit not in ('g', 'ml') or pack != grams:
        return label, None
    return label, new

def round_price(p, currency):
    if currency == 'JPY': return int(round(p / 10) * 10) or 10
    if currency == 'KRW': return int(round(p / 100) * 100) or 100
    if currency in ('SEK', 'NOK', 'DKK'): return round(round(p * 2) / 2, 2) or 0.5
    return round(round(p * 20) / 20, 2) or 0.05

def build():
    regions = open(os.path.join(ROOT, 'site', 'regions.js'), encoding='utf-8').read()
    countries = {}
    for cid, cur in re.findall(r'^\s+(\w\w): \{"name": "[^"]+", "where": "[^"]+", "currency": "(\w+)"', regions, re.M):
        if cid == 'au':
            continue
        style = STYLE.get(cid, 'uk')
        names = NAMES.get(style, NAMES['uk']) if style != 'nz' else NAMES['nz']
        levels = dict(zip(CATS, LEVELS[cid]))
        items = {}
        for key, ing in ING.items():
            if ing['aisle'] == 'assumed':
                continue
            if key in ANCHORS.get(cid, {}):
                name, pack, price = ANCHORS[cid][key]
                items[key] = [name, pack, price]
                continue
            base, size = split(ing['name'])
            base = names.get(key, base)
            pack = ing['pack']
            if cid == 'us' and size:
                size, new = us_size(size, pack, ing['unit'])
                if new: pack = new
            cat = 'fish' if key in FISH else {'fresh': 'fresh', 'meat': 'meat', 'dairy': 'dairy', 'bread': 'bread', 'frozen': 'frozen'}.get(ing['aisle'], 'pantry')
            price = ing['price'] * (pack / ing['pack']) * RATES[cur] * levels[cat]
            items[key] = [(base + ' ' + size).strip(), pack, round_price(price, cur)]
        countries[cid] = {'currency': cur, 'rate': RATES[cur], 'words': style if style != 'au' else None, 'missing': MISSING.get(cid, []), 'items': items}
    out = {
        'about': 'Local shop names, pack sizes and prices for the plan builder, per country (Australia is in library.json). '
                 'Prices are estimates in local currency, made by tools/build_prices.py: typical prices for staples, the rest '
                 'scaled from Australian prices by local price levels. Packs are in the ingredient\'s unit (g, ml or each).',
        'updated': UPDATED,
        'words': {k: v for k, v in WORDS.items()},
        'countries': countries,
    }
    path = os.path.join(ROOT, 'api', 'library-prices.json')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('{\n')
        f.write('  "about": %s,\n  "updated": %s,\n' % (json.dumps(out['about']), json.dumps(UPDATED)))
        f.write('  "words": {\n' + ',\n'.join('    %s: %s' % (json.dumps(k), json.dumps(v, ensure_ascii=False)) for k, v in out['words'].items()) + '\n  },\n')
        f.write('  "countries": {\n')
        parts = []
        for cid, c in countries.items():
            lines = ['    %s: {"currency": %s, "rate": %s, "words": %s, "missing": %s, "items": {' % (json.dumps(cid), json.dumps(c['currency']), json.dumps(c['rate']), json.dumps(c['words']), json.dumps(c['missing']))]
            lines.append(',\n'.join('      %s: %s' % (json.dumps(k), json.dumps(v, ensure_ascii=False)) for k, v in c['items'].items()))
            lines.append('    }}')
            parts.append('\n'.join(lines))
        f.write(',\n'.join(parts) + '\n  }\n}\n')
    print('wrote', path, len(countries), 'countries,', sum(len(c['items']) for c in countries.values()), 'prices')

if __name__ == '__main__':
    build()
