#!/usr/bin/env python3
"""Builds api/library.json: the meal and exercise library the built-in plan builder uses when a
family chooses not to use AI (api/planbuilder.js).

Every recipe here is written for this project (the steps are our own words). Nutrition is worked
out from each ingredient's amount, using USDA FoodData Central (SR Legacy, 2018), which is in the
public domain (CC0 1.0): U.S. Department of Agriculture, Agricultural Research Service.
FoodData Central, 2019. fdc.nal.usda.gov. A few Australian products that aren't in it (halloumi,
Vegemite, simmer sauces and so on) use typical values from their nutrition labels, marked "label".

Prices are rough Coles estimates in AUD and will drift; the plan says they are estimates.

Usage (from the project folder):
  1. Download "SR Legacy" (CSV) from https://fdc.nal.usda.gov/download-datasets and unzip it.
  2. python3 tools/build_library.py <the unzipped folder>
It prints a summary and writes api/library.json.
"""
import csv
import json
import math
import os
import sys

# ---------------------------------------------------------------------------
# Ingredients
# ---------------------------------------------------------------------------
# key: (shopping name, nutrition, pack size, unit, price, aisle, tags, kind, each grams)
#   nutrition: a FoodData Central id, or ("label", protein, carbs, fat, kcal, calcium mg) per 100 g
#   unit: "g", "ml" or "each" (then pack size is a count and "each grams" is one item's weight)
#   aisle: fresh, meat, dairy, bread, frozen, pantry, or assumed (oil, spices: assumed on hand)
#   tags: allergens (milk, lactose, egg, gluten, soy, fish, shellfish, peanut, treenut, sesame)
#         and what it is (meat, poultry, red, pork, beef, lamb, animal, honey, spicy)
#   kind: for food groups (see tools/estimate_groups.py): veg, potato, fruit, grain, red,
#         processed, poultry, fish, oily, egg, legume, tofu, nut, dairy, or None
I = {
    # meat and fish
    'chicken breast': ('Chicken breast fillets 1 kg', 171077, 1000, 'g', 13.00, 'meat', ['meat', 'poultry'], 'poultry', 0),
    'chicken thigh': ('Chicken thigh fillets 1 kg', 173627, 1000, 'g', 14.00, 'meat', ['meat', 'poultry'], 'poultry', 0),
    'chicken drumsticks': ('Chicken drumsticks 1 kg', 172373, 1000, 'g', 6.50, 'meat', ['meat', 'poultry'], 'poultry', 0),
    'beef mince': ('Lean beef mince 500 g', 174030, 500, 'g', 9.50, 'meat', ['meat', 'red', 'beef'], 'red', 0),
    'beef steak': ('Beef rump steak 500 g', 174055, 500, 'g', 14.00, 'meat', ['meat', 'red', 'beef'], 'red', 0),
    'beef strips': ('Beef stir-fry strips 500 g', 174055, 500, 'g', 12.00, 'meat', ['meat', 'red', 'beef'], 'red', 0),
    'lamb mince': ('Lamb mince 500 g', 172608, 500, 'g', 11.00, 'meat', ['meat', 'red', 'lamb'], 'red', 0),
    'pork mince': ('Pork mince 500 g', 167902, 500, 'g', 7.50, 'meat', ['meat', 'red', 'pork'], 'red', 0),
    'turkey mince': ('Turkey mince 500 g', 171505, 500, 'g', 8.00, 'meat', ['meat', 'poultry'], 'poultry', 0),
    'beef sausages': ('Beef sausages 500 g', 174618, 500, 'g', 6.00, 'meat', ['meat', 'red', 'beef', 'gluten'], 'processed', 0),
    'ham': ('Shaved ham 250 g', 173864, 250, 'g', 5.00, 'meat', ['meat', 'red', 'pork'], 'processed', 0),
    'salmon': ('Salmon fillets 2-pack 250 g', 175167, 250, 'g', 11.00, 'meat', ['fish', 'animal'], 'oily', 0),
    'white fish': ('Frozen white fish fillets 1 kg', 175176, 1000, 'g', 13.00, 'frozen', ['fish', 'animal'], 'fish', 0),
    'crumbed fish': ('Frozen crumbed fish fillets 425 g', 174195, 425, 'g', 6.50, 'frozen', ['fish', 'animal', 'gluten'], 'fish', 0),
    'tuna': ('Tuna in springwater 95 g can', 171986, 95, 'g', 1.60, 'pantry', ['fish', 'animal'], 'fish', 0),
    'tuna big': ('Tuna in springwater 425 g can', 171986, 425, 'g', 5.00, 'pantry', ['fish', 'animal'], 'fish', 0),
    # eggs and dairy
    'egg': ('Eggs 12-pack', 171287, 12, 'each', 6.50, 'dairy', ['egg', 'animal'], 'egg', 55),
    'milk': ('Full cream milk 2 L', 171265, 2000, 'ml', 3.20, 'dairy', ['milk', 'lactose', 'animal'], 'dairy', 0),
    'greek yoghurt': ('Greek yoghurt 1 kg', 171304, 1000, 'g', 6.00, 'dairy', ['milk', 'lactose', 'animal'], 'dairy', 0),
    'cheddar': ('Tasty cheese block 500 g', 170899, 500, 'g', 8.50, 'dairy', ['milk', 'animal'], 'dairy', 0),
    'mozzarella': ('Grated mozzarella 500 g', 170900, 500, 'g', 8.00, 'dairy', ['milk', 'animal'], 'dairy', 0),
    'ricotta': ('Ricotta 375 g', 170851, 375, 'g', 4.50, 'dairy', ['milk', 'lactose', 'animal'], 'dairy', 0),
    'feta': ('Feta 200 g', 173420, 200, 'g', 5.00, 'dairy', ['milk', 'animal'], 'dairy', 0),
    'halloumi': ('Halloumi 180 g', ('label', 21, 2, 25, 320, 700), 180, 'g', 6.00, 'dairy', ['milk', 'animal'], 'dairy', 0),
    'cottage cheese': ('Cottage cheese 250 g', 172179, 250, 'g', 3.50, 'dairy', ['milk', 'lactose', 'animal'], 'dairy', 0),
    'sour cream': ('Light sour cream 300 g', 173443, 300, 'g', 3.00, 'dairy', ['milk', 'lactose', 'animal'], None, 0),
    'cream': ('Thickened cream 300 ml', 170859, 300, 'ml', 3.00, 'dairy', ['milk', 'lactose', 'animal'], None, 0),
    'butter': ('Butter 250 g', 173410, 250, 'g', 5.50, 'dairy', ['milk', 'animal'], None, 0),
    'tzatziki': ('Tzatziki 200 g', ('label', 4, 4, 8, 105, 120), 200, 'g', 3.50, 'dairy', ['milk', 'lactose', 'animal'], None, 0),
    'hummus': ('Hummus 200 g', 174289, 200, 'g', 3.50, 'dairy', ['sesame'], None, 0),
    'tofu': ('Firm tofu 450 g', 175236, 450, 'g', 4.00, 'dairy', ['soy'], 'tofu', 0),
    'pesto': ('Basil pesto 190 g', 171580, 190, 'g', 3.50, 'dairy', ['milk', 'treenut', 'animal'], None, 0),
    # fruit and veg
    'broccoli': ('Broccoli', 170379, 1, 'each', 2.90, 'fresh', [], 'veg', 350),
    'carrot': ('Carrots 1 kg', 170393, 1000, 'g', 2.20, 'fresh', [], 'veg', 0),
    'onion': ('Brown onions 1 kg', 170000, 1000, 'g', 3.00, 'fresh', [], 'veg', 0),
    'tomato': ('Tomatoes', 170457, 1, 'each', 0.90, 'fresh', [], 'veg', 150),
    'spinach': ('Baby spinach 120 g', 168462, 120, 'g', 3.00, 'fresh', [], 'veg', 0),
    'lettuce': ('Cos lettuce', 169247, 1, 'each', 2.20, 'fresh', [], 'veg', 400),
    'salad leaves': ('Mixed salad leaves 120 g', 169249, 120, 'g', 3.50, 'fresh', [], 'veg', 0),
    'cucumber': ('Lebanese cucumbers', 169225, 1, 'each', 1.20, 'fresh', [], 'veg', 180),
    'capsicum': ('Red capsicum', 170108, 1, 'each', 1.80, 'fresh', [], 'veg', 180),
    'zucchini': ('Zucchini', 169291, 1, 'each', 1.40, 'fresh', [], 'veg', 200),
    'pumpkin': ('Butternut pumpkin piece 1 kg', 168448, 1000, 'g', 3.50, 'fresh', [], 'veg', 0),
    'mushrooms': ('Mushrooms 200 g', 169251, 200, 'g', 3.50, 'fresh', [], 'veg', 0),
    'green beans': ('Green beans 300 g', 169961, 300, 'g', 3.00, 'fresh', [], 'veg', 0),
    'coleslaw mix': ('Coleslaw mix 400 g', 169975, 400, 'g', 3.50, 'fresh', [], 'veg', 0),
    'cauliflower': ('Cauliflower', 169986, 1, 'each', 4.50, 'fresh', [], 'veg', 800),
    'celery': ('Celery half bunch', 169988, 1, 'each', 2.50, 'fresh', [], 'veg', 400),
    'avocado': ('Avocados', 171705, 1, 'each', 2.00, 'fresh', [], 'veg', 170),
    'garlic': ('Garlic', 169230, 1, 'each', 1.00, 'fresh', [], None, 45),
    'ginger': ('Minced ginger jar 190 g', 169231, 190, 'g', 3.50, 'pantry', [], None, 0),
    'spring onion': ('Spring onions bunch', 170005, 1, 'each', 2.50, 'fresh', [], 'veg', 100),
    'lemon': ('Lemons', 167746, 1, 'each', 1.00, 'fresh', [], None, 100),
    'potato': ('Potatoes 2 kg', 170026, 2000, 'g', 5.00, 'fresh', [], 'potato', 0),
    'sweet potato': ('Sweet potato 1 kg', 168482, 1000, 'g', 4.50, 'fresh', [], 'veg', 0),
    'apple': ('Apples 1 kg', 171688, 1000, 'g', 5.00, 'fresh', [], 'fruit', 0),
    'banana': ('Bananas 1 kg', 173944, 1000, 'g', 4.00, 'fresh', [], 'fruit', 0),
    'mandarin': ('Mandarins 1 kg', 169105, 1000, 'g', 4.50, 'fresh', [], 'fruit', 0),
    # bread
    'bread': ('Wholemeal bread 700 g', 172688, 700, 'g', 3.20, 'bread', ['gluten'], 'grain', 0),
    'wraps': ('Wholemeal wraps 8-pack', 167535, 8, 'each', 3.50, 'bread', ['gluten'], 'grain', 45),
    'rolls': ('Bread rolls 6-pack', 172796, 6, 'each', 3.50, 'bread', ['gluten'], 'grain', 65),
    'pita': ('Lebanese bread 5-pack', 174915, 5, 'each', 2.80, 'bread', ['gluten'], 'grain', 80),
    'fruit bread': ('Fruit bread 520 g', ('label', 8, 50, 3, 260, 60), 520, 'g', 4.00, 'bread', ['gluten'], 'grain', 0),
    # frozen
    'frozen peas': ('Frozen peas 1 kg', 170016, 1000, 'g', 3.20, 'frozen', [], 'veg', 0),
    'frozen veg': ('Frozen mixed vegetables 1 kg', 170471, 1000, 'g', 3.50, 'frozen', [], 'veg', 0),
    'stir-fry veg': ('Frozen stir-fry vegetables 1 kg', 170471, 1000, 'g', 4.00, 'frozen', [], 'veg', 0),
    'frozen berries': ('Frozen mixed berries 1 kg', 173950, 1000, 'g', 9.00, 'frozen', [], 'fruit', 0),
    'edamame': ('Frozen edamame 400 g', 168410, 400, 'g', 4.00, 'frozen', ['soy'], 'legume', 0),
    # pantry
    'rice': ('Jasmine rice 1 kg', 168877, 1000, 'g', 3.20, 'pantry', [], 'grain', 0),
    'pasta': ('Pasta 500 g', 169736, 500, 'g', 1.80, 'pantry', ['gluten'], 'grain', 0),
    'egg noodles': ('Dried egg noodles 375 g', 169731, 375, 'g', 2.70, 'pantry', ['gluten', 'egg', 'animal'], 'grain', 0),
    'rice noodles': ('Rice vermicelli 250 g', 169742, 250, 'g', 2.50, 'pantry', [], 'grain', 0),
    'couscous': ('Couscous 500 g', 169699, 500, 'g', 2.50, 'pantry', ['gluten'], 'grain', 0),
    'oats': ('Rolled oats 750 g', 173904, 750, 'g', 2.50, 'pantry', ['gluten'], 'grain', 0),
    'weet-bix': ('Weet-Bix 575 g', 169040, 575, 'g', 4.50, 'pantry', ['gluten'], 'grain', 0),
    'muesli': ('Natural muesli 750 g', ('label', 10, 60, 8, 370, 50), 750, 'g', 5.00, 'pantry', ['gluten', 'treenut'], 'grain', 0),
    'canned tomatoes': ('Diced tomatoes 400 g can', 170051, 400, 'g', 1.10, 'pantry', [], 'veg', 0),
    'passata': ('Passata 700 g', 170460, 700, 'g', 2.50, 'pantry', [], 'veg', 0),
    'tomato paste': ('Tomato paste 140 g', 170459, 140, 'g', 1.20, 'pantry', [], None, 0),
    'chickpeas': ('Chickpeas 400 g can', 173800, 240, 'g', 1.20, 'pantry', [], 'legume', 0),
    'black beans': ('Black beans 400 g can', 175188, 240, 'g', 1.30, 'pantry', [], 'legume', 0),
    'kidney beans': ('Red kidney beans 400 g can', 174285, 240, 'g', 1.20, 'pantry', [], 'legume', 0),
    'red lentils': ('Red lentils 500 g', 174284, 500, 'g', 3.00, 'pantry', [], 'legume', 0),
    'baked beans': ('Baked beans 420 g can', 175182, 420, 'g', 1.50, 'pantry', [], 'legume', 0),
    'corn': ('Corn kernels 420 g can', 169214, 300, 'g', 1.50, 'pantry', [], 'veg', 0),
    'coconut milk': ('Light coconut milk 400 ml can', 170173, 400, 'ml', 1.50, 'pantry', [], None, 0),
    'stock': ('Salt-reduced chicken stock 1 L', ('label', 0.5, 0.5, 0.2, 6, 5), 1000, 'ml', 2.50, 'pantry', ['meat', 'poultry'], None, 0),
    'veg stock': ('Salt-reduced vegetable stock 1 L', ('label', 0.3, 1.0, 0.1, 6, 5), 1000, 'ml', 2.50, 'pantry', [], None, 0),
    'soy sauce': ('Salt-reduced soy sauce 250 ml', 172473, 250, 'ml', 2.50, 'pantry', ['soy', 'gluten'], None, 0),
    'teriyaki': ('Teriyaki sauce 250 ml', 171167, 250, 'ml', 3.50, 'pantry', ['soy', 'gluten'], None, 0),
    'fish sauce': ('Fish sauce 200 ml', ('label', 5, 4, 0, 35, 40), 200, 'ml', 2.50, 'pantry', ['fish', 'animal'], None, 0),
    'sesame oil': ('Sesame oil 150 ml', 171016, 150, 'ml', 3.50, 'pantry', ['sesame'], None, 0),
    'curry paste': ('Thai green curry paste 195 g', ('label', 2, 10, 8, 120, 40), 195, 'g', 3.50, 'pantry', ['spicy', 'shellfish'], None, 0),
    'butter chicken sauce': ('Butter chicken simmer sauce 485 g', ('label', 2, 9, 7, 105, 30), 485, 'g', 4.00, 'pantry', ['milk', 'animal', 'treenut'], None, 0),
    'taco seasoning': ('Taco seasoning 30 g', ('label', 5, 55, 3, 280, 100), 30, 'g', 1.20, 'pantry', [], None, 0),
    'bbq sauce': ('Barbecue sauce 500 ml', 174523, 500, 'ml', 3.00, 'pantry', [], None, 0),
    'mayonnaise': ('Mayonnaise 440 g', 171009, 440, 'g', 4.00, 'pantry', ['egg', 'animal'], None, 0),
    'peanut butter': ('Smooth peanut butter 375 g', 174294, 375, 'g', 3.50, 'pantry', ['peanut'], 'nut', 0),
    'almonds': ('Almonds 250 g', 170567, 250, 'g', 5.00, 'pantry', ['treenut'], 'nut', 0),
    'rice crackers': ('Rice crackers 100 g', 173161, 100, 'g', 2.00, 'pantry', [], 'grain', 0),
    'crackers': ('Water crackers 125 g', 172746, 125, 'g', 2.00, 'pantry', ['gluten'], 'grain', 0),
    'honey': ('Honey 500 g', 169640, 500, 'g', 6.00, 'pantry', ['honey', 'animal'], None, 0),
    'vegemite': ('Vegemite 220 g', ('label', 25, 9, 1, 180, 20), 220, 'g', 5.00, 'pantry', ['gluten'], None, 0),
    # assumed on hand (not on the shopping list)
    'oil': ('Olive oil', 171413, 0, 'ml', 0, 'assumed', [], None, 0),
    'curry powder': ('Curry powder', 170924, 0, 'g', 0, 'assumed', ['spicy'], None, 0),
    'chilli powder': ('Chilli powder', 171319, 0, 'g', 0, 'assumed', ['spicy'], None, 0),
}

