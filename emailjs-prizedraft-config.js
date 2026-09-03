// Config for the "it's your turn to pick" prize-draft notification emails —
// separate from emailjs-start-config.js (which handles the "tournament
// started" welcome email), since they use different EmailJS templates.
// Both use the mtgdrafttourneybot@gmail.com service, but are kept in
// separate files so updating one never risks overwriting the other.

const emailjsConfig = {
  publicKey: "Mbtx59DrPenk6T6Od",
  serviceId: "service_kfh50w8",
  templateId: "template_dr2ichh",
};
