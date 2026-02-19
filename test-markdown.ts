/**
 * Tests for renderMarkdown extracted from public/index.html
 * Run with: npx tsx test-markdown.ts
 */

// ---- Extracted functions from index.html ----

function escapeHtml(s: string): string {
  if (typeof s !== 'string') return String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineFormat(text: string): string {
  return escapeHtml(text)
    .replace(/&lt;br\s*\/?&gt;/g, '<br>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderTable(lines: string[]): string {
  const parseRow = (line: string) =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headers = parseRow(lines[0]);
  const rows = lines.slice(2)
    .filter(l => l.trim().startsWith('|'))
    .map(parseRow);

  let html = '<table><thead><tr>';
  for (const h of headers) html += `<th>${inlineFormat(h)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < headers.length; i++) {
      html += `<td>${inlineFormat(row[i] || '')}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderMarkdown(text: string): string {
  if (!text) return '';

  // First extract code blocks so they don't get processed
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Ensure headings always have a blank line before them
  text = text.replace(/([^\n#])(#{1,6} )/g, '$1\n\n$2');
  text = text.replace(/\n(#{1,6} )/g, '\n\n$1');

  // Split into blocks by double newline
  const blocks = text.split(/\n\n+/);
  const html: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Check for code block placeholder
    const cbMatch = trimmed.match(/^\x00CB(\d+)\x00$/);
    if (cbMatch) {
      html.push(codeBlocks[parseInt(cbMatch[1])]);
      continue;
    }

    // Skip bare heading markers
    if (/^#{1,6}\s*$/.test(trimmed)) continue;

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6}) (.+)$/m);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      const tag = `h${level}`;
      html.push(`<${tag}>${inlineFormat(headingMatch[2])}</${tag}>`);
      const afterHeading = trimmed.slice(headingMatch[0].length).trim();
      if (afterHeading) {
        html.push(`<p>${inlineFormat(afterHeading.replace(/\n/g, '<br>'))}</p>`);
      }
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) { html.push('<hr>'); continue; }

    // Table
    const lines = trimmed.split('\n');
    if (lines.length >= 2 && /^\|[\s-:|]+\|$/.test(lines[1]?.trim())) {
      html.push(renderTable(lines));
      continue;
    }

    // Unordered list
    if (/^[-*] /.test(trimmed)) {
      const items = trimmed.split('\n')
        .filter(l => /^[-*] /.test(l.trim()))
        .map(l => `<li>${inlineFormat(l.trim().replace(/^[-*] /, ''))}</li>`);
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(trimmed)) {
      const items = trimmed.split('\n')
        .filter(l => /^\d+\. /.test(l.trim()))
        .map(l => `<li>${inlineFormat(l.trim().replace(/^\d+\. /, ''))}</li>`);
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Default: paragraph
    html.push(`<p>${inlineFormat(trimmed.replace(/\n/g, '<br>'))}</p>`);
  }

  // Replace any remaining code block placeholders
  let result = html.join('\n');
  result = result.replace(/\x00CB(\d+)\x00/g, (_: string, idx: string) => codeBlocks[parseInt(idx)] || '');
  return result;
}

// ---- Test harness ----

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, input: string, check: (output: string) => boolean, expected?: string) {
  const output = renderMarkdown(input);
  const ok = check(output);
  if (ok) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    console.log(`    Input:    ${JSON.stringify(input)}`);
    console.log(`    Output:   ${JSON.stringify(output)}`);
    if (expected !== undefined) {
      console.log(`    Expected: ${JSON.stringify(expected)}`);
    }
    failed++;
    failures.push(name);
  }
}

function testExact(name: string, input: string, expected: string) {
  test(name, input, (out) => out === expected, expected);
}

function testContains(name: string, input: string, ...needles: string[]) {
  test(
    name,
    input,
    (out) => needles.every(n => out.includes(n)),
    `output should contain: ${needles.join(', ')}`
  );
}

function testNotContains(name: string, input: string, ...needles: string[]) {
  test(
    name,
    input,
    (out) => needles.every(n => !out.includes(n)),
    `output should NOT contain: ${needles.join(', ')}`
  );
}

// ---- Tests ----

console.log('\n=== renderMarkdown tests ===\n');

// 1. Empty/null input
console.log('--- Empty / null input ---');
testExact('empty string returns empty', '', '');
testExact('null returns empty', null as any, '');
testExact('undefined returns empty', undefined as any, '');

// 2. Headings not separated by newlines
console.log('\n--- Headings not separated by newlines ---');
testContains(
  'text.## Heading splits into paragraph + heading',
  'some text.## Heading',
  '<p>', 'some text.', '<h2>', 'Heading', '</h2>'
);

testContains(
  'text\\n## Heading gets blank line inserted',
  'some text\n## Heading',
  '<p>', '<h2>'
);

// 3. Multiple headings in sequence
console.log('\n--- Multiple headings ---');
testContains(
  'h2 then h3 then h4 all render',
  '## Title\n\n### Subtitle\n\n#### Detail',
  '<h2>Title</h2>', '<h3>Subtitle</h3>', '<h4>Detail</h4>'
);

// 4. Heading followed by content on next line
console.log('\n--- Heading followed by content ---');
testContains(
  'heading with trailing content renders both',
  '## Heading\nSome content here',
  '<h2>Heading</h2>', '<p>Some content here</p>'
);

// 5. Code block placeholders should not leak
console.log('\n--- Code block placeholder leaking ---');
testNotContains(
  'CB0 placeholder does not appear in output',
  '```js\nconsole.log("hello");\n```',
  'CB0', 'CB1', '\x00'
);

testContains(
  'code block renders as pre/code',
  '```js\nconsole.log("hello");\n```',
  '<pre><code>', 'console.log', '</code></pre>'
);

// 6. Code blocks with language hints
console.log('\n--- Code blocks with language hints ---');
testContains(
  'typescript code block renders correctly',
  '```typescript\nconst x: number = 42;\n```',
  '<pre><code>', 'const x: number = 42;', '</code></pre>'
);

// 7. Code block content is HTML-escaped
console.log('\n--- Code block escaping ---');
testContains(
  'code block HTML entities are escaped',
  '```\n<div class="foo">bar</div>\n```',
  '&lt;div', '&quot;foo&quot;', '&gt;'
);

// 8. Tables with pipes
console.log('\n--- Tables ---');
testContains(
  'basic table renders',
  '| Name | Value |\n|------|-------|\n| foo  | 42    |\n| bar  | 99    |',
  '<table>', '<thead>', '<th>Name</th>', '<th>Value</th>',
  '<td>foo</td>', '<td>42</td>',
  '<td>bar</td>', '<td>99</td>',
  '</tbody>', '</table>'
);

// 9. Unordered list
console.log('\n--- Unordered lists ---');
testContains(
  'unordered list with dashes',
  '- First item\n- Second item\n- Third item',
  '<ul>', '<li>First item</li>', '<li>Second item</li>', '<li>Third item</li>', '</ul>'
);

testContains(
  'unordered list with asterisks',
  '* Alpha\n* Beta',
  '<ul>', '<li>Alpha</li>', '<li>Beta</li>', '</ul>'
);

// 10. Ordered list
console.log('\n--- Ordered lists ---');
testContains(
  'ordered list renders',
  '1. Step one\n2. Step two\n3. Step three',
  '<ol>', '<li>Step one</li>', '<li>Step two</li>', '<li>Step three</li>', '</ol>'
);

// 11. Inline formatting: bold, italic, code
console.log('\n--- Inline formatting ---');
testContains(
  'bold text',
  'This is **bold** text',
  '<strong>bold</strong>'
);

testContains(
  'italic text',
  'This is *italic* text',
  '<em>italic</em>'
);

testContains(
  'inline code',
  'Run `npm install` now',
  '<code>npm install</code>'
);

testContains(
  'mixed inline formatting',
  'Use **bold** and *italic* and `code` together',
  '<strong>bold</strong>', '<em>italic</em>', '<code>code</code>'
);

// 12. Horizontal rules
console.log('\n--- Horizontal rules ---');
testContains(
  'triple dashes become hr',
  '---',
  '<hr>'
);

testContains(
  'many dashes become hr',
  '----------',
  '<hr>'
);

// 13. Paragraphs
console.log('\n--- Paragraphs ---');
testContains(
  'plain text becomes paragraph',
  'Just some plain text here.',
  '<p>Just some plain text here.</p>'
);

testContains(
  'two paragraphs separated by blank line',
  'Paragraph one.\n\nParagraph two.',
  '<p>Paragraph one.</p>', '<p>Paragraph two.</p>'
);

// 14. Line breaks within a paragraph
console.log('\n--- Line breaks ---');
testContains(
  'single newline within paragraph becomes br',
  'Line one\nLine two',
  '<p>Line one<br>Line two</p>'
);

// 15. Mixed content: heading + paragraph + list + code block + table
console.log('\n--- Mixed content ---');
{
  const mixed = `## Overview

This is the description.

- Item A
- Item B

\`\`\`python
print("hello")
\`\`\`

| Col1 | Col2 |
|------|------|
| a    | b    |

---

### Subsection

Final paragraph.`;

  const out = renderMarkdown(mixed);
  test(
    'mixed content renders all block types',
    mixed,
    (o) =>
      o.includes('<h2>Overview</h2>') &&
      o.includes('<p>This is the description.</p>') &&
      o.includes('<ul>') &&
      o.includes('<li>Item A</li>') &&
      o.includes('<pre><code>') &&
      o.includes('print(&quot;hello&quot;)') &&
      o.includes('<table>') &&
      o.includes('<hr>') &&
      o.includes('<h3>Subsection</h3>') &&
      o.includes('<p>Final paragraph.</p>'),
    'all block types present'
  );
}

// 16. HTML in plain text is escaped
console.log('\n--- HTML escaping in text ---');
testContains(
  'HTML tags in paragraph are escaped',
  'Use <div> for layout',
  '&lt;div&gt;'
);
testNotContains(
  'no raw HTML div in output',
  'Use <div> for layout',
  '<div>'
);

// 17. Multiple code blocks
console.log('\n--- Multiple code blocks ---');
{
  const input = '```js\nfoo();\n```\n\nSome text.\n\n```python\nbar()\n```';
  const out = renderMarkdown(input);
  test(
    'multiple code blocks both render, no placeholder leaks',
    input,
    (o) =>
      o.includes('foo();') &&
      o.includes('bar()') &&
      !o.includes('CB0') &&
      !o.includes('CB1') &&
      !o.includes('\x00') &&
      (o.match(/<pre><code>/g) || []).length === 2,
    'two code blocks, no CB leaks'
  );
}

// 18. Code block placeholder inside inline text (edge case)
console.log('\n--- Code block placeholder in inline context ---');
{
  const input = 'Before\n\n```\ncode here\n```\n\nAfter';
  const out = renderMarkdown(input);
  test(
    'code block between paragraphs',
    input,
    (o) =>
      o.includes('<p>Before</p>') &&
      o.includes('<pre><code>code here') &&
      o.includes('<p>After</p>') &&
      !o.includes('\x00'),
    'before paragraph, code block, after paragraph'
  );
}

// 19. Heading directly after code block
console.log('\n--- Heading after code block ---');
testContains(
  'heading after code block renders both',
  '```\nsome code\n```\n\n## Next Section',
  '<pre><code>', '<h2>Next Section</h2>'
);

// 20. Inline code with special chars
console.log('\n--- Inline code with special chars ---');
testContains(
  'inline code with angle brackets',
  'Use `Array<string>` type',
  '<code>Array&lt;string&gt;</code>'
);

// 21. Bold and italic inside list items
console.log('\n--- Formatting inside list items ---');
testContains(
  'bold in list item',
  '- **Important** item\n- Normal item',
  '<li><strong>Important</strong> item</li>'
);

// 22. Table with inline formatting
console.log('\n--- Table with inline formatting ---');
testContains(
  'table cells with bold',
  '| Name | Status |\n|------|--------|\n| foo  | **active** |',
  '<td><strong>active</strong></td>'
);

// 23. Copyable prompt lines ($ prefix) -- renderMarkdown does NOT handle these
// (it is post-render DOM manipulation), so $ lines are just regular text
console.log('\n--- Prompt lines with $ ---');
testContains(
  'lines starting with $ render as plain text in paragraph',
  '$ npm install\n$ npm run build',
  '<p>', '$ npm install', '$ npm run build'
);

// 24. Heading with inline formatting
console.log('\n--- Heading with inline formatting ---');
testContains(
  'heading with bold text',
  '## The **important** heading',
  '<h2>The <strong>important</strong> heading</h2>'
);

// 25. Deeply nested -- ordered list immediately after unordered
console.log('\n--- List type transitions ---');
{
  const input = '- Unordered A\n- Unordered B\n\n1. Ordered A\n2. Ordered B';
  const out = renderMarkdown(input);
  test(
    'unordered then ordered list',
    input,
    (o) =>
      o.includes('<ul>') &&
      o.includes('<ol>') &&
      o.includes('<li>Unordered A</li>') &&
      o.includes('<li>Ordered A</li>'),
    'both list types present'
  );
}

// 26. Empty code block
console.log('\n--- Empty code block ---');
testContains(
  'empty code block renders',
  '```\n\n```',
  '<pre><code>'
);

// 27. Heading levels
console.log('\n--- All heading levels ---');
testContains('h1 renders', '# H1 Heading', '<h1>H1 Heading</h1>');
testContains('h2 renders', '## H2 Heading', '<h2>H2 Heading</h2>');
testContains('h3 renders', '### H3 Heading', '<h3>H3 Heading</h3>');
testContains('h4 renders', '#### H4 Heading', '<h4>H4 Heading</h4>');

// 28. Bare heading markers (should be stripped)
console.log('\n--- Bare heading markers ---');
testContains('bare # is stripped', '#', '');
testContains('bare ## is stripped', '##', '');
testContains('bare ### with space is stripped', '### ', '');
testContains('bare # between content stripped', 'Hello\n\n#\n\n## Title', '<p>Hello</p>', '<h2>Title</h2>');

// ---- Summary ----

console.log('\n=== Results ===');
console.log(`  Total: ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`  Failed tests:`);
  for (const f of failures) {
    console.log(`    - ${f}`);
  }
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