# ---------------------------------------------------------------------------
# Dishes. Amounts are for ONE average adult serve, in grams (ml for liquids, a count for "each").
# ---------------------------------------------------------------------------
# meal: breakfast, lunch, dinner. minutes: hands-on plus cooking. kit: what it needs.
# texture: mixed (stews, curries, sauces through everything), soft, slimy, crunchy.
# leftovers: keeps well for tomorrow's lunch. onepan: one pan or tray. separate: the parts
# can easily be served apart (for people who don't like foods touching).
D = []


def dish(name, meal, cuisine, minutes, kit, per, steps, **kw):
    D.append(dict(name=name, meal=meal, cuisine=cuisine, minutes=minutes, kit=kit, per=per, steps=steps, **kw))


# --- dinners ---
dish('Chicken and vegetable stir-fry with rice', 'dinner', 'Chinese', 25, ['stovetop'],
     [('chicken breast', 150), ('rice', 75), ('stir-fry veg', 200), ('soy sauce', 15), ('garlic', 0.1), ('ginger', 4), ('oil', 5)],
     ['Cook the rice.', 'Slice the chicken thinly. Stir-fry it in a hot pan with the oil until cooked through, then set aside.',
      'Stir-fry the vegetables with the garlic and ginger for 4 minutes.', 'Add the chicken and soy sauce, toss, and serve on the rice.'],
     leftovers=True, separate=True, kid='Serve the chicken, rice and vegetables in separate piles.')
