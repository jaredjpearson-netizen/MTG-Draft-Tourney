// Config for the "tournament started" welcome/toll-fee email — separate from
// emailjs-config.js (which handles the "it's your turn to pick" emails), since
// they use a different EmailJS template. Both can share the same EmailJS
// account or use different ones; either way, keeping them in separate files
// means updating one never risks overwriting the other.

const tournamentStartEmailConfig = {
  publicKey: "Mbtx59DrPenk6T6Od",
  serviceId: "service_kfh50w8",
  templateId: "template_zhm5ere",
};
