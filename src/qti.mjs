import { children, innerOf, parseXml, rawOf, textOf } from './xml.mjs';

// QTI3 named subset interpretation. Only content and declarations are
// collected; response processing is retained as declared, never executed.
// Unknown interactions are preserved verbatim and flagged unparsed instead
// of being coerced into an ordinary choice interaction.

export function interpret(path, source) {
  if (!source.trim()) throw new Error('empty document');
  const root = parseXml(source);
  if (root.local === 'qti-assessment-test') return interpretTest(root);
  if (root.local === 'qti-assessment-item') return interpretItem(root, source);
  if (root.local === 'qti-assessment-stimulus') return interpretStimulus(root, source);
  return { kind: 'unknown', root: root.local };
}

function interpretTest(root) {
  const identifier = root.attributes.identifier;
  if (!identifier) throw new Error('assessment test without identifier');
  const parts = children(root, 'qti-test-part').map(part => ({
    identifier: part.attributes.identifier ?? null,
    sections: children(part, 'qti-assessment-section').map(section => ({
      identifier: section.attributes.identifier ?? null,
      title: section.attributes.title ?? null,
      visible: section.attributes.visible === 'true',
      refs: children(section, 'qti-assessment-item-ref').map(ref => {
        if (!ref.attributes.identifier) throw new Error(`item reference without identifier in test ${identifier}`);
        return { identifier: ref.attributes.identifier, href: ref.attributes.href ?? null };
      })
    }))
  }));
  return { kind: 'test', identifier, title: root.attributes.title ?? null, parts };
}

function interpretItem(root, source) {
  const identifier = root.attributes.identifier;
  if (!identifier) throw new Error('assessment item without identifier');
  const declarations = {};
  for (const declaration of children(root, 'qti-response-declaration')) {
    const id = declaration.attributes.identifier;
    if (!id) continue;
    const correctResponse = children(declaration, 'qti-correct-response')[0];
    declarations[id] = {
      cardinality: declaration.attributes.cardinality ?? null,
      baseType: declaration.attributes['base-type'] ?? null,
      correct: correctResponse ? children(correctResponse, 'qti-value').map(value => textOf(value).trim()) : []
    };
  }
  const outcomes = {};
  for (const declaration of children(root, 'qti-outcome-declaration')) {
    const id = declaration.attributes.identifier;
    if (!id) continue;
    outcomes[id] = {
      cardinality: declaration.attributes.cardinality ?? null,
      baseType: declaration.attributes['base-type'] ?? null
    };
  }
  const interactions = [];
  const unparsed = [];
  const stimulusRefs = [];
  const body = children(root, 'qti-item-body')[0];
  if (body) {
    for (const node of body.children) {
      if (node.type !== 'element') continue;
      if (node.local === 'qti-choice-interaction') {
        interactions.push({
          type: 'choice',
          responseIdentifier: node.attributes['response-identifier'] ?? null,
          maxChoices: node.attributes['max-choices'] === undefined ? null : Number(node.attributes['max-choices']),
          choices: children(node, 'qti-simple-choice').map(choice => ({
            identifier: choice.attributes.identifier ?? null,
            text: textOf(choice).trim()
          }))
        });
      } else if (node.local === 'qti-assessment-stimulus-ref') {
        stimulusRefs.push({ href: node.attributes.href ?? null });
      } else if (/interaction$/i.test(node.local) || node.attributes['response-identifier'] !== undefined) {
        unparsed.push({
          name: node.name,
          xml: rawOf(source, node),
          reason: 'unsupported interaction retained as declared'
        });
      }
    }
  }
  for (const processing of children(root, 'qti-response-processing')) {
    unparsed.push({
      name: processing.name,
      xml: rawOf(source, processing),
      reason: 'response processing declared, not executed'
    });
  }
  return {
    kind: 'item', identifier, title: root.attributes.title ?? null,
    declarations, outcomes, interactions, unparsed, stimulusRefs
  };
}

function interpretStimulus(root, source) {
  const identifier = root.attributes.identifier;
  if (!identifier) throw new Error('assessment stimulus without identifier');
  const body = children(root, 'qti-stimulus-body')[0];
  return {
    kind: 'stimulus', identifier,
    title: root.attributes.title ?? null,
    body: body ? innerOf(source, body).trim() : ''
  };
}

// Resource paths resolve relative to the referencing document. Absolute
// external URIs are reported, never followed.
export function resolvePath(fromPath, href) {
  if (typeof href !== 'string' || !href.trim()) return { missing: true };
  const target = href.split('#')[0].split('?')[0];
  if (!target) return { missing: true };
  if (/^[a-zA-Z][\w+.-]*:/.test(target)) return { external: href };
  const segments = target.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { path: segments.join('/') };
}