dish('Beef and broccoli stir-fry with rice', 'dinner', 'Chinese', 25, ['stovetop'],
     [('beef strips', 140), ('rice', 75), ('broccoli', 0.4), ('capsicum', 0.5), ('soy sauce', 15), ('garlic', 0.1), ('oil', 5)],
     ['Cook the rice.', 'Stir-fry the beef in a very hot pan with the oil in two batches, 2 minutes each. Set aside.',
      'Stir-fry the broccoli and capsicum with the garlic and a splash of water for 4 minutes.', 'Return the beef, add the soy sauce, toss and serve on the rice.'],
     leftovers=True, separate=True)
dish('Spaghetti bolognese', 'dinner', 'Italian', 40, ['stovetop'],
     [('beef mince', 130), ('pasta', 85), ('passata', 150), ('onion', 60), ('carrot', 50), ('garlic', 0.1), ('cheddar', 10), ('oil', 5)],
     ['Fry the chopped onion, grated carrot and garlic in the oil for 5 minutes.', 'Add the mince and brown it, breaking it up.',
      'Add the passata and simmer for 20 minutes.', 'Cook the pasta, then serve with the sauce and a little grated cheese.'],
     leftovers=True, texture=['mixed'], batch=True, kid='Plain pasta with a little sauce on the side.')
dish('Turkey chilli with rice', 'dinner', 'Mexican', 35, ['stovetop'],
     [('turkey mince', 130), ('kidney beans', 60), ('canned tomatoes', 130), ('onion', 50), ('capsicum', 0.3), ('rice', 70), ('taco seasoning', 6), ('sour cream', 20), ('oil', 5)],
     ['Cook the rice.', 'Fry the onion and capsicum in the oil for 5 minutes, then brown the mince.',
      'Add the taco seasoning, tomatoes and drained beans. Simmer for 15 minutes.', 'Serve on the rice with a spoon of sour cream.'],
     leftovers=True, texture=['mixed'], batch=True, spicy=True, kid='Take a portion out before adding the seasoning, if needed.')
dish('Chicken fajita wraps', 'dinner', 'Mexican', 25, ['stovetop'],
     [('chicken breast', 130), ('wraps', 2), ('capsicum', 0.5), ('onion', 40), ('taco seasoning', 5), ('lettuce', 0.1), ('sour cream', 20), ('oil', 5)],
     ['Slice the chicken, capsicum and onion into strips. Toss the chicken with the seasoning.',
      'Fry the chicken in the oil for 6 minutes, add the vegetables and cook 4 minutes more.',
      'Warm the wraps. Everyone fills their own with the chicken, lettuce and sour cream.'],
     separate=True, spicy=True, kid='Plain chicken strips and cheese in a wrap.')
dish('Beef tacos with salad', 'dinner', 'Mexican', 20, ['stovetop'],
     [('beef mince', 120), ('wraps', 2), ('taco seasoning', 6), ('lettuce', 0.1), ('tomato', 0.5), ('cheddar', 20), ('oil', 3)],
     ['Brown the mince in the oil. Add the seasoning and a splash of water and simmer for 5 minutes.',
      'Shred the lettuce, dice the tomato and grate the cheese.', 'Everyone fills their own wraps.'],
     separate=True, spicy=True, kid='Mince with cheese, no seasoning on theirs if needed.')
dish('Butter chicken with rice and peas', 'dinner', 'Indian', 30, ['stovetop'],
     [('chicken thigh', 140), ('butter chicken sauce', 110), ('rice', 75), ('frozen peas', 70)],
     ['Cook the rice, adding the peas for the last 3 minutes.', 'Brown the diced chicken in a pan for 6 minutes.',
      'Add the sauce and simmer for 10 minutes until the chicken is cooked through.', 'Serve with the rice and peas.'],
     leftovers=True, texture=['mixed'])
dish('Chickpea and spinach curry with rice', 'dinner', 'Indian', 30, ['stovetop'],
     [('chickpeas', 120), ('spinach', 40), ('canned tomatoes', 100), ('coconut milk', 60), ('onion', 50), ('garlic', 0.1), ('curry powder', 4), ('rice', 75), ('oil', 5)],
     ['Cook the rice.', 'Fry the onion and garlic in the oil for 5 minutes. Stir in the curry powder for 1 minute.',
      'Add the drained chickpeas, tomatoes and coconut milk. Simmer for 12 minutes.', 'Stir the spinach through until it wilts. Serve on the rice.'],
     leftovers=True, texture=['mixed'], batch=True, spicy=True)
