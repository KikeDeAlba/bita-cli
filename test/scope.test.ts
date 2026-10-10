import './helpers/isolate.ts'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  coversSlug,
  normalizeProjectName,
  resolveScopeForSlug,
  suggestProjectForSlug,
} from '../src/domain/repo.ts'

const APARTADOS = 'gitlab.com/vivaaerobus/vb_solemti/apartados'
const API = `${APARTADOS}/api`

const PROJECTS = [
  { id: 1, name: 'Apartados' },
  { id: 2, name: 'VB Vivagift v2' },
  { id: 3, name: 'CRM Email Marketing' },
  { id: 4, name: 'VivaAerobus' },
]

test('a prefix covers the repositories underneath it', () => {
  assert.equal(coversSlug(APARTADOS, API), true)
  assert.equal(coversSlug(APARTADOS, APARTADOS), true)
})

test('a prefix only matches on segment boundaries', () => {
  assert.equal(coversSlug(APARTADOS, `${APARTADOS}-legacy/api`), false)
  assert.equal(coversSlug(APARTADOS, 'gitlab.com/vivaaerobus/vb_solemti/apartadosv2'), false)
})

test('the longest matching prefix wins', () => {
  const scopes = {
    'gitlab.com/vivaaerobus': { projectId: 9 },
    'gitlab.com/vivaaerobus/vb_solemti': { projectId: 8 },
    [APARTADOS]: { projectId: 1 },
  }
  const match = resolveScopeForSlug(API, scopes)
  assert.equal(match?.prefix, APARTADOS)
  assert.equal(match?.scope.projectId, 1)
})

test('a single repository still resolves, as the most specific prefix there is', () => {
  const scopes = { 'github.com/kikedealba/bita-cli': { projectId: 7 } }
  assert.equal(resolveScopeForSlug('github.com/kikedealba/bita-cli', scopes)?.scope.projectId, 7)
})

test('an exception inside a group beats the group', () => {
  const scopes = {
    [APARTADOS]: { projectId: 1 },
    [`${APARTADOS}/api`]: { projectId: 42 },
  }
  assert.equal(resolveScopeForSlug(API, scopes)?.scope.projectId, 42)
  assert.equal(resolveScopeForSlug(`${APARTADOS}/front`, scopes)?.scope.projectId, 1)
})

test('returns nothing when no prefix covers the repository', () => {
  assert.equal(resolveScopeForSlug(API, { 'gitlab.com/otro': { projectId: 3 } }), null)
  assert.equal(resolveScopeForSlug(API, {}), null)
})

test('normalises dashes, underscores, case and accents', () => {
  assert.equal(normalizeProjectName('VB Vivagift v2'), 'vbvivagiftv2')
  assert.equal(normalizeProjectName('vb_vivagift_v2'), 'vbvivagiftv2')
  assert.equal(normalizeProjectName('crm-email-marketing'), 'crmemailmarketing')
  assert.equal(normalizeProjectName('Facturación'), 'facturacion')
})

test('suggests the project whose name matches a path segment', () => {
  const suggestion = suggestProjectForSlug(API, PROJECTS)
  assert.equal(suggestion?.project.name, 'Apartados')
  assert.equal(suggestion?.segment, 'apartados')
})

test('the matching segment decides how deep the saved prefix goes', () => {
  const suggestion = suggestProjectForSlug(API, PROJECTS)
  assert.equal(suggestion?.prefix, APARTADOS)
})

test('matches a segment that differs only in separators and case', () => {
  const suggestion = suggestProjectForSlug(
    'gitlab.com/vivaaerobus/vb_solemti/vb_vivagift_v2',
    PROJECTS,
  )
  assert.equal(suggestion?.project.name, 'VB Vivagift v2')
})

test('refuses a near miss instead of guessing', () => {
  const nearMiss = suggestProjectForSlug(
    'gitlab.com/vivaaerobus/vb_solemti/apartados-v2/api',
    [{ id: 1, name: 'Apartados' }],
  )
  assert.equal(nearMiss, null)
})

test('falls back to a broader segment rather than accepting a near miss', () => {
  const suggestion = suggestProjectForSlug(
    'gitlab.com/vivaaerobus/vb_solemti/apartados-v2/api',
    PROJECTS,
  )
  assert.equal(suggestion?.project.name, 'VivaAerobus')
  assert.equal(suggestion?.prefix, 'gitlab.com/vivaaerobus')
})

test('prefers the most specific segment when several match', () => {
  const projects = [
    { id: 1, name: 'VivaAerobus' },
    { id: 2, name: 'Apartados' },
  ]
  const suggestion = suggestProjectForSlug(API, projects)
  assert.equal(suggestion?.project.name, 'Apartados')
  assert.equal(suggestion?.prefix, APARTADOS)
})

test('suggests nothing when no segment matches a project', () => {
  assert.equal(suggestProjectForSlug('gitlab.com/otra/cosa/rara', PROJECTS), null)
})
