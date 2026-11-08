// Builds the "Health sync" Apple Shortcut as a file, ready to sign on a Mac.
//
// The shortcut reads today's steps, Move (active energy), weight and food totals from Apple Health
// and posts them to this server's /auth/health-sync. It asks for the person's sync key when it is
// added, so one signed file works for everyone in the family.
//
// iPhones only open signed shortcut files, and only a Mac signed into iCloud can sign one:
//   shortcuts sign --mode anyone --input "Health sync (unsigned).shortcut" --output "Health sync.shortcut"
const crypto = require('crypto');

// ---------- a small XML property list writer ----------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(v, pad = '') {
  if (v === true) return pad + '<true/>';
  if (v === false) return pad + '<false/>';
  if (typeof v === 'number') return pad + (Number.isInteger(v) ? '<integer>' + v + '</integer>' : '<real>' + v + '</real>');
  if (typeof v === 'string') return pad + '<string>' + esc(v) + '</string>';
  if (Array.isArray(v)) return pad + '<array>\n' + v.map(x => plist(x, pad + '\t')).join('\n') + '\n' + pad + '</array>';
  return pad + '<dict>\n' + Object.keys(v).map(k => pad + '\t<key>' + esc(k) + '</key>\n' + plist(v[k], pad + '\t')).join('\n') + '\n' + pad + '</dict>';
}

// ---------- shortcut building blocks ----------

const uuid = () => crypto.randomUUID().toUpperCase();
const action = (id, params) => ({ WFWorkflowActionIdentifier: 'is.workflow.actions.' + id, WFWorkflowActionParameters: params });

// A reference to an earlier action's output ("magic variable").
const out = (uid, name) => ({ Type: 'ActionOutput', OutputUUID: uid, OutputName: name });
const attachment = ref => ({ Value: ref, WFSerializationType: 'WFTextTokenAttachment' });

// Text with variables in it: tokens(['Bearer ', ref]).
function tokens(parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const p of parts) {
    if (typeof p === 'string') string += p;
    else {
      attachmentsByRange['{' + string.length + ', 1}'] = p;
      string += '￼';
    }
  }
  return { Value: { string, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' };
}

// One key/value row in a dictionary (headers or the JSON body). Every value is sent as text:
// the server reads numbers out of text, and keeps units like "kcal" that tell it what was sent.
const row = (key, parts) => ({ WFItemType: 0, WFKey: tokens([key]), WFValue: tokens(parts) });
const dict = rows => ({ Value: { WFDictionaryFieldValueItems: rows }, WFSerializationType: 'WFDictionaryFieldValue' });

// Find Health Samples of one type that started today.
function findToday(type, latestOnly) {
  const uid = uuid();
  const params = {
    UUID: uid,
    WFContentItemFilter: {
      Value: {
        WFActionParameterFilterPrefix: 1,
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterTemplates: [
          { Property: 'Type', Operator: 4, Removable: false,
            Values: { Unit: 4, Enumeration: { Value: type, WFSerializationType: 'WFStringSubstitutableState' } } },
          { Property: 'Start Date', Operator: 1002, Removable: true, Values: { Unit: 4 } },
        ],
      },
      WFSerializationType: 'WFContentPredicateTableTemplate',
    },
  };
  if (latestOnly) Object.assign(params, { WFContentItemSortProperty: 'Start Date', WFContentItemSortOrder: 'Latest First', WFContentItemLimitEnabled: true, WFContentItemLimitNumber: 1 });
  return { uid, act: action('filter.health.quantity', params) };
}

// Find today's samples of a type and add them up. Returns the actions and a reference to the total.
function sumToday(type) {
  const find = findToday(type);
  const uid = uuid();
  return {
    acts: [find.act, action('statistics', { UUID: uid, WFStatisticsOperation: 'Sum', Input: attachment(out(find.uid, 'Health Samples')) })],
    ref: out(uid, 'Statistics'),
  };
}

// ---------- the Health sync shortcut ----------

function build(syncUrl) {
  const acts = [];
  const keyUid = uuid();
  acts.push(action('gettext', { UUID: keyUid, WFTextActionText: '' }));
  const unitUid = uuid();
  acts.push(action('gettext', { UUID: unitUid, WFTextActionText: 'kJ' }));

  const steps = sumToday('Steps');
  const move = sumToday('Active Energy');
  const weight = findToday('Weight', true);
  const food = sumToday('Dietary Energy');
  const protein = sumToday('Protein');
  const carbs = sumToday('Carbohydrates');
  const fat = sumToday('Total Fat');
  acts.push(...steps.acts, ...move.acts, weight.act, ...food.acts, ...protein.acts, ...carbs.acts, ...fat.acts);

  const dayUid = uuid();
  acts.push(action('format.date', {
    UUID: dayUid, WFDateFormatStyle: 'Custom', WFDateFormat: 'yyyy-MM-dd',
    WFDate: tokens([{ Type: 'CurrentDate' }]),
  }));

  const postUid = uuid();
  acts.push(action('downloadurl', {
    UUID: postUid,
    WFURL: syncUrl,
    WFHTTPMethod: 'POST',
    ShowHeaders: true,
    WFHTTPHeaders: dict([row('Authorization', ['Bearer ', out(keyUid, 'Text')])]),
    WFHTTPBodyType: 'JSON',
    WFJSONValues: dict([
      row('date', [out(dayUid, 'Formatted Date')]),
      row('steps', [steps.ref]),
      row('active_energy', [move.ref]),
      row('energy_unit', [out(unitUid, 'Text')]),
      row('weight', [out(weight.uid, 'Health Samples')]),
      row('food_energy', [food.ref]),
      row('protein', [protein.ref]),
      row('carbs', [carbs.ref]),
      row('fat', [fat.ref]),
    ]),
  }));

  const msgUid = uuid();
  acts.push(action('getvalueforkey', { UUID: msgUid, WFDictionaryKey: 'message', WFInput: attachment(out(postUid, 'Contents of URL')) }));
  acts.push(action('notification', { WFNotificationActionTitle: 'Health sync', WFNotificationActionBody: tokens([out(msgUid, 'Dictionary Value')]) }));

  const shortcut = {
    WFWorkflowClientVersion: '2607.0.2',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4271458815, WFWorkflowIconGlyphNumber: 59446 },
    WFWorkflowTypes: [],
    WFWorkflowInputContentItemClasses: [],
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowImportQuestions: [{
      ActionIndex: 0, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: '',
      Text: 'Paste your sync key from the Health sync page (it starts with fhp_).',
    }, {
      ActionIndex: 1, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: 'kJ',
      Text: 'Does your Health app show energy in kJ or kcal (Calories)? Type kJ or kcal.',
    }],
    WFWorkflowActions: acts,
  };
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n' + plist(shortcut) + '\n</plist>\n';
}

module.exports = { build };