dish('Red lentil dahl with rice', 'dinner', 'Indian', 35, ['stovetop'],
     [('red lentils', 70), ('canned tomatoes', 100), ('onion', 50), ('carrot', 50), ('garlic', 0.1), ('ginger', 4), ('curry powder', 4), ('veg stock', 200), ('rice', 60), ('oil', 5)],
     ['Cook the rice.', 'Fry the onion, grated carrot, garlic and ginger in the oil for 5 minutes. Add the curry powder.',
      'Add the rinsed lentils, tomatoes and stock. Simmer for 20 minutes, stirring now and then, until thick.', 'Serve on the rice.'],
     leftovers=True, texture=['mixed', 'soft'], batch=True, spicy=True)
dish('Baked salmon with potatoes and greens', 'dinner', 'Australian', 35, ['oven'],
     [('salmon', 125), ('potato', 200), ('green beans', 80), ('broccoli', 0.25), ('lemon', 0.25), ('oil', 5)],
     ['Heat the oven to 200 °C. Cut the potatoes into chunks, toss with the oil and roast for 30 minutes.',
      'Add the salmon to the tray for the last 12 minutes, with lemon slices on top.', 'Steam the beans and broccoli. Serve together.'],
     onepan=True, separate=True)
dish('Lemon chicken tray bake', 'dinner', 'Australian', 45, ['oven'],
     [('chicken thigh', 150), ('potato', 150), ('pumpkin', 100), ('zucchini', 0.5), ('onion', 40), ('lemon', 0.25), ('oil', 7)],
     ['Heat the oven to 200 °C. Cut the vegetables into chunks.', 'Toss the chicken and vegetables with the oil, lemon juice, salt and pepper on a big tray.',
      'Roast for 35 to 40 minutes, turning once, until golden and cooked through.'],
     onepan=True, separate=True, leftovers=True)
dish('Honey soy chicken drumsticks with rice and corn', 'dinner', 'Australian', 50, ['oven'],
     [('chicken drumsticks', 220), ('honey', 10), ('soy sauce', 10), ('rice', 70), ('corn', 60), ('broccoli', 0.25)],
     ['Heat the oven to 200 °C. Toss the drumsticks with the honey and soy sauce on a lined tray.',
      'Bake for 40 to 45 minutes, turning once.', 'Cook the rice. Warm the corn and steam the broccoli.'],
     separate=True)
dish('Lamb koftas with couscous and salad', 'dinner', 'Middle Eastern', 30, ['stovetop'],
     [('lamb mince', 120), ('couscous', 70), ('tzatziki', 40), ('cucumber', 0.5), ('tomato', 0.5), ('onion', 20), ('oil', 3)],
     ['Mix the mince with the finely chopped onion, salt and pepper. Shape into small sausages.',
      'Fry the koftas in the oil for 8 to 10 minutes, turning, until cooked through.',
      'Pour boiling water over the couscous (same amount as the couscous), cover for 5 minutes, then fluff.',
      'Serve with chopped cucumber and tomato and the tzatziki.'],
     separate=True)
dish('Greek chicken souvlaki wraps', 'dinner', 'Greek', 25, ['stovetop'],
     [('chicken breast', 130), ('pita', 1), ('tzatziki', 40), ('lettuce', 0.1), ('tomato', 0.5), ('cucumber', 0.3), ('lemon', 0.2), ('oil', 5)],
     ['Dice the chicken and toss with the oil, lemon juice, salt and dried oregano if you have it.',
      'Fry for 8 minutes until cooked through.', 'Warm the bread and fill with chicken, salad and tzatziki.'],
     separate=True, leftovers=False)
dish('Vegetable frittata with salad', 'dinner', 'Australian', 35, ['stovetop', 'oven'],
     [('egg', 3), ('zucchini', 0.3), ('spinach', 30), ('capsicum', 0.3), ('feta', 25), ('salad leaves', 40), ('oil', 5)],
     ['Heat the oven grill. Fry the chopped zucchini and capsicum in the oil in an ovenproof pan for 5 minutes, then add the spinach.',
      'Pour in the beaten eggs and crumble over the feta. Cook on low for 8 minutes.', 'Grill for 5 minutes until set and golden. Serve with salad.'],
     leftovers=True, texture=['soft'])
dish('Tuna pasta bake', 'dinner', 'Italian', 40, ['stovetop', 'oven'],
     [('tuna big', 90), ('pasta', 80), ('passata', 120), ('frozen peas', 50), ('corn', 40), ('mozzarella', 30)],
     ['Heat the oven to 200 °C. Cook the pasta for 2 minutes less than the packet says. Add the peas for the last 2 minutes.',
      'Drain and mix with the drained tuna, corn and passata in a baking dish.', 'Top with the cheese and bake for 15 minutes.'],
     leftovers=True, texture=['mixed'], batch=True)
dish('Pesto chicken pasta with greens', 'dinner', 'Italian', 25, ['stovetop'],
     [('chicken breast', 120), ('pasta', 85), ('pesto', 25), ('broccoli', 0.25), ('spinach', 30), ('oil', 3)],
     ['Cook the pasta, adding the broccoli for the last 3 minutes.', 'Fry the sliced chicken in the oil for 8 minutes until cooked.',
      'Drain the pasta, then toss with the chicken, pesto and spinach.'],
     leftovers=True)
dish('Minestrone soup with bread', 'dinner', 'Italian', 40, ['stovetop'],
     [('kidney beans', 60), ('canned tomatoes', 120), ('carrot', 50), ('celery', 0.1), ('onion', 40), ('zucchini', 0.3), ('pasta', 30), ('veg stock', 300), ('bread', 60), ('oil', 5)],
     ['Fry the chopped onion, carrot and celery in the oil for 6 minutes.', 'Add the tomatoes, stock, beans and zucchini and simmer for 15 minutes.',
      'Add the pasta and cook for 10 minutes more. Serve with bread.'],
     leftovers=True, texture=['mixed', 'soft'], batch=True)
dish('Slow-cooker beef and vegetable stew with mash', 'dinner', 'Australian', 30, ['slow cooker', 'stovetop'],
     [('beef steak', 140), ('carrot', 60), ('celery', 0.1), ('onion', 50), ('canned tomatoes', 100), ('stock', 100), ('potato', 200), ('milk', 20), ('butter', 5)],
     ['In the morning, put the diced beef, chopped vegetables, tomatoes and stock in the slow cooker. Cook on low for 8 hours.',
      'Boil the peeled potatoes for 15 minutes, then mash with the milk and butter.', 'Serve the stew on the mash.'],
     leftovers=True, texture=['mixed', 'soft'], batch=True)
dish('Shepherd’s pie', 'dinner', 'British', 50, ['stovetop', 'oven'],
     [('lamb mince', 120), ('frozen veg', 100), ('onion', 40), ('tomato paste', 15), ('stock', 80), ('potato', 220), ('milk', 20), ('butter', 5)],
     ['Heat the oven to 200 °C. Boil the peeled potatoes for 15 minutes and mash with the milk and butter.',
      'Brown the mince with the onion. Add the tomato paste, stock and frozen vegetables and simmer for 10 minutes.',
      'Put the mince in a baking dish, top with the mash and bake for 20 minutes.'],
     leftovers=True, texture=['mixed', 'soft'], batch=True)
