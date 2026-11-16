import test from 'node:test';
import assert from 'node:assert/strict';
import { children, innerOf, parseXml, rawOf, textOf } from '../src/xml.mjs';

test('parses nested elements, attributes and decoded entities', () => {
  const root = parseXml('<a x="1&amp;2"><b>hi &lt;there&gt;</b><c d=\'e&apos;f\'/></a>');
  assert.equal(root.name, 'a');
  assert.equal(root.attributes.x, '1&2');
  const [b, c] = children(root);
  assert.equal(textOf(b), 'hi <there>');
  assert.equal(c.attributes.d, "e'f");
  assert.equal(c.innerStart, c.innerEnd);
});

test('preserves raw spans so unsupported nodes can be retained verbatim', () => {
  const source = '<root><acme:widget rows="3"> x </acme:widget></root>';
  const root = parseXml(source);
  const widget = children(root)[0];
  assert.equal(widget.local, 'widget');
  assert.equal(rawOf(source, widget), '<acme:widget rows="3"> x </acme:widget>');
  assert.equal(innerOf(source, widget), ' x ');
});

test('handles comments, cdata and processing instructions', () => {
  const root = parseXml('<?xml version="1.0"?><!-- note --><r><![CDATA[a<b]]><?pi v?></r>');
  assert.equal(root.name, 'r');
  assert.equal(textOf(root), 'a<b');
});

test('rejects external definitions, mismatched tags and trailing content', () => {
  assert.throws(() => parseXml('<!DOCTYPE x><x/>'), /external definitions/);
  assert.throws(() => parseXml('<a><b></a></b>'), /mismatched closing tag/);
  assert.throws(() => parseXml('<a/><b/>'), /content after root/);
  assert.throws(() => parseXml('<a>'), /unclosed element/);
  assert.throws(() => parseXml(''), /empty document/);
});
