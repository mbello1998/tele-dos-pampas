import { describe, expect, test } from 'vitest'
import { emailMethod, getLoginMethod, normalizeCode, phoneMethod } from '@/lib/auth/login-method'

type Call = { fn: string; args: unknown[] }
function fakeClient(result: { error: { code?: string; status?: number; message?: string } | null } = { error: null }) {
  const calls: Call[] = []
  const auth = {
    signInWithOtp: async (...args: unknown[]) => (calls.push({ fn: 'signInWithOtp', args }), result),
    verifyOtp: async (...args: unknown[]) => (calls.push({ fn: 'verifyOtp', args }), result),
  }
  return { client: { auth } as never, calls }
}

describe('método de login: e-mail (o que está no ar)', () => {
  test('normaliza e valida o e-mail', () => {
    expect(emailMethod.normalize('  Foo@Bar.COM ')).toBe('foo@bar.com')
    for (const v of ['', 'x', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'a@c.', `${'a'.repeat(250)}@b.co`]) {
      expect(emailMethod.normalize(v), v).toBeNull()
    }
  })

  test('envia o código com signInWithOtp, criando a conta se for a primeira vez, e SEM metadados do usuário', async () => {
    const { client, calls } = fakeClient()
    expect(await emailMethod.sendCode(client, 'a@b.co')).toBeNull()
    expect(calls).toEqual([{ fn: 'signInWithOtp', args: [{ email: 'a@b.co', options: { shouldCreateUser: true } }] }])
    // `options.data` viraria user_metadata, que o próprio usuário controla: nunca pode ir daqui.
    expect(JSON.stringify(calls[0].args)).not.toContain('"data"')
  })

  test('confere o código com verifyOtp type email', async () => {
    const { client, calls } = fakeClient()
    expect(await emailMethod.verifyCode(client, 'a@b.co', '123456')).toBeNull()
    expect(calls).toEqual([{ fn: 'verifyOtp', args: [{ email: 'a@b.co', token: '123456', type: 'email' }] }])
  })

  test('traduz os erros do Supabase em poucas categorias, sem vazar o texto bruto', async () => {
    const send = (e: object) => emailMethod.sendCode(fakeClient({ error: e }).client, 'a@b.co')
    const verify = (e: object) => emailMethod.verifyCode(fakeClient({ error: e }).client, 'a@b.co', '123456')
    expect(await send({ code: 'over_email_send_rate_limit', status: 429 })).toBe('rate_limited')
    expect(await send({ status: 429 })).toBe('rate_limited')
    expect(await send({ code: 'email_address_invalid', status: 400 })).toBe('invalid_identifier')
    expect(await send({ code: 'unexpected_failure', status: 500 })).toBe('failed')
    expect(await verify({ code: 'otp_expired', status: 403 })).toBe('code_invalid')
    expect(await verify({ code: 'validation_failed', status: 400 })).toBe('code_invalid')
    expect(await verify({ status: 429 })).toBe('rate_limited')
    expect(await verify({ code: 'unexpected_failure', status: 500 })).toBe('failed')
  })
})

describe('método de login: telefone (a troca futura, sem mexer em telas)', () => {
  test('normaliza para E.164 com +', () => {
    expect(phoneMethod.normalize('+55 (55) 99123-4567')).toBe('+5555991234567')
    expect(phoneMethod.normalize('5555991234567')).toBe('+5555991234567')
    for (const v of ['', 'abc', '123', '1'.repeat(16)]) expect(phoneMethod.normalize(v), v).toBeNull()
  })

  test('as duas chamadas mudam, e só elas', async () => {
    const { client, calls } = fakeClient()
    await phoneMethod.sendCode(client, '+5555991234567')
    await phoneMethod.verifyCode(client, '+5555991234567', '123456')
    expect(calls).toEqual([
      { fn: 'signInWithOtp', args: [{ phone: '+5555991234567', options: { shouldCreateUser: true } }] },
      { fn: 'verifyOtp', args: [{ phone: '+5555991234567', token: '123456', type: 'sms' }] },
    ])
  })

  test('as telas dependem só do contrato: os dois métodos expõem os mesmos campos', () => {
    expect(Object.keys(phoneMethod).sort()).toEqual(Object.keys(emailMethod).sort())
    expect(emailMethod.inputType).toBe('email')
    expect(phoneMethod.inputType).toBe('tel')
  })
})

describe('getLoginMethod (a única chave de troca)', () => {
  test('padrão é e-mail; phone troca; valor desconhecido falha alto em vez de cair em e-mail em silêncio', () => {
    expect(getLoginMethod(undefined)).toBe(emailMethod)
    expect(getLoginMethod('')).toBe(emailMethod)
    expect(getLoginMethod('email')).toBe(emailMethod)
    expect(getLoginMethod('phone')).toBe(phoneMethod)
    expect(() => getLoginMethod('sms')).toThrow(/NEXT_PUBLIC_LOGIN_METHOD/)
  })
})

describe('normalizeCode', () => {
  test('aceita 6 a 10 dígitos, ignora espaço e hífen de colagem', () => {
    expect(normalizeCode('123456')).toBe('123456')
    expect(normalizeCode(' 123 456 ')).toBe('123456')
    expect(normalizeCode('123-456')).toBe('123456')
    expect(normalizeCode('12345678')).toBe('12345678')
    for (const v of ['', '12345', '12a456', '12345678901', 'abcdef']) expect(normalizeCode(v), v).toBeNull()
  })
})