dish('Sausages with mash and vegetables', 'dinner', 'Australian', 30, ['stovetop'],
     [('beef sausages', 130), ('potato', 220), ('frozen peas', 60), ('carrot', 60), ('milk', 20), ('butter', 5)],
     ['Boil the peeled potatoes for 15 minutes, then mash with the milk and butter.', 'Cook the sausages in a pan for 12 to 15 minutes, turning.',
      'Steam the carrots and peas. Serve together.'],
     separate=True, kid='Same, cut up.')
dish('Egg fried rice with vegetables', 'dinner', 'Chinese', 20, ['stovetop'],
     [('rice', 80), ('egg', 2), ('frozen veg', 120), ('spring onion', 0.1), ('soy sauce', 12), ('oil', 7)],
     ['Cook the rice (or use cold leftover rice).', 'Scramble the eggs in a hot pan with half the oil, then set aside.',
      'Stir-fry the frozen vegetables in the rest of the oil for 4 minutes. Add the rice and fry for 3 minutes.', 'Stir in the eggs, soy sauce and sliced spring onion.'],
     leftovers=True, texture=['mixed'])
dish('Teriyaki chicken rice bowls', 'dinner', 'Japanese', 25, ['stovetop'],
     [('chicken thigh', 140), ('teriyaki', 25), ('rice', 75), ('edamame', 50), ('carrot', 40), ('cucumber', 0.3)],
     ['Cook the rice. Boil the edamame for 3 minutes.', 'Fry the diced chicken for 8 minutes, then add the teriyaki sauce and cook 2 minutes until sticky.',
      'Serve on the rice with grated carrot, sliced cucumber and the edamame in separate piles.'],
     separate=True, leftovers=True)
dish('Teriyaki salmon with rice and greens', 'dinner', 'Japanese', 25, ['stovetop'],
     [('salmon', 125), ('teriyaki', 20), ('rice', 70), ('broccoli', 0.3), ('green beans', 50)],
     ['Cook the rice. Steam the broccoli and beans.', 'Fry the salmon skin-side down for 4 minutes, turn and cook 3 minutes more.',
      'Add the teriyaki sauce for the last minute. Serve with the rice and greens.'],
     separate=True)
dish('Korean-style beef mince rice bowls', 'dinner', 'Korean', 20, ['stovetop'],
     [('beef mince', 120), ('soy sauce', 15), ('honey', 6), ('garlic', 0.1), ('ginger', 3), ('sesame oil', 3), ('rice', 75), ('coleslaw mix', 60), ('cucumber', 0.3)],
     ['Cook the rice.', 'Brown the mince. Add the garlic, ginger, soy sauce, honey and sesame oil and cook for 3 minutes.',
      'Serve on the rice with the coleslaw mix and sliced cucumber.'],
     separate=True, leftovers=True)
dish('Thai green chicken curry with rice', 'dinner', 'Thai', 30, ['stovetop'],
     [('chicken thigh', 130), ('curry paste', 15), ('coconut milk', 90), ('green beans', 60), ('capsicum', 0.3), ('rice', 75), ('fish sauce', 5)],
     ['Cook the rice.', 'Fry the curry paste in a pan for 1 minute, add the diced chicken and cook for 5 minutes.',
      'Add the coconut milk, beans and capsicum. Simmer for 10 minutes. Add the fish sauce.', 'Serve on the rice.'],
     leftovers=True, texture=['mixed'], spicy=True)
dish('Vietnamese chicken noodle salad', 'dinner', 'Vietnamese', 25, ['stovetop'],
     [('chicken breast', 120), ('rice noodles', 60), ('carrot', 50), ('cucumber', 0.4), ('lettuce', 0.1), ('fish sauce', 8), ('lemon', 0.2), ('honey', 4)],
     ['Soak the noodles in boiling water for 5 minutes, then rinse in cold water.', 'Cook the chicken in a pan for 10 minutes, then slice.',
      'Mix the fish sauce, lemon juice and honey for a dressing.', 'Serve the noodles, chicken and vegetables with the dressing.'],
     separate=True)
dish('Pork san choy bow', 'dinner', 'Chinese', 20, ['stovetop'],
     [('pork mince', 120), ('lettuce', 0.2), ('carrot', 40), ('spring onion', 0.1), ('soy sauce', 12), ('garlic', 0.1), ('ginger', 3), ('rice', 50), ('oil', 3)],
     ['Cook the rice.', 'Brown the mince in the oil with the garlic and ginger.', 'Add the grated carrot, sliced spring onion and soy sauce and cook 3 minutes.',
      'Spoon into lettuce cups and serve with the rice.'],
     texture=['crunchy'])
dish('Wrap pizzas with ham and vegetables', 'dinner', 'Italian', 20, ['oven'],
     [('wraps', 2), ('passata', 40), ('ham', 40), ('mozzarella', 40), ('capsicum', 0.3), ('mushrooms', 30), ('salad leaves', 30)],
     ['Heat the oven to 220 °C. Spread the wraps with passata.', 'Top with ham, sliced capsicum and mushrooms, and the cheese.',
      'Bake on trays for 8 to 10 minutes until crisp. Serve with salad.'],
     kid='Cheese and ham only.')
dish('Black bean burrito bowls', 'dinner', 'Mexican', 20, ['stovetop'],
     [('black beans', 120), ('rice', 70), ('corn', 60), ('tomato', 0.5), ('avocado', 0.3), ('lettuce', 0.1), ('taco seasoning', 4), ('lemon', 0.2)],
     ['Cook the rice.', 'Warm the drained beans with the seasoning and a splash of water for 5 minutes.',
      'Serve the rice, beans, corn, diced tomato, avocado and lettuce in a bowl with a squeeze of lemon.'],
     separate=True, spicy=True)
dish('Chicken and vegetable soup', 'dinner', 'Australian', 40, ['stovetop'],
     [('chicken breast', 110), ('carrot', 60), ('celery', 0.1), ('onion', 40), ('potato', 100), ('stock', 350), ('pasta', 25), ('bread', 40)],
     ['Simmer the chicken in the stock for 15 minutes, then take it out and shred it.',
      'Add the chopped vegetables and pasta to the stock and simmer for 15 minutes.', 'Return the chicken and serve with bread.'],
     leftovers=True, texture=['soft'], batch=True)
dish('Oven fish and chips with salad', 'dinner', 'British', 30, ['oven'],
     [('crumbed fish', 140), ('potato', 220), ('salad leaves', 40), ('tomato', 0.4), ('lemon', 0.2), ('oil', 5)],
     ['Heat the oven to 220 °C. Cut the potatoes into wedges, toss with the oil and bake for 30 minutes.',
      'Bake the fish for the last 15 to 18 minutes (check the packet).', 'Serve with salad and lemon.'],
     separate=True, texture=['crunchy'])
dish('Steak with jacket potato and salad', 'dinner', 'Australian', 60, ['oven', 'stovetop'],
     [('beef steak', 150), ('potato', 250), ('sour cream', 20), ('salad leaves', 40), ('tomato', 0.4), ('cucumber', 0.3), ('oil', 3)],
     ['Bake the potatoes at 200 °C for about 50 minutes (or microwave for 8 to 10 minutes).',
      'Cook the steak in a hot pan, 3 to 4 minutes each side. Rest it for 5 minutes.', 'Serve with the potato, sour cream and salad.'],
     separate=True)
dish('Tofu and vegetable noodle stir-fry', 'dinner', 'Chinese', 25, ['stovetop'],
     [('tofu', 130), ('rice noodles', 70), ('stir-fry veg', 180), ('soy sauce', 15), ('garlic', 0.1), ('ginger', 3), ('oil', 7)],
     ['Cook the noodles. Cut the tofu into cubes and pat dry.', 'Fry the tofu in the oil until golden, then set aside.',
      'Stir-fry the vegetables with the garlic and ginger for 4 minutes.', 'Add the noodles, tofu and soy sauce and toss.'],
     texture=['mixed'])
