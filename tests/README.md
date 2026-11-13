# Tests

Automated checks that the app still works after a change. Run them all with:

    tools/test.sh

They run in a throwaway Node.js container (so you don't need Node installed) and take a few
seconds. Each line shows ✔ (passed) or ✖ (failed, with what went wrong underneath). GitHub also
runs them on every pull request (`.github/workflows/tests.yml`).

The tests never touch your family's data. `server.test.js` starts its own copy of the server with
an empty data folder in a temporary folder, and deletes it afterwards.

| File | What it checks |
| --- | --- |
| `server.test.js` | The server end to end: the first account, logins, the wrong-password limit, safe redirects, About me, building and approving a plan, ticks. |
| `planbuilder.test.js` | The built-in plan builder: allergies, diets, children's portions, vegetable and fruit targets, exercise for injuries and pregnancy, every country's prices. |
| `currentfood.test.js` | The Current food lists: an older kitchen list is sorted into places; spices and the fruit bowl have their own lists. (Photo links and clearing are in `server.test.js`.) |
| `themetoggle.test.js` | The light or dark button at the top of the page: it is added, swaps the look, and remembers the choice. |
| `names.test.js` | People's keys are the same in the browser and on the server. |
| `requests.test.js` | Reading what a page sent and sending a reply (`api/requests.js`): empty, too big, not JSON, and accented letters split across pieces. |
| `parts.test.js` | Calendar times, reading Apple Health zips, the meal library, countries and prices, the vegetable and fruit targets, and the wording rules for health text. |

`fixtures/` holds small made-up files the tests read.

## Adding a test

Tests use Node's built-in test runner (`node:test`), so there's nothing to install. A test is a
name and a function that checks things with `assert`:

```js
test('a vegetarian household gets no meat', () => {
  const plan = build([{ age: 35, diet: ['Vegetarian'] }]);
  assert.ok(!tagsUsed(plan).has('meat'));
});
```

When you fix a bug, add a test that would have caught it, so it can't quietly come back.
