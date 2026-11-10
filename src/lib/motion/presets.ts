// Todos os tweens da landing moram aqui, num lugar só, para a regra de desempenho ser auditável:
// só `transform` (x, y, scale, rotation) e `opacity`. O teste de motion.test.tsx lê este arquivo
// em tempo de execução e reprova qualquer outra propriedade.
//
// Única exceção, e só no desenho da malha: `strokeDashoffset`. Repinta um SVG mas não dispara
// layout. É o que "desenha a rua"; sem ela a malha só poderia aparecer, não se construir.
type Vars = Record<string, string | number | boolean | Record<string, unknown>>
export type Preset = { from?: Vars; to?: Vars; set?: Vars }

export const presets = {
  /** Bloco que sobe e aparece ao entrar na tela. */
  reveal: {
    from: { opacity: 0, y: 28 },
    to: { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' },
  },
  /** Divisor guarda pampa que se estende da esquerda para a direita. */
  draw: {
    from: { scaleX: 0, transformOrigin: '0% 50%' },
    to: { scaleX: 1, duration: 0.9, ease: 'power2.inOut' },
  },
  /** Poster do hero escurece quando a malha real começa a ser desenhada por cima. */
  posterDim: {
    to: { opacity: 0.16, duration: 0.5, ease: 'none' },
  },
  /** Rua se desenhando: o caminho tem pathLength=100, então 100 é "invisível" e 0 é "completo". */
  gridStroke: {
    from: { strokeDashoffset: 100 },
    to: { strokeDashoffset: 0, ease: 'none' },
  },
  /** Rio e rótulos entram por opacidade. */
  fade: {
    from: { opacity: 0 },
    to: { opacity: 1, ease: 'none' },
  },
  /** Rótulos de cidade entram subindo um pouco. */
  label: {
    from: { opacity: 0, y: 14 },
    to: { opacity: 1, y: 0, ease: 'power2.out' },
  },
  /** Marca que aparece na ponta da ponte. */
  dot: {
    from: { opacity: 0, scale: 0, transformOrigin: '50% 50%' },
    to: { opacity: 1, scale: 1, ease: 'back.out(2)' },
  },
} satisfies Record<string, Preset>
