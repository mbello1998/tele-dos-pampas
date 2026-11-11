// Textos da interface do app (cadastro, onboarding, espera de aprovação, perfil).
//
// Só o que o app consome hoje. Os textos da landing NÃO vivem aqui: moram na tabela `settings` e são lidos de lá
// (src/lib/landing). Duas fontes de texto para a mesma tela seriam duas verdades a manter.
// pt-BR é a tabela de referência: o tipo das chaves sai dela, e es-UY é obrigada a ter exatamente as mesmas
// (em compilação, pelo tipo, e em teste, tests/unit/i18n.test.ts).
export const ptBR = {
  'common.wait': 'Aguarde...',

  'auth.title': 'Entrar',
  'auth.intro.email': 'Digite seu e-mail. Enviamos um código para você entrar, sem senha.',
  'auth.intro.phone': 'Digite seu celular com DDI. Enviamos um código por SMS para você entrar, sem senha.',
  'auth.email.label': 'E-mail',
  'auth.password.label': 'Senha',
  'auth.intro.password': 'Entre com seu e-mail e uma senha. Se ainda não tem conta, ela é criada na hora.',
  'auth.enter': 'Entrar',
  'auth.error.password_short': 'A senha precisa de pelo menos 6 caracteres.',
  'auth.error.credentials': 'E-mail ou senha incorretos.',
  'auth.error.confirm_still_on': 'A conta foi criada, mas o Supabase ainda exige confirmação por e-mail. Desligue "Confirm email" no painel do projeto.',
  'auth.phone.label': 'Celular (com DDI)',
  'auth.send': 'Enviar código',
  'auth.code.sent': 'Enviamos um código para',
  'auth.code.have': 'Já tenho um código',
  'auth.code.label': 'Código',
  'auth.verify': 'Confirmar e entrar',
  'auth.resend': 'Enviar outro código',
  'auth.back': 'Voltar',
  'auth.signout': 'Sair',
  'auth.error.email_invalid': 'Confira o e-mail digitado.',
  'auth.error.phone_invalid': 'Confira o número digitado.',
  'auth.error.code_invalid': 'Código incorreto ou vencido. Peça um novo.',
  'auth.error.rate_limited': 'Muitas tentativas. Aguarde um minuto e tente de novo.',
  'auth.error.failed': 'Não foi possível agora. Tente de novo em instantes.',

  'onboarding.title': 'Vamos começar',
  'onboarding.intro': 'Conte o básico para fazer seu primeiro pedido.',
  'onboarding.submit': 'Continuar',

  'profile.title': 'Seu perfil',
  'profile.name.label': 'Nome',
  'profile.phone.label': 'Celular (opcional)',
  'profile.phone.hint': 'Com DDI, por exemplo +55 55 99999-9999.',
  'profile.city.label': 'Cidade',
  'profile.language.label': 'Idioma',
  'profile.currency.label': 'Ver preços em',
  'profile.currency.preview': 'Exemplo de preço',
  'profile.save': 'Salvar',
  'profile.saved': 'Salvo',
  'profile.error.invalid': 'Confira os campos e tente de novo.',
  'profile.error.forbidden': 'Sua conta não pode alterar o perfil agora.',
  'profile.error.failed': 'Não foi possível salvar agora.',

  'city.quarai': 'Quaraí',
  'city.artigas': 'Artigas',
  'currency.BRL': 'Reais (R$)',
  'currency.UYU': 'Pesos uruguaios ($U)',

  'pending.title': 'Cadastro em análise',
  'pending.body':
    'Recebemos seu cadastro. A equipe do Tele dos Pampas precisa aprovar antes de liberar o acesso. Volte mais tarde: quando for aprovado, o acesso abre sozinho.',
  'pending.refresh': 'Verificar de novo',
  'blocked.title': 'Conta bloqueada',
  'blocked.body': 'Sua conta está bloqueada. Fale com a equipe do Tele dos Pampas para entender o motivo.',
  'support.whatsapp': 'Falar com a equipe no WhatsApp',
} as const satisfies Record<string, string>

export type TranslationKey = keyof typeof ptBR
