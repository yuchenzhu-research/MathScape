'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../i18n.js');

function placeholders(message) {
  return Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
}

test('all nine languages have a complete dictionary with matching placeholders', () => {
  assert.equal(I.languages.length, 9);
  const keys = Object.keys(I.messages.en).sort();
  for (const language of I.languages) {
    assert.deepEqual(Object.keys(I.messages[language.id]).sort(), keys, language.id);
    const translator = I.create(language.id);
    for (const key of keys) {
      const message = I.messages[language.id][key];
      assert.equal(typeof message, 'string', language.id + ':' + key);
      assert.ok(message.trim(), language.id + ':' + key);
      assert.deepEqual(placeholders(message), placeholders(I.messages.en[key]), language.id + ':' + key);
      const values = Object.fromEntries(placeholders(message).map((name) => [name, 123]));
      assert.ok(!/\{\w+\}/.test(translator.t(key, values)), language.id + ':' + key);
    }
  }
});

test('every static page translation key is defined in every language', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const keys = Array.from(html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g), (match) => match[1]);
  assert.ok(keys.length > 65);
  for (const language of I.languages) {
    for (const key of keys) assert.equal(typeof I.messages[language.id][key], 'string', language.id + ':' + key);
  }
});

test('Chinese selected-language branding, header, language choices and themes are translated', () => {
  for (const id of ['zh-Hant', 'zh-Hans']) {
    const translator = I.create(id);
    const keys = ['brand', 'pageTitle', 'topic', 'footer', 'privacy', 'eyebrow', 'samplingEyebrow', 'compareEyebrow',
      'computeAuto', 'computeCpu', 'computeGpu', 'themeAuto', 'themeLight', 'themeDark', 'lessonBadge'];
    keys.push(...I.languages.map((language) => 'language_' + language.id));
    for (const key of keys) assert.ok(!/[A-Za-z]{2,}/.test(translator.t(key)), id + ':' + key);
  }
});

test('locale formatting and pluralization use the selected language', () => {
  const spanish = I.create('es');
  assert.equal(spanish.locale, 'es-ES');
  assert.equal(spanish.number(12345.67, 2), '12.345,67');
  assert.equal(spanish.quantity('roll', 1), '1 lanzamiento');
  assert.equal(spanish.quantity('roll', 2), '2 lanzamientos');
  const traditional = I.create('zh-Hant');
  assert.equal(traditional.quantity('group', 1), '1 組');
  assert.equal(traditional.quantity('group', 2), '2 組');
  traditional.setLanguage('ja', false);
  assert.equal(traditional.number(null), '—');
  assert.equal(traditional.quantity('group', 2), '2組');
});

test('language resolution recognizes scripts and regional tags', () => {
  assert.equal(I.resolveLanguage('zh-TW'), 'zh-Hant');
  assert.equal(I.resolveLanguage('zh-HK'), 'zh-Hant');
  assert.equal(I.resolveLanguage('zh-Hant'), 'zh-Hant');
  assert.equal(I.resolveLanguage('zh-CN'), 'zh-Hans');
  assert.equal(I.resolveLanguage('pt-BR'), 'pt');
  assert.equal(I.resolveLanguage('es-MX'), 'es');
  assert.equal(I.resolveLanguage('de-DE'), 'de');
  assert.equal(I.resolveLanguage('unknown'), 'en');
});

test('missing translations fail visibly instead of silently falling back to English', () => {
  const translator = I.create('zh-Hant');
  assert.throws(() => translator.t('missing-key'), /Unknown translation key/);
  assert.throws(() => translator.setLanguage('unknown', false), RangeError);
});

test('lesson copy separates model assumptions from pseudorandom implementation and exposes setup timing', () => {
  const english = I.create('en');
  assert.equal(english.t('groupTitle', { n: 1 }), 'Group size: 1');
  assert.ok(english.t('lessonFixed').includes('model assumes independent'));
  assert.ok(english.t('lessonFixed').includes('pseudorandom sampling'));
  assert.equal(english.t('compareSubtitle'), 'Equal group counts, separate random streams');
  assert.ok(I.create('zh-Hant').t('lessonFixed').includes('偽隨機抽樣'));
  for (const language of I.languages) {
    assert.ok(I.create(language.id).t('timingPreparation', { preparation: '0.50' }).includes('0.50'));
  }
});

test('the page app routes canvas labels, status and tooltip through localization', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!/\p{Script=Han}/u.test(app));
  assert.ok(!/new Worker\(/.test(app), 'app should not own a second compute implementation');
  assert.ok(app.includes('ProbabilityCompute.create'));
  assert.ok(app.includes("t('tooltip'"));
  assert.ok(app.includes("t('relativeFrequency')"));
  assert.ok(app.includes('snapshot.latestGroup'));
});
