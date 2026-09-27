import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfluenceClient, mediaTypeOf, siteBase, type Fetch } from '../src/confluence/client.ts'
import { adfImage, displaySize, pngSize, storageImage } from '../src/confluence/fragments.ts'
import { deleteToken, KEYCHAIN_SERVICE, readToken, storeToken } from '../src/state/keychain.ts'

const SITE = 'https://gruposti.atlassian.net'

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(calls: Call[], respond: (call: Call) => { status?: number; body: unknown }): Fetch {
  return (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as Fetch
}

test('the token goes to and comes from the Keychain under the bita service', async () => {
  const calls: string[][] = []
  const run = async (args: readonly string[]) => {
    calls.push([...args])
    return 'secret-token\n'
  }
  await storeToken('me@x.com', 'secret-token', run)
  assert.equal(await readToken('me@x.com', run), 'secret-token')
  assert.deepEqual(calls[0], ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'me@x.com', '-w', 'secret-token'])
  assert.deepEqual(calls[1], ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'me@x.com', '-w'])
})

test('a missing Keychain item reads as no token, other failures are errors', async () => {
  const missing = async () => {
    throw Object.assign(new Error('failed'), { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' })
  }
  assert.equal(await readToken('me@x.com', missing), null)
  assert.equal(await deleteToken('me@x.com', missing), false)
  const locked = async () => {
    throw Object.assign(new Error('failed'), { code: 51, stderr: 'User interaction is not allowed.' })
  }
  await assert.rejects(readToken('me@x.com', locked), /User interaction is not allowed/)
})

test('requests carry basic auth and hit the wiki api of the site', async () => {
  const calls: Call[] = []
  const client = new ConfluenceClient(
    { siteUrl: `${SITE}/`, email: 'me@x.com', token: 't0k' },
    fakeFetch(calls, () => ({ body: { accountId: 'a1', displayName: 'Enrique' } })),
  )
  assert.deepEqual(await client.currentUser(), { accountId: 'a1', displayName: 'Enrique' })
  assert.equal(calls[0]?.url, `${SITE}/wiki/rest/api/user/current`)
  const headers = calls[0]?.init.headers as Record<string, string>
  assert.equal(headers['Authorization'], `Basic ${Buffer.from('me@x.com:t0k').toString('base64')}`)
})

test('an attachment is created or replaced with a multipart PUT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bita-confluence-'))
  const file = join(dir, 'red.png')
  writeFileSync(file, png(1600, 800))
  const calls: Call[] = []
  const client = new ConfluenceClient(
    { siteUrl: SITE, email: 'me@x.com', token: 't' },
    fakeFetch(calls, () => ({
      body: { results: [{ id: 'att42', title: 'red.png', extensions: { fileId: 'f-uuid', mediaType: 'image/png' }, _links: { download: '/download/attachments/99/red.png' } }] },
    })),
  )
  const attachment = await client.attach('99', file, 'bita')
  assert.equal(calls[0]?.url, `${SITE}/wiki/rest/api/content/99/child/attachment`)
  assert.equal(calls[0]?.init.method, 'PUT')
  assert.equal((calls[0]?.init.headers as Record<string, string>)['X-Atlassian-Token'], 'no-check')
  const form = calls[0]?.init.body as FormData
  assert.equal((form.get('file') as File).name, 'red.png')
  assert.equal(form.get('comment'), 'bita')
  assert.deepEqual(attachment, {
    attachmentId: 'att42',
    filename: 'red.png',
    fileId: 'f-uuid',
    mediaType: 'image/png',
    downloadUrl: `${SITE}/wiki/download/attachments/99/red.png`,
  })
})

test('a refused token points at the login, other errors carry the status', async () => {
  const denied = new ConfluenceClient({ siteUrl: SITE, email: 'e', token: 't' }, fakeFetch([], () => ({ status: 401, body: '' })))
  await assert.rejects(denied.currentUser(), /refused the credentials/)
  const broken = new ConfluenceClient({ siteUrl: SITE, email: 'e', token: 't' }, fakeFetch([], () => ({ status: 404, body: '{"message":"No content"}' })))
  await assert.rejects(broken.pageStorage('1'), /HTTP 404/)
})

test('replacing the storage bumps the version', async () => {
  const calls: Call[] = []
  const client = new ConfluenceClient({ siteUrl: SITE, email: 'e', token: 't' }, fakeFetch(calls, () => ({ body: { version: { number: 8 } } })))
  const next = await client.replaceStorage({ id: '5', title: 'Hub', version: 7, storage: '', webUrl: null }, '<p>x</p>', 'bita: diagrams')
  assert.equal(next, 8)
  const sent = JSON.parse(String(calls[0]?.init.body)) as { version: { number: number }; body: { representation: string } }
  assert.equal(sent.version.number, 8)
  assert.equal(sent.body.representation, 'storage')
})

test('only an https site root is accepted', () => {
  assert.equal(siteBase('https://gruposti.atlassian.net/'), SITE)
  assert.throws(() => siteBase('http://gruposti.atlassian.net'), /not an Atlassian site URL/)
  assert.throws(() => siteBase('https://gruposti.atlassian.net/wiki'), /not an Atlassian site URL/)
})

test('png size is read from the header and shown at half, capped at 1200', () => {
  assert.deepEqual(pngSize(png(1600, 800)), { width: 1600, height: 800 })
  assert.equal(pngSize(Buffer.from('not a png at all, really')), null)
  assert.deepEqual(displaySize({ width: 1600, height: 800 }), { width: 800, height: 400 })
  assert.deepEqual(displaySize({ width: 3000, height: 1000 }), { width: 1200, height: 400 })
})

test('fragments reference the attachment in adf and in storage', () => {
  const attachment = { attachmentId: 'att1', filename: 'a&b.png', fileId: 'f1', mediaType: 'image/png', downloadUrl: null }
  const adf = adfImage('99', attachment, { width: 800, height: 400 }) as { content: { attrs: Record<string, unknown> }[] }
  assert.equal(adf.content[0]?.attrs['collection'], 'contentId-99')
  assert.equal(adf.content[0]?.attrs['id'], 'f1')
  assert.equal(adfImage('99', { ...attachment, fileId: null }, null), null)
  assert.equal(storageImage('a&b.png', { width: 800, height: 400 }), '<ac:image ac:align="center" ac:width="800"><ri:attachment ri:filename="a&amp;b.png" /></ac:image>')
  assert.equal(mediaTypeOf('red.drawio'), 'application/vnd.jgraph.mxfile')
})
