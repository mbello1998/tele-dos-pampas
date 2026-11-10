import { describe, expect, test } from 'vitest'
import { adminGate, isOnboarded, postLoginPath, safeNextPath } from '@/lib/auth/access'
import type { ProfileLite } from '@/lib/auth/types'

const active = (role: ProfileLite['role'], fullName: string | null = 'Ana'): ProfileLite => ({ role, status: 'active', fullName })

describe('adminGate: o que o middleware decide para /admin/*', () => {
  test('sem usuário: anônimo', () => {
    expect(adminGate(null, null)).toEqual({ allow: false, reason: 'anonymous' })
  })
  test('usuário sem perfil: recusado como proibido (nunca tratado como admin)', () => {
    expect(adminGate({ id: 'u' }, null)).toEqual({ allow: false, reason: 'forbidden' })
  })
  test('admin ativo entra', () => {
    expect(adminGate({ id: 'u' }, active('admin'))).toEqual({ allow: true })
  })
  test.each(['client', 'courier', 'merchant', 'fleet'] as const)('%s ativo não entra', (role) => {
    expect(adminGate({ id: 'u' }, active(role))).toEqual({ allow: false, reason: 'forbidden' })
  })
  test.each(['pending', 'blocked'] as const)('admin %s não entra: sem privilégio nenhum, como no banco', (status) => {
    expect(adminGate({ id: 'u' }, { role: 'admin', status, fullName: 'Ana' })).toEqual({ allow: false, reason: 'inactive' })
  })
  test('um papel que parece admin mas não é exatamente admin não entra', () => {
    expect(adminGate({ id: 'u' }, { role: 'Admin' as never, status: 'active', fullName: 'x' })).toEqual({ allow: false, reason: 'forbidden' })
    expect(adminGate({ id: 'u' }, { role: 'authenticated' as never, status: 'active', fullName: 'x' })).toEqual({ allow: false, reason: 'forbidden' })
  })
})

describe('safeNextPath: destino pós-login sem redirecionamento aberto', () => {
  test.each([
    ['/pedir', '/pedir'],
    ['/admin/despacho?x=1#a', '/admin/despacho?x=1#a'],
    ['/', '/'],
  ])('aceita %s', (raw, out) => expect(safeNextPath(raw)).toBe(out))

  test.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['https://evil.example'],
    ['http://evil.example/x'],
    ['javascript:alert(1)'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/\r/evil.example'],
    ['evil.example'],
    [''],
    [null],
    [undefined],
    [42],
    [['/ok']],
    ['/entrar?next=/pedir'],
    ['/entrar'],
    ['/' + 'a'.repeat(600)],
  ])('recusa %j e cai em /', (raw) => expect(safeNextPath(raw)).toBe('/'))

  test('o fallback é configurável', () => {
    expect(safeNextPath('//evil.example', '/onboarding')).toBe('/onboarding')
  })
})

describe('isOnboarded e postLoginPath', () => {
  test('onboarded = tem nome', () => {
    expect(isOnboarded(active('client', 'Ana'))).toBe(true)
    expect(isOnboarded(active('client', null))).toBe(false)
    expect(isOnboarded(active('client', '   '))).toBe(false)
  })
  test('pending e blocked vão para a tela de espera, qualquer que seja o next', () => {
    expect(postLoginPath({ role: 'courier', status: 'pending', fullName: null }, '/pedir')).toBe('/aguardando')
    expect(postLoginPath({ role: 'client', status: 'blocked', fullName: 'Ana' }, '/admin')).toBe('/aguardando')
  })
  test('ativo sem nome vai para o onboarding e leva o destino', () => {
    expect(postLoginPath(active('client', null), null)).toBe('/onboarding')
    expect(postLoginPath(active('client', null), '/pedir')).toBe('/onboarding?next=%2Fpedir')
  })
  test('ativo com nome vai ao destino seguro ou a /', () => {
    expect(postLoginPath(active('client'), '/pedir')).toBe('/pedir')
    expect(postLoginPath(active('client'), '//evil.example')).toBe('/')
    expect(postLoginPath(active('client'), undefined)).toBe('/')
  })
  test('o destino malicioso também não passa pelo onboarding', () => {
    expect(postLoginPath(active('client', null), '//evil.example')).toBe('/onboarding')
  })
})