dish('Halloumi and roast vegetable couscous', 'dinner', 'Middle Eastern', 40, ['oven', 'stovetop'],
     [('halloumi', 60), ('pumpkin', 120), ('zucchini', 0.4), ('capsicum', 0.4), ('chickpeas', 60), ('couscous', 60), ('spinach', 20), ('oil', 7)],
     ['Heat the oven to 200 °C. Roast the chopped pumpkin, zucchini, capsicum and drained chickpeas with the oil for 25 minutes.',
      'Pour boiling water over the couscous, cover for 5 minutes, then fluff.', 'Fry the sliced halloumi for 2 minutes each side.',
      'Mix the vegetables and spinach through the couscous and top with the halloumi.'],
     separate=True)
dish('Homemade beef burgers with salad', 'dinner', 'Australian', 25, ['stovetop'],
     [('beef mince', 130), ('rolls', 1), ('cheddar', 20), ('lettuce', 0.1), ('tomato', 0.5), ('bbq sauce', 10), ('oil', 3)],
     ['Shape the mince into patties with salt and pepper.', 'Fry for 4 to 5 minutes each side until cooked through.',
      'Fill the rolls with the patties, cheese, lettuce, tomato and sauce.'],
     separate=True)
dish('Baked potatoes with beans and cheese', 'dinner', 'British', 20, ['microwave'],
     [('potato', 280), ('baked beans', 150), ('cheddar', 25), ('salad leaves', 30)],
     ['Prick the potatoes and microwave for 8 to 12 minutes until soft (or bake at 200 °C for 50 minutes).',
      'Warm the beans. Split the potatoes, top with the beans and grated cheese.', 'Serve with salad.'],
     texture=['soft'])
dish('Chicken burrito bowls', 'dinner', 'Mexican', 25, ['stovetop'],
     [('chicken breast', 130), ('rice', 70), ('black beans', 60), ('corn', 50), ('tomato', 0.4), ('lettuce', 0.1), ('taco seasoning', 5), ('sour cream', 20)],
     ['Cook the rice.', 'Toss the sliced chicken with the seasoning and fry for 8 minutes.', 'Warm the beans.',
      'Serve everything in bowls with the corn, tomato, lettuce and sour cream.'],
     separate=True, spicy=True, leftovers=True)
dish('Pumpkin and ricotta pasta', 'dinner', 'Italian', 30, ['stovetop', 'microwave'],
     [('pumpkin', 150), ('ricotta', 50), ('pasta', 85), ('spinach', 30), ('cheddar', 10), ('garlic', 0.07), ('oil', 5)],
     ['Microwave the diced pumpkin with a splash of water for 8 minutes until soft.', 'Cook the pasta.',
      'Fry the garlic in the oil, add the pumpkin and mash roughly. Stir in the ricotta and a little pasta water.',
      'Toss with the pasta and spinach, and top with cheese.'],
     texture=['soft'], leftovers=True)

# --- breakfasts ---
dish('Overnight oats with berries', 'breakfast', 'Australian', 5, [],
     [('oats', 50), ('milk', 150), ('greek yoghurt', 50), ('frozen berries', 70)],
     ['The night before, mix the oats, milk and yoghurt in a jar or bowl.', 'Top with the berries and leave in the fridge overnight.'],
     texture=['soft'])
dish('Porridge with banana', 'breakfast', 'Australian', 8, ['microwave'],
     [('oats', 50), ('milk', 200), ('banana', 60), ('honey', 5)],
     ['Microwave the oats and milk for 2 to 3 minutes, stirring halfway.', 'Top with sliced banana and a little honey.'],
     texture=['soft'])
dish('Weet-Bix with milk and fruit', 'breakfast', 'Australian', 3, [],
     [('weet-bix', 34), ('milk', 200), ('banana', 60)],
     ['Two Weet-Bix in a bowl with milk and sliced banana.'])
dish('Eggs on toast', 'breakfast', 'Australian', 10, ['stovetop'],
     [('egg', 2), ('bread', 70), ('butter', 5), ('tomato', 0.5)],
     ['Scramble, poach or fry the eggs.', 'Serve on buttered toast with sliced tomato.'], separate=True)
dish('Yoghurt with muesli and fruit', 'breakfast', 'Australian', 3, [],
     [('greek yoghurt', 150), ('muesli', 40), ('frozen berries', 60)],
     ['Spoon the yoghurt into a bowl and top with the muesli and berries.'])
dish('Avocado and tomato toast', 'breakfast', 'Australian', 5, [],
     [('bread', 70), ('avocado', 0.4), ('tomato', 0.5), ('lemon', 0.1)],
     ['Toast the bread, mash the avocado on top with a squeeze of lemon, and add sliced tomato.'])
dish('Baked beans on toast', 'breakfast', 'British', 5, ['microwave'],
     [('baked beans', 150), ('bread', 70), ('butter', 5)],
     ['Warm the beans and serve on buttered toast.'], texture=['soft'])
dish('Vegemite toast and fruit', 'breakfast', 'Australian', 3, [],
     [('bread', 70), ('butter', 5), ('vegemite', 4), ('apple', 150)],
     ['Toast with butter and a thin scrape of Vegemite, with an apple.'], separate=True)
dish('Peanut butter toast', 'breakfast', 'Australian', 3, [],
     [('bread', 70), ('peanut butter', 20), ('apple', 150)],
     ['Toast spread with peanut butter, with an apple on the side.'], separate=True)
dish('Scrambled egg and cheese wrap', 'breakfast', 'Australian', 8, ['stovetop'],
     [('egg', 2), ('wraps', 1), ('cheddar', 15), ('spinach', 15)],
     ['Scramble the eggs, then roll them in a wrap with the cheese and spinach.'])

# --- lunches ---
dish('Chicken salad wrap', 'lunch', 'Australian', 10, ['stovetop'],
     [('chicken breast', 90), ('wraps', 1), ('lettuce', 0.1), ('tomato', 0.4), ('cheddar', 15), ('mayonnaise', 10)],
     ['Cook a chicken breast (or use leftover chicken) and slice it.', 'Fill a wrap with the chicken, lettuce, tomato, cheese and a little mayonnaise.'],
     packable=True)
dish('Tuna and salad sandwich', 'lunch', 'Australian', 5, [],
     [('tuna', 95), ('bread', 70), ('lettuce', 0.08), ('tomato', 0.4), ('mayonnaise', 10)],
     ['Mix the tuna with the mayonnaise. Make a sandwich with the lettuce and tomato.'], packable=True)
dish('Ham, cheese and salad sandwich', 'lunch', 'Australian', 5, [],
     [('ham', 50), ('bread', 70), ('cheddar', 20), ('lettuce', 0.08), ('tomato', 0.4)],
     ['Make a sandwich with ham, cheese, lettuce and tomato.'], packable=True)
dish('Egg and lettuce sandwich', 'lunch', 'Australian', 15, ['stovetop'],
     [('egg', 2), ('bread', 70), ('lettuce', 0.08), ('mayonnaise', 10)],
     ['Hard-boil the eggs for 9 minutes, cool, peel and mash with the mayonnaise.', 'Make a sandwich with the lettuce.'],
     packable=True, texture=['soft'])
dish('Hummus and vegetable wrap', 'lunch', 'Middle Eastern', 5, [],
     [('hummus', 40), ('wraps', 1), ('carrot', 50), ('cucumber', 0.3), ('salad leaves', 20), ('chickpeas', 50)],
     ['Spread the wrap with hummus and fill with grated carrot, cucumber, leaves and chickpeas.'], packable=True)
dish('Tuna pasta salad', 'lunch', 'Italian', 15, ['stovetop'],
     [('tuna', 95), ('pasta', 60), ('corn', 40), ('capsicum', 0.3), ('cucumber', 0.3), ('mayonnaise', 10)],
     ['Cook the pasta, rinse in cold water and mix with everything else. Keeps for 2 days in the fridge.'],
     packable=True, batch=True)
