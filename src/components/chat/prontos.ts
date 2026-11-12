import type { Locale } from '@/lib/money/format'

/**
 * TEXTOS PRONTOS.
 *
 * Não é conveniência: é segurança. O motoboy está de capacete, de luva, muitas vezes parado no sol com a
 * moto ligada. Digitar "furei o pneu, estou resolvendo e já vou" numa tela de celular nessa situação é o
 * tipo de coisa que acaba sendo feita andando — e aí o chat vira um perigo em vez de uma ajuda.
 *
 * Um toque, mensagem enviada. Por isso são frases INTEIRAS e específicas, não pedaços para montar: "a
 * caminho" não diz nada, "furei o pneu, resolvendo e já vou" diz tudo e evita a ligação.
 *
 * As listas são diferentes dos dois lados porque os problemas são diferentes: o motoboy avisa atraso e
 * problema mecânico; o cliente dá instrução de porta e diz que não foi visto.
 */

export type Pronto = {
  /** O texto que vai como mensagem. */
  texto: string
  /** O rótulo curto do botão. Mais curto que a mensagem: o botão é lido de relance. */
  rotulo: string
  /** Avisos de problema ganham destaque: são os que a outra pessoa precisa ler agora. */
  urgente?: boolean
}

export const PRONTOS_MOTOBOY: Record<Locale, Pronto[]> = {
  'pt-BR': [
    { rotulo: 'Pneu furou', texto: 'Furei o pneu. Estou resolvendo e já sigo.', urgente: true },
    { rotulo: 'Trânsito', texto: 'Peguei trânsito no caminho, vou demorar um pouco mais.' },
    { rotulo: 'Cheguei', texto: 'Cheguei, estou na frente.' },
    { rotulo: 'Não te achei', texto: 'Estou no endereço e não encontrei você. Pode me dizer uma referência?' },
    { rotulo: 'Já estou indo', texto: 'Saí agora, estou a caminho.' },
    { rotulo: 'Ponte parada', texto: 'A fila da ponte está parada. Assim que andar eu sigo.' },
  ],
  'es-UY': [
    { rotulo: 'Pinché', texto: 'Pinché una goma. Lo estoy resolviendo y sigo.', urgente: true },
    { rotulo: 'Tránsito', texto: 'Agarré tránsito en el camino, voy a demorar un poco más.' },
    { rotulo: 'Llegué', texto: 'Llegué, estoy en la puerta.' },
    { rotulo: 'No te encontré', texto: 'Estoy en la dirección y no te encontré. ¿Me pasás una referencia?' },
    { rotulo: 'Ya salgo', texto: 'Salí ahora, estoy en camino.' },
    { rotulo: 'Puente parado', texto: 'La fila del puente está parada. Apenas avance, sigo.' },
  ],
}

export const PRONTOS_CLIENTE: Record<Locale, Pronto[]> = {
  'pt-BR': [
    { rotulo: 'Passou por mim', texto: 'Você passou por mim e não me viu. Estou na calçada acenando.', urgente: true },
    { rotulo: 'Estou na frente', texto: 'Estou esperando na frente.' },
    { rotulo: 'Toca a campainha', texto: 'Pode tocar a campainha quando chegar.' },
    { rotulo: 'Portão da rua', texto: 'Me espera no portão da rua, já desço.' },
    { rotulo: 'Deixa com vizinho', texto: 'Se eu não atender, pode deixar com o vizinho do lado.' },
    { rotulo: 'Dois minutos', texto: 'Me dá dois minutos que já estou descendo.' },
  ],
  'es-UY': [
    { rotulo: 'Pasaste', texto: 'Pasaste y no me viste. Estoy en la vereda haciéndote señas.', urgente: true },
    { rotulo: 'Estoy afuera', texto: 'Estoy esperando afuera.' },
    { rotulo: 'Tocá timbre', texto: 'Podés tocar el timbre cuando llegues.' },
    { rotulo: 'Portón', texto: 'Esperame en el portón, ya bajo.' },
    { rotulo: 'Dejá al vecino', texto: 'Si no atiendo, podés dejarlo con el vecino de al lado.' },
    { rotulo: 'Dos minutos', texto: 'Dame dos minutos que ya bajo.' },
  ],
}
