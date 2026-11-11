// Classes compartilhadas pelas telas de conta e de pedido.
//
// AS CORES TÊM PAPEL, e é isso que estava faltando. Antes `sol` (âmbar) pintava botão, foco, link e destaque ao
// mesmo tempo, enquanto `rio` e `campo` nunca apareciam: a tela inteira virava preto com um laranja, sem dizer
// onde olhar. Agora cada cor faz uma coisa só:
//
//   sol    -> A ação da tela. UMA por tela. Se duas coisas são âmbar, nenhuma é a principal.
//   rio    -> Foco e informação. É o céu e o rio da arte, e estava sem uso.
//   campo  -> Deu certo ("Salvo").
//   brasa  -> Deu errado. Só isso. Erro que divide a cor com decoração deixa de assustar.
//
// E três superfícies em vez de uma (tokens.css): página, painel e poço. O campo editável é mais FUNDO que o
// painel, não mais claro — ele é cavado na superfície, não colado nela. É o degrau que faltava.
//
// 16px nos campos (abaixo disso o iOS dá zoom ao focar) e alvo de 48px: dedo de luva, moto parada no sol.

export const labelClass = 'mb-1.5 block text-sm font-semibold text-white'

/** O campo: cavado no painel (`bg-poco`), com o foco em `rio`. */
export const inputClass =
  'block min-h-12 w-full rounded-lg border border-borda bg-poco px-3 py-2 text-base text-white placeholder:text-white/35 transition-colors focus:border-rio focus:outline-none focus:ring-2 focus:ring-rio/50'

/**
 * SELECT precisa de fundo OPACO e opções pintadas à mão. O menu nativo é desenhado pelo sistema, não pelo CSS
 * da página: com fundo translúcido sobre escuro, vários aparelhos pintam a lista de branco e herdam o texto
 * branco — some tudo, e foi o que aconteceu com a escolha de cidade. `color-scheme: dark` ajuda, mas não basta
 * em todo lugar, então aqui vão as duas coisas explícitas.
 */
export const selectClass =
  'block min-h-12 w-full appearance-none rounded-lg border border-borda bg-poco px-3 py-2 pr-9 text-base text-white transition-colors focus:border-rio focus:outline-none focus:ring-2 focus:ring-rio/50 [&>option]:bg-superficie [&>option]:text-white'

/** A ação da tela. Uma por tela. */
export const primaryButtonClass =
  'inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-sol px-4 py-2 text-base font-bold text-noite transition-colors hover:bg-sol/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sol disabled:opacity-50'

/** Tudo o mais que se pode tocar. Nunca âmbar: senão disputa com a ação. */
export const secondaryButtonClass =
  'inline-flex min-h-12 items-center justify-center rounded-lg border border-borda-viva bg-superficie px-4 py-2 text-base font-medium text-white transition-colors hover:border-rio hover:bg-rio/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rio disabled:opacity-50'

/** O painel que agrupa campos. Um degrau acima da página, nunca branco translúcido. */
export const panelClass = 'rounded-xl border border-borda bg-superficie p-4'

/** Deu errado. A barra à esquerda existe para o erro ser achado sem ler: a cor sozinha não basta. */
export const errorClass =
  'mt-3 rounded-lg border border-brasa/50 border-l-4 border-l-brasa bg-brasa/10 px-3 py-2 text-sm text-white'

/** Informação, não erro. */
export const noticeClass =
  'mt-3 rounded-lg border border-rio/50 border-l-4 border-l-rio bg-rio/10 px-3 py-2 text-sm text-white'
