import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { markdownToStorage, storageToMarkdown } from '../src/confluence/convert.ts'

const DOCUMENT = `## Estado

El **WAF** bloquea *las* IPs de \`admin\` y snake_case_name. Ver [docs](https://x.com/a?b=1&c=2).

- uno
- dos
  - anidado
- [ ] pendiente

1. primero
2. segundo

\`\`\`ts
const a = 1 < 2 && "]]>"
\`\`\`

> cita

| A | B |
| --- | --- |
| 1 | 2 |

---

### Detalle

Fin.`

test('markdown becomes valid storage: void tags closed, code as a macro with its language in CDATA', () => {
  const storage = markdownToStorage(DOCUMENT)
  assert.match(storage, /<h2>Estado<\/h2>/)
  assert.match(storage, /<hr \/>/)
  assert.doesNotMatch(storage, /<hr>/)
  assert.match(
    storage,
    /<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts<\/ac:parameter><ac:plain-text-body><!\[CDATA\[const a = 1 < 2 && "]]]]><!\[CDATA\[>"]]><\/ac:plain-text-body><\/ac:structured-macro>/,
  )
  assert.match(storage, /<table><tbody><tr>/)
  assert.doesNotMatch(storage, /<thead>/)
  assert.match(storage, /<a href="https:\/\/x.com\/a\?b=1&amp;c=2">docs<\/a>/)
  assert.match(markdownToStorage('a  \nb'), /<br \/>/)
  assert.match(markdownToStorage('![red](assets/red.png)'), /<ac:image ac:alt="red"><ri:attachment ri:filename="red.png" \/><\/ac:image>/)
})

test('markdown survives the round trip through storage', () => {
  assert.equal(storageToMarkdown(markdownToStorage(DOCUMENT)), DOCUMENT)
})

test('the round trip is stable once a document went through it', () => {
  const once = storageToMarkdown(markdownToStorage('Texto con <b>html</b> y una lista:\n\n* a\n* b'))
  assert.equal(storageToMarkdown(markdownToStorage(once)), once)
})

test('Confluence macros come back as markdown or as a placeholder', () => {
  const storage = [
    '<p>a</p>',
    '<ac:structured-macro ac:name="toc" />',
    '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Ojo</ac:parameter><ac:rich-text-body><p>cuidado</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sql</ac:parameter><ac:plain-text-body><![CDATA[SELECT 1 < 2;]]></ac:plain-text-body></ac:structured-macro>',
    '<p>ver <ac:link><ri:page ri:content-title="Otra página" /></ac:link><br/>fin</p>',
    '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>hecho</ac:task-body></ac:task></ac:task-list>',
    '<ac:image><ri:attachment ri:filename="red net.png" /></ac:image>',
  ].join('')

  assert.equal(
    storageToMarkdown(storage),
    [
      'a',
      '[Confluence macro: toc]',
      '> **Ojo**\n> \n> cuidado',
      '```sql\nSELECT 1 < 2;\n```',
      'ver Otra página  \nfin',
      '- [x] hecho',
      '![red net.png](red%20net.png)',
    ].join('\n\n'),
  )
})
