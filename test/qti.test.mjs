import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret, resolvePath } from '../src/qti.mjs';

const TEST = '<qti-assessment-test identifier="t" title="T"><qti-test-part identifier="p"><qti-assessment-section identifier="s" title="S" visible="false"><qti-assessment-item-ref identifier="r1" href="items/a.xml"/><qti-assessment-item-ref identifier="r2" href="items/b.xml"/></qti-assessment-section></qti-test-part></qti-assessment-test>';
const ITEM = '<qti-assessment-item identifier="i" title="I"><qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>A</qti-value></qti-correct-response></qti-response-declaration><qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-simple-choice identifier="A">one</qti-simple-choice><qti-simple-choice identifier="B">two</qti-simple-choice></qti-choice-interaction><qti-assessment-stimulus-ref href="../s.xml"/></qti-item-body></qti-assessment-item>';
const CUSTOM = '<qti-assessment-item identifier="c"><qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string"/><qti-item-body><qti-custom-interaction response-identifier="RESPONSE"><acme:pad rows="3"/></qti-custom-interaction></qti-item-body><qti-response-processing template="x"/></qti-assessment-item>';

test('test interpretation keeps section structure and reference order', () => {
  const view = interpret('test.xml', TEST);
  assert.equal(view.kind, 'test');
  assert.equal(view.identifier, 't');
  const section = view.parts[0].sections[0];
  assert.equal(section.visible, false);
  assert.deepEqual(section.refs.map(ref => ref.identifier), ['r1', 'r2']);
});

test('item interpretation scopes declarations and choice interactions', () => {
  const view = interpret('items/i.xml', ITEM);
  assert.equal(view.kind, 'item');
  assert.deepEqual(view.declarations.RESPONSE.correct, ['A']);
  assert.equal(view.interactions[0].type, 'choice');
  assert.deepEqual(view.interactions[0].choices.map(choice => choice.identifier), ['A', 'B']);
  assert.deepEqual(view.stimulusRefs, [{ href: '../s.xml' }]);
});

test('custom interactions and response processing are retained unparsed', () => {
  const view = interpret('items/c.xml', CUSTOM);
  assert.equal(view.interactions.length, 0);
  const names = view.unparsed.map(entry => entry.name);
  assert.deepEqual(names, ['qti-custom-interaction', 'qti-response-processing']);
  assert.ok(view.unparsed[0].xml.includes('<acme:pad rows="3"/>'));
  assert.ok(view.unparsed[1].reason.includes('not executed'));
});

test('stimulus interpretation keeps the body and unknown roots are isolated', () => {
  const stimulus = interpret('s.xml', '<qti-assessment-stimulus identifier="s" title="S"><qti-stimulus-body><p>text</p></qti-stimulus-body></qti-assessment-stimulus>');
  assert.equal(stimulus.body, '<p>text</p>');
  assert.deepEqual(interpret('x.xml', '<wibble/>'), { kind: 'unknown', root: 'wibble' });
});

test('resolvePath handles relative, parent, root and external targets', () => {
  assert.deepEqual(resolvePath('test.xml', 'items/a.xml'), { path: 'items/a.xml' });
  assert.deepEqual(resolvePath('items/a.xml', '../s.xml'), { path: 's.xml' });
  assert.deepEqual(resolvePath('nested/deep/t.xml', '../../x.xml'), { path: 'x.xml' });
  assert.deepEqual(resolvePath('nested/t.xml', '/root.xml'), { path: 'root.xml' });
  assert.deepEqual(resolvePath('t.xml', './a.xml'), { path: 'a.xml' });
  assert.deepEqual(resolvePath('t.xml', 'https://example.invalid/x.xml'), { external: 'https://example.invalid/x.xml' });
  assert.deepEqual(resolvePath('t.xml', ''), { missing: true });
});
