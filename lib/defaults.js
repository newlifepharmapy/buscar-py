// Textos, cores, links, cotação e câmeras padrão do site. O painel admin (/admin) edita uma cópia
// destes valores, gravada em DATA_DIR/settings.json; o que não estiver lá vem daqui.
"use strict";

module.exports = {
  brand: {
    name1: "Buscar",
    name2: "PY",
    blue: "#0038a8",
    red: "#d52b1e",
    logo: "", // imagem opcional (data URL PNG, JPEG ou WEBP) no lugar do ícone padrão
  },
  seo: {
    title: "Buscar PY · Compare preços no Paraguai e busque por foto",
    description: "Compare preços de lojas do Paraguai em Ciudad del Este, Pedro Juan Caballero, Salto del Guairá e Asunción. Busque por nome ou por foto do produto.",
  },
  topbar: {
    message: "Preços de 12 lojas em Ciudad del Este, Pedro Juan Caballero, Salto del Guairá e Asunción",
    links: [
      { label: "Câmeras da Ponte ao vivo", url: "/cameras", live: true, newTab: false },
    ],
  },
  home: {
    eyebrow: "Comparador de preços do Paraguai",
    title: "Encontre o menor preço antes de cruzar a ponte",
    lead: "Compare o mesmo produto em várias lojas, veja o valor em dólar, real e guarani e acompanhe o histórico de preço.",
    photoTitle: "Tem uma foto do produto?",
    photoText: "Envie a imagem e mostramos os produtos mais parecidos e onde estão mais baratos.",
    photoButton: "Enviar foto",
    photoFine: "Também dá para arrastar a imagem para cá ou colar com Ctrl+V.",
    howTitle: "Como funciona",
    steps: [
      { title: "Busque pelo nome ou pela foto", text: "Digite em português ou espanhol, ou envie uma imagem do produto. Erros de digitação e acentos não atrapalham." },
      { title: "Compare as lojas", text: "Veja o menor preço, a loja que vende, a cidade e quanto você economiza em relação à loja mais cara." },
      { title: "Confira o histórico", text: "O gráfico de 26 semanas mostra se o preço de hoje está bom antes de você ir até a loja." },
    ],
  },
  footer: {
    about: "Comparador de preços de lojas do Paraguai, com busca por texto e por imagem.",
    note: "Preços em dólar americano. Valores em real e guarani usam a cotação indicada no topo da página.",
  },
  rates: {
    auto: true,  // true: cotação do Google atualizada a cada 5 minutos; false: valores abaixo
    BRL: 5.35,   // R$ por US$ 1 (usado quando a atualização automática está desligada ou ainda não rodou)
    PYG: 5800,   // ₲ por US$ 1 (referência de out/2026)
  },
  cameras: {
    title: "Câmeras da Ponte ao vivo",
    intro: "Acompanhe o trânsito na Ponte da Amizade em tempo real, antes de sair de casa.",
    credit: "Fonte: Portal da Cidade", // aparece embaixo de cada câmera
    tips: [
      "Horários de pico: 07:00 às 09:00 (sentido Paraguai) e 16:00 às 18:00 (sentido Brasil).",
      "Tenha seus documentos (RG ou passaporte) sempre em mãos.",
      "Respeite os limites da cota de compras no exterior.",
    ],
    list: [
      {
        name: "Ponte da Amizade - Sentido Paraguai",
        url: "https://playerv.logicahost.com.br/video-ip-camera/portaldacidade//false/false/Wkcxc2ExcFhPSGROYVRWellqSmtjRmt5Um05aU0wNHdURzFPZG1KVE5XbGpaejA5KzM=/16:9/YUhSMGNITTZMeTg9K1o=/fozpontedaamizadesentidoparaguai.stream/?autoplay=1&muted=1&playsinline=1",
      },
      {
        name: "Aduana Brasileira",
        url: "https://playerv.logicahost.com.br/video-ip-camera/portaldacidade//false/false/ZG1sa1pXOHdNaTVzYjJkcFkyRm9iM04wTG1OdmJTNWljZz09K1o=/16:9/WVVoU01HTklUVFpNZVRnOSsz/fozaduanapontedaamizade.stream/?autoplay=1&muted=1&playsinline=1",
      },
      {
        name: "Ponte da Amizade - Sentido Brasil",
        url: "https://playerv.logicahost.com.br/video-ip-camera/portaldacidade//false/false/Wkcxc2ExcFhPSGROYVRWellqSmtjRmt5Um05aU0wNHdURzFPZG1KVE5XbGpaejA5KzM=/16:9/V1ZWb1UwMUhUa2xVVkZwTlpWUm5PUT09K1I=/fozpontedaamizadesentidobrasil.stream/?autoplay=1&muted=1&playsinline=1",
      },
    ],
  },
};