dish('Cheese, crackers and vegetable sticks', 'lunch', 'Australian', 5, [],
     [('cheddar', 40), ('crackers', 35), ('carrot', 60), ('cucumber', 0.4), ('apple', 150)],
     ['Cut the cheese, carrot and cucumber into sticks. Pack with crackers and an apple.'],
     packable=True, separate=True, texture=['crunchy'])
dish('Bean and cheese quesadilla', 'lunch', 'Mexican', 10, ['stovetop'],
     [('wraps', 2), ('black beans', 70), ('cheddar', 30), ('corn', 30), ('tomato', 0.4)],
     ['Fill a wrap with the beans, corn and cheese, top with another wrap and toast in a dry pan for 2 to 3 minutes each side.',
      'Serve with diced tomato.'])
dish('Pumpkin soup with bread', 'lunch', 'Australian', 35, ['stovetop', 'blender'],
     [('pumpkin', 250), ('onion', 40), ('veg stock', 200), ('cream', 15), ('bread', 50)],
     ['Simmer the chopped pumpkin and onion in the stock for 20 minutes.', 'Blend until smooth and stir in the cream. Serve with bread.'],
     texture=['soft'], batch=True)
dish('Chicken, rice and vegetable lunch box', 'lunch', 'Australian', 20, ['stovetop'],
     [('chicken breast', 100), ('rice', 50), ('frozen veg', 100), ('soy sauce', 8)],
     ['Cook the rice and chicken (or use leftovers). Steam the vegetables.', 'Pack in a container with a dash of soy sauce.'],
     packable=True, separate=True)

# --- snacks (amounts are for one person; not scaled by portion) ---
S = []


def snack(what, per, kind, kids=True):
    S.append(dict(what=what, per=per, kind=kind, kids=kids))


snack('170 g Greek yoghurt', [('greek yoghurt', 170)], 'protein')
snack('300 ml glass of milk', [('milk', 300)], 'protein')
snack('2 boiled eggs', [('egg', 2)], 'protein')
snack('100 g cottage cheese with an apple', [('cottage cheese', 100), ('apple', 150)], 'protein', kids=False)
snack('Tuna and crackers', [('tuna', 95), ('crackers', 20)], 'protein', kids=False)
snack('100 g edamame', [('edamame', 100)], 'protein')
snack('An apple', [('apple', 150)], 'fruit')
snack('A banana', [('banana', 120)], 'fruit')
snack('2 mandarins', [('mandarin', 150)], 'fruit')
snack('Carrot and cucumber sticks with hummus', [('carrot', 60), ('cucumber', 0.4), ('hummus', 30)], 'veg')
snack('Cheese and crackers', [('cheddar', 25), ('crackers', 20)], 'other')
snack('30 g almonds', [('almonds', 30)], 'other', kids=False)
snack('Rice crackers with peanut butter', [('rice crackers', 20), ('peanut butter', 15)], 'other')
snack('A slice of fruit bread', [('fruit bread', 40)], 'other')
snack('Yoghurt with berries', [('greek yoghurt', 100), ('frozen berries', 60)], 'protein')
snack('A cheese stick and an apple', [('cheddar', 20), ('apple', 150)], 'other')

# ---------------------------------------------------------------------------
# Exercise library
# ---------------------------------------------------------------------------
# Strength workouts by what someone can use. Each item: "Name (sets × reps): how to".
WORKOUTS = {
    'none': [
        ('Strength A', 'About 25 minutes', ['Warm-up (5 minutes): march on the spot and swing your arms',
                                            'Sit to stand (3 × 10): stand up from a chair and sit back down slowly',
                                            'Wall push-up (3 × 10): hands on the wall, lower your chest towards it',
                                            'Glute bridge (3 × 12): lie on your back, knees bent, lift your hips',
                                            'Bird dog (3 × 8 each side): on hands and knees, reach one arm and the opposite leg',
                                            'Cool-down (3 minutes): gentle stretches']),
        ('Strength B', 'About 25 minutes', ['Warm-up (5 minutes): march on the spot',
                                            'Step-up (3 × 8 each leg): onto the bottom stair, holding the rail',
                                            'Incline push-up (3 × 8): hands on a bench or kitchen bench',
                                            'Calf raise (3 × 15): hold something steady',
                                            'Dead bug (3 × 8 each side): lie on your back, slowly lower opposite arm and leg',
                                            'Cool-down (3 minutes): gentle stretches']),
    ],
    'bands': [
        ('Strength A', 'About 30 minutes', ['Warm-up (5 minutes): march on the spot and arm circles',
                                            'Squat to a chair (3 × 10): sit back until you touch the chair, then stand',
                                            'Band row (3 × 12): band around something sturdy, pull your elbows back',
                                            'Band chest press (3 × 10): band behind your back, push forward',
                                            'Glute bridge (3 × 12): band around your knees',
                                            'Cool-down (3 minutes): gentle stretches']),
        ('Strength B', 'About 30 minutes', ['Warm-up (5 minutes): march on the spot',
                                            'Reverse lunge (3 × 8 each leg): hold a chair for balance if needed',
                                            'Band pull-apart (3 × 12): arms straight, pull the band apart',
                                            'Band overhead press (3 × 10): stand on the band, press up',
                                            'Side plank on knees (3 × 20 seconds each side)',
                                            'Cool-down (3 minutes): gentle stretches']),
    ],
    'dumbbells': [
        ('Strength A', 'About 35 minutes', ['Warm-up (5 minutes): march on the spot and arm circles',
                                            'Goblet squat (3 × 10): hold one dumbbell at your chest',
                                            'One-arm dumbbell row (3 × 10 each side): hand on a bench',
                                            'Dumbbell floor press (3 × 10): lying on your back',
                                            'Romanian deadlift (3 × 10): soft knees, hinge at the hips',
                                            'Plank (3 × 20 to 30 seconds)',
                                            'Cool-down (3 minutes): gentle stretches']),
        ('Strength B', 'About 35 minutes', ['Warm-up (5 minutes): march on the spot',
                                            'Reverse lunge (3 × 8 each leg): dumbbells at your sides',
                                            'Dumbbell shoulder press (3 × 10): seated or standing',
                                            'Glute bridge (3 × 12): dumbbell on your hips',
                                            'Dumbbell curl (2 × 12)',
                                            'Dead bug (3 × 8 each side)',
                                            'Cool-down (3 minutes): gentle stretches']),
    ],
    'gym': [
        ('Strength A', 'About 45 minutes', ['Warm-up (5 minutes): bike or cross-trainer',
                                            'Leg press (3 × 10): feet shoulder-width apart',
                                            'Lat pulldown (3 × 10): pull the bar to your upper chest',
                                            'Chest press machine (3 × 10)',
                                            'Seated leg curl (3 × 12)',
                                            'Plank (3 × 30 seconds)',
                                            'Cool-down (5 minutes): easy bike and stretches']),
        ('Strength B', 'About 45 minutes', ['Warm-up (5 minutes): bike or cross-trainer',
                                            'Goblet squat (3 × 10): dumbbell at your chest',
                                            'Seated cable row (3 × 10)',
                                            'Shoulder press machine (3 × 10)',
                                            'Romanian deadlift (3 × 10): dumbbells, soft knees',
                                            'Cable woodchop (2 × 10 each side)',
                                            'Cool-down (5 minutes): easy bike and stretches']),
    ],
    'seated': [
        ('Strength A', 'About 20 minutes', ['Warm-up (5 minutes): seated arm circles and shoulder rolls',
                                            'Seated band row (3 × 12): band around a sturdy post',
                                            'Seated chest press (3 × 10): band behind your back, or a light weight',
                                            'Seated overhead press (3 × 10): light weights or water bottles',
                                            'Seated twist (2 × 8 each side): slow and controlled',
                                            'Cool-down (3 minutes): gentle neck and shoulder stretches']),
        ('Strength B', 'About 20 minutes', ['Warm-up (5 minutes): seated marching or arm swings',
                                            'Seated bicep curl (3 × 12): light weights or a band',
                                            'Seated lateral raise (3 × 10): light weights',
                                            'Seated leg lift (3 × 10 each, if you can): straighten one knee',
                                            'Breathing and posture (3 minutes): sit tall, slow breaths',
                                            'Cool-down (3 minutes): gentle stretches']),
    ],
}


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------

