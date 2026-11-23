// Catàleg de serveis disponibles. Cada servei es pot afegir tantes vegades com es vulgui:
// cada instància té la seva pròpia sessió aïllada (cookies, localStorage, IndexedDB...).
module.exports = [
  { type: 'whatsapp',     name: 'WhatsApp Web',               url: 'https://web.whatsapp.com/',               color: '#25D366' },
  { type: 'instagram',    name: 'Instagram',                  url: 'https://www.instagram.com/',              color: '#E1306C' },
  { type: 'instagram-dm', name: 'Instagram Missatges Directes', url: 'https://www.instagram.com/direct/inbox/', color: '#C13584' },
  { type: 'outlook',      name: 'Outlook',                    url: 'https://outlook.live.com/mail/',          color: '#0078D4',
    hint: 'Per a comptes d\'empresa/escola canvia-ho a https://outlook.office.com/mail/' },
  { type: 'roundcube',    name: 'RoundCube',                  url: '',                                        color: '#37BEFF',
    requiresUrl: true, hint: 'URL del teu webmail, p. ex. https://elteudomini.cat:2096/ o https://webmail.elteudomini.cat/' },
  { type: 'yahoo',        name: 'Yahoo Mail',                 url: 'https://mail.yahoo.com/',                 color: '#6001D2' },
  { type: 'claude',       name: 'Claude',                     url: 'https://claude.ai/',                      color: '#D97757' },
  { type: 'ytmusic',      name: 'YouTube Music',              url: 'https://music.youtube.com/',              color: '#FF0000' },
  { type: 'discord',      name: 'Discord',                    url: 'https://discord.com/app',                 color: '#5865F2' },
  { type: 'gmail',        name: 'Gmail',                      url: 'https://mail.google.com/',                color: '#EA4335' },
  { type: 'gdrive',       name: 'Google Drive',               url: 'https://drive.google.com/',               color: '#1FA463' },
  { type: 'chatgpt',      name: 'ChatGPT',                    url: 'https://chatgpt.com/',                    color: '#10A37F' },
  { type: 'custom',       name: 'Web personalitzada',         url: '',                                        color: '#607D8B',
    requiresUrl: true, hint: 'Qualsevol web: https://...' }
];
