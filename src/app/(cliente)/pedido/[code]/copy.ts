// Textos da tela de rastreio. Ficam locais porque `t()` é tipada pelas chaves da Tarefa 8 e esta tela ainda não
// tem as suas lá. Lista do que dobrar para src/lib/i18n depois: tudo neste arquivo (chaves `tracking.*`).
// Regra de conteúdo: o horário de serviço (06:00 às 00:00) é regra do município sobre o serviço; a ponte é aberta
// 24 horas e NENHUM texto daqui a apresenta como limite de horário.
import type { Locale } from '@/lib/i18n'

export type TrackingCopy = {
  order: string
  statusLabels: Record<string, string>
  searchingTitle: string
  searchingHint: string
  waitingSignal: string
  waitingSignalHint: string
  deliveredTitle: string
  cancelledTitle: string
  cancelReason: string
  timelineTitle: string
  timelineEmpty: string
  pickup: string
  dropoff: string
  crossesBorder: string
  eta: string
  liveDegraded: string
  map: { unavailable: string; courier: string; distance: string; showMap: string; destination: string }
}

const ptBR: TrackingCopy = {
  order: 'Pedido',
  statusLabels: {
    criado: 'Pedido recebido',
    aguardando_loja: 'Aguardando o restaurante',
    em_preparo: 'Em preparo',
    pronto: 'Pronto para retirada',
    aguardando_motoboy: 'Procurando motoboy',
    aceito: 'Motoboy a caminho',
    motoboy_chegou: 'Motoboy chegou',
    coletado: 'Pedido coletado',
    em_rota: 'A caminho de você',
    em_viagem: 'Em viagem',
    entregue: 'Entregue',
    finalizado: 'Corrida finalizada',
    cancelado: 'Cancelado',
  },
  searchingTitle: 'Procurando um motoboy perto de você',
  searchingHint: 'Costuma levar poucos minutos. Você pode fechar esta tela: avisamos quando alguém aceitar.',
  waitingSignal: 'Aguardando o sinal do motoboy',
  waitingSignalHint: 'Assim que ele ligar a localização, a moto aparece no mapa. O andamento do pedido continua abaixo.',
  deliveredTitle: 'Tudo certo, o pedido foi entregue.',
  cancelledTitle: 'Este pedido foi cancelado.',
  cancelReason: 'Motivo',
  timelineTitle: 'Andamento',
  timelineEmpty: 'Aguardando o primeiro registro do pedido.',
  pickup: 'Retirada',
  dropoff: 'Entrega',
  crossesBorder: 'Este pedido atravessa a ponte entre as duas cidades.',
  eta: 'Previsão',
  liveDegraded: 'Sem conexão ao vivo: atualizando de tempos em tempos.',
  map: {
    unavailable: 'Mapa indisponível agora',
    courier: 'Motoboy',
    distance: 'Motoboy a {m} do destino',
    showMap: 'Mostrar o mapa',
    destination: 'Destino',
  },
}

const esUY: TrackingCopy = {
  order: 'Pedido',
  statusLabels: {
    criado: 'Pedido recibido',
    aguardando_loja: 'Esperando al comercio',
    em_preparo: 'En preparación',
    pronto: 'Listo para retirar',
    aguardando_motoboy: 'Buscando motoboy',
    aceito: 'El motoboy va en camino',
    motoboy_chegou: 'El motoboy llegó',
    coletado: 'Pedido retirado',
    em_rota: 'En camino hacia vos',
    em_viagem: 'En viaje',
    entregue: 'Entregado',
    finalizado: 'Viaje finalizado',
    cancelado: 'Cancelado',
  },
  searchingTitle: 'Buscando un motoboy cerca de vos',
  searchingHint: 'Suele llevar pocos minutos. Podés cerrar esta pantalla: te avisamos cuando alguien acepte.',
  waitingSignal: 'Esperando la señal del motoboy',
  waitingSignalHint: 'Apenas active la ubicación, la moto aparece en el mapa. El avance del pedido sigue abajo.',
  deliveredTitle: 'Todo bien, el pedido fue entregado.',
  cancelledTitle: 'Este pedido fue cancelado.',
  cancelReason: 'Motivo',
  timelineTitle: 'Avance',
  timelineEmpty: 'Esperando el primer registro del pedido.',
  pickup: 'Retiro',
  dropoff: 'Entrega',
  crossesBorder: 'Este pedido cruza el puente entre las dos ciudades.',
  eta: 'Estimado',
  liveDegraded: 'Sin conexión en vivo: actualizando cada tanto.',
  map: {
    unavailable: 'Mapa no disponible ahora',
    courier: 'Motoboy',
    distance: 'Motoboy a {m} del destino',
    showMap: 'Mostrar el mapa',
    destination: 'Destino',
  },
}

export const trackingCopy = (locale: Locale): TrackingCopy => (locale === 'es-UY' ? esUY : ptBR)
