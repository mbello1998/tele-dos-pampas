import type { TranslationKey } from './pt-BR'

// Español rioplatense (voseo), el que se habla en Artigas. Mismas claves que pt-BR, por tipo y por test.
export const esUY: Record<TranslationKey, string> = {
  'common.wait': 'Esperá...',

  'auth.title': 'Ingresar',
  'auth.intro.email': 'Escribí tu correo. Te enviamos un código para ingresar, sin contraseña.',
  'auth.intro.phone': 'Escribí tu celular con código de país. Te enviamos un código por SMS para ingresar, sin contraseña.',
  'auth.email.label': 'Correo electrónico',
  'auth.phone.label': 'Celular (con código de país)',
  'auth.send': 'Enviar código',
  'auth.code.sent': 'Enviamos un código a',
  'auth.code.have': 'Ya tengo un código',
  'auth.code.label': 'Código',
  'auth.verify': 'Confirmar e ingresar',
  'auth.resend': 'Enviar otro código',
  'auth.back': 'Volver',
  'auth.signout': 'Salir',
  'auth.error.email_invalid': 'Revisá el correo que escribiste.',
  'auth.error.phone_invalid': 'Revisá el número que escribiste.',
  'auth.error.code_invalid': 'Código incorrecto o vencido. Pedí uno nuevo.',
  'auth.error.rate_limited': 'Demasiados intentos. Esperá un minuto y probá de nuevo.',
  'auth.error.failed': 'No fue posible ahora. Probá de nuevo en unos instantes.',

  'onboarding.title': 'Empecemos',
  'onboarding.intro': 'Contanos lo básico para hacer tu primer pedido.',
  'onboarding.submit': 'Continuar',

  'profile.title': 'Tu perfil',
  'profile.name.label': 'Nombre',
  'profile.phone.label': 'Celular (opcional)',
  'profile.phone.hint': 'Con código de país, por ejemplo +598 99 123 456.',
  'profile.city.label': 'Ciudad',
  'profile.language.label': 'Idioma',
  'profile.currency.label': 'Ver precios en',
  'profile.currency.preview': 'Ejemplo de precio',
  'profile.save': 'Guardar',
  'profile.saved': 'Cambios guardados.',
  'profile.error.invalid': 'Revisá los campos y probá de nuevo.',
  'profile.error.forbidden': 'Tu cuenta no puede modificar el perfil ahora.',
  'profile.error.failed': 'No fue posible guardar ahora.',

  'city.quarai': 'Quaraí',
  'city.artigas': 'Artigas',
  'currency.BRL': 'Reales (R$)',
  'currency.UYU': 'Pesos uruguayos ($U)',

  'pending.title': 'Registro en revisión',
  'pending.body':
    'Recibimos tu registro. El equipo de Tele dos Pampas debe aprobarlo antes de habilitar el acceso. Volvé más tarde: cuando se apruebe, el acceso se habilita solo.',
  'pending.refresh': 'Verificar de nuevo',
  'blocked.title': 'Cuenta bloqueada',
  'blocked.body': 'Tu cuenta está bloqueada. Hablá con el equipo de Tele dos Pampas para saber el motivo.',
  'support.whatsapp': 'Hablar con el equipo por WhatsApp',
}