def load_fdc(folder):
    """{fdc id: (protein, carbs, fat, kcal, calcium mg)} per 100 g, for the ids used."""
    wanted = {str(v[1]) for v in I.values() if isinstance(v[1], int)}
    ids = {'1003': 0, '1005': 1, '1004': 2, '1008': 3, '1087': 4}
    out = {k: [0.0] * 5 for k in wanted}
    with open(os.path.join(folder, 'food_nutrient.csv'), newline='') as f:
        for r in csv.DictReader(f):
            if r['fdc_id'] in wanted and r['nutrient_id'] in ids:
                out[r['fdc_id']][ids[r['nutrient_id']]] = float(r['amount'] or 0)
    names = {}
    with open(os.path.join(folder, 'food.csv'), newline='') as f:
        for r in csv.DictReader(f):
            if r['fdc_id'] in wanted:
                names[r['fdc_id']] = r['description']
    missing = wanted - set(names)
    if missing:
        sys.exit('Not found in FoodData Central: ' + ', '.join(sorted(missing)))
    return out, names


SERVE = {'veg': 75, 'potato': 75, 'fruit': 150, 'grain': None, 'red': 90, 'processed': None, 'poultry': 100,
         'fish': 115, 'oily': 115, 'egg': 100, 'legume': 150, 'tofu': 170, 'nut': 30, 'dairy': None}
GRAIN_SERVE = {'bread': 40, 'wraps': 40, 'rolls': 40, 'pita': 40, 'fruit bread': 40, 'crackers': 35, 'rice crackers': 35,
               'oats': 30, 'weet-bix': 30, 'muesli': 30}
DAIRY_SERVE = {'milk': 250, 'greek yoghurt': 200, 'cottage cheese': 120, 'ricotta': 120}
OILY = {'salmon'}


def grams(key, amount):
    unit, each = I[key][3], I[key][8]
    return amount * each if unit == 'each' else amount


def build(folder):
    fdc, names = load_fdc(folder)
    ingredients = {}
    for key, (name, src, pack, unit, price, aisle, tags, kind, each) in I.items():
        if isinstance(src, int):
            p, c, f, kcal, ca = fdc[str(src)]
            source = 'FDC ' + str(src) + ': ' + names[str(src)]
        else:
            _, p, c, f, kcal, ca = src
            source = 'label (typical values)'
        ingredients[key] = dict(name=name, pack=pack, unit=unit, each=each, price=price, aisle=aisle, tags=tags, kind=kind,
                                per100=dict(p=p, c=c, f=f, kj=round(kcal * 4.184), ca=ca), source=source)

    def nutrition(per):
        m = dict(p=0.0, c=0.0, f=0.0, kj=0.0)
        g = dict(veg=0.0, fruit=0.0, grain=0.0, protein=0.0, dairy=0.0, fv=0.0, leg=0.0, red=0.0, fish=0.0, oily=0.0, side=0.0, gc=0.0, mp=0.0, ca=0.0)
        tags = set()
        for key, amount in per:
            if key not in I:
                sys.exit('Unknown ingredient: ' + key)
            ing = ingredients[key]
            w = grams(key, amount)
            n = ing['per100']
            for k in m:
                m[k] += n[k] * w / 100
            tags.update(ing['tags'])
            kind = ing['kind']
            if kind == 'veg':
                g['veg'] += w / 75; g['fv'] += w; g['side'] += w
            elif kind == 'potato':
                g['veg'] += w / 75; g['side'] += w
            elif kind == 'fruit':
                g['fruit'] += w / 150; g['fv'] += w
            elif kind == 'grain':
                g['grain'] += w / GRAIN_SERVE.get(key, 30); g['gc'] += n['c'] * w / 100
            elif kind in ('red', 'processed'):
                if kind == 'red':
                    g['protein'] += w / 90
                g['red'] += w * (0.7 if kind == 'red' else 0.85); g['mp'] += n['p'] * w / 100
            elif kind == 'poultry':
                g['protein'] += w / 100; g['mp'] += n['p'] * w / 100
            elif kind in ('fish', 'oily'):
                g['protein'] += w / 115; g['fish'] += w; g['mp'] += n['p'] * w / 100
                if kind == 'oily':
                    g['oily'] += w
            elif kind == 'egg':
                g['protein'] += w / 100; g['mp'] += n['p'] * w / 100
            elif kind == 'legume':
                g['protein'] += w / 150; g['leg'] += w; g['mp'] += n['p'] * w / 100
            elif kind == 'tofu':
                g['protein'] += w / 170; g['mp'] += n['p'] * w / 100
            elif kind == 'nut':
                g['protein'] += w / 30
            elif kind == 'dairy':
                g['dairy'] += w / DAIRY_SERVE.get(key, 40); g['ca'] += n['ca'] * w / 100
        macros = dict(p=round(m['p']), c=round(m['c']), f=round(m['f']), kj=round(m['kj'] / 10) * 10)
        groups = {k: round(v, 1) if k in ('veg', 'fruit', 'grain', 'protein', 'dairy') else round(v) for k, v in g.items() if v}
        return macros, groups, sorted(tags)

    dishes = []
    for d in D:
        macros, groups, tags = nutrition(d['per'])
        if d.get('spicy'):
            tags = sorted(set(tags) | {'spicy'})
        out = {k: v for k, v in d.items() if k not in ('spicy',)}
        out.update(macros=macros, groups=groups, tags=tags)
        out['cost'] = round(sum(ingredients[k]['price'] / ingredients[k]['pack'] * amount for k, amount in d['per'] if ingredients[k]['pack']), 2)
        dishes.append(out)
    snacks = []
    for s in S:
        macros, groups, tags = nutrition(s['per'])
        snacks.append(dict(s, macros=macros, groups=groups, tags=tags))
    workouts = {k: [dict(name=n, time=t, items=items) for n, t, items in v] for k, v in WORKOUTS.items()}
    return dict(
        about='Meal and exercise library for the built-in plan builder. Recipes written for this project. Nutrition from USDA FoodData Central '
              '(SR Legacy, public domain CC0 1.0: U.S. Department of Agriculture, Agricultural Research Service, FoodData Central, 2019, fdc.nal.usda.gov), '
              'except items marked "label". Prices are rough Coles estimates in AUD. Rebuild with tools/build_library.py.',
        ingredients=ingredients, dishes=dishes, snacks=snacks, workouts=workouts)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    lib = build(sys.argv[1])
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, '..', 'api', 'library.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(lib, f, indent=1, ensure_ascii=False)
        f.write('\n')
    by = {}
    for d in lib['dishes']:
        by.setdefault(d['meal'], []).append(d)
    for meal, ds in by.items():
        print(meal, len(ds))
        for d in ds:
            m = d['macros']
            print('  %-48s %4d kJ  p%3d c%3d f%3d  $%5.2f/serve  %s' % (d['name'][:48], m['kj'], m['p'], m['c'], m['f'], d['cost'], ','.join(d['tags'])))
    print('snacks', len(lib['snacks']))
    for s in lib['snacks']:
        m = s['macros']
        print('  %-48s %4d kJ  p%3d c%3d f%3d' % (s['what'], m['kj'], m['p'], m['c'], m['f']))
    print('wrote', os.path.normpath(out))


if __name__ == '__main__':
    main()
