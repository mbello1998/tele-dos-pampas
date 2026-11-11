# Login por e-mail: o que configurar no Supabase

O app pede um **código de 6 dígitos** (`verifyOtp` com `type: 'email'`, em `src/lib/auth/login-method.ts`).
O Supabase, por padrão, manda um **link** — por isso o login não fecha: chega um e-mail com link, e a tela
está esperando um número. E o link aponta para `localhost` porque a URL do site nunca foi trocada depois
da publicação.

São três mudanças no painel, todas em https://supabase.com/dashboard/project/xgrhaewlmbbopnvjicgz

---

## 1. A URL do site (é o que manda o link para localhost)

**Authentication → URL Configuration**

- **Site URL:** `https://tele-dos-pampas.netlify.app`
- **Redirect URLs:** adicione as duas, uma por linha:
  - `https://tele-dos-pampas.netlify.app/**`
  - `http://localhost:3000/**`  ← mantenha, é o desenvolvimento

A segunda linha é o que permite continuar testando na máquina. Sem ela, o login local para de funcionar.

---

## 2. O template de quem está criando conta

**Authentication → Emails → Templates → "Confirm signup"**

**Subject:** `Seu código: {{ .Token }}`

O corpo inteiro vai abaixo. O que importa é o `{{ .Token }}`: é ele que faz o Supabase mandar CÓDIGO em vez
de link. Sem essa variável no corpo, ele manda o link, não importa o que o app peça.

```html
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0B0F0D;color:#ffffff;border-radius:12px">
  <p style="margin:0 0 4px;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#F2A516">Tele dos Pampas</p>
  <h1 style="margin:0 0 16px;font-size:24px;line-height:1.2">Seu código de entrada</h1>
  <p style="margin:0 0 8px;font-size:16px;color:rgba(255,255,255,.75)">Digite este código no aplicativo:</p>
  <p style="margin:0 0 20px;font-size:40px;font-weight:800;letter-spacing:.18em;color:#F2A516">{{ .Token }}</p>
  <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,.6)">
    O código vale por 1 hora. Se você não pediu, pode ignorar este e-mail.
  </p>
  <hr style="border:0;border-top:1px solid rgba(255,255,255,.15);margin:20px 0">
  <p style="margin:0 0 4px;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#F2A516">Español</p>
  <p style="margin:0;font-size:14px;color:rgba(255,255,255,.75)">
    Escribí este código en la aplicación. Vale por 1 hora. Si no lo pediste, ignorá este correo.
  </p>
</div>
```

---

## 3. O template de quem já tem conta

**Authentication → Emails → Templates → "Magic Link"**

Mesmo assunto e mesmo corpo do item 2. O app usa a mesma chamada (`signInWithOtp` com
`shouldCreateUser: true`): quem não tem conta recebe o "Confirm signup", quem já tem recebe o "Magic Link".
Se só um dos dois for corrigido, metade das pessoas continua travada — e é a metade difícil de descobrir,
porque depende de a pessoa já existir ou não.

---

## 4. O que AINDA não vai funcionar, e por quê

Corrigir os templates faz o código chegar. Mas o remetente padrão do Supabase **só entrega para membros do
projeto** e tem limite de poucos e-mails por hora. Ou seja: você vai receber, e um cliente de Quaraí não.

Para valer de verdade, falta configurar um SMTP próprio em **Project Settings → Authentication → SMTP
Settings**. Serviços gratuitos que servem: Resend, Brevo, Mailgun. É cadastrar, verificar um domínio (ou usar
o domínio de testes do serviço) e colar quatro campos.

**Vale pensar em SMS em vez de e-mail.** `src/lib/auth/login-method.ts` já tem o caminho de telefone escrito
(`phoneMethod`): é trocar `NEXT_PUBLIC_LOGIN_METHOD` para `phone` e configurar um provedor no Supabase. Em
Quaraí e Artigas, número de celular é o que as pessoas têm e usam; e-mail nem todo mundo abre. O custo é que
SMS é pago.
