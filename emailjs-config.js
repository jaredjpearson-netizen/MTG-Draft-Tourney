// EmailJS sends the "it's your turn to pick" emails, directly from the
// browser — no backend server needed. Free tier covers 200 emails/month.
//
// Setup (~5 min):
// 1. Create a free account at https://www.emailjs.com
// 2. Email Services → Add New Service → connect Gmail/Outlook/etc.
//    Copy the Service ID it gives you.
// 3. Email Templates → Create New Template. Use these variables in the
//    template body: {{to_email}}, {{player_name}}, {{event_name}}, {{event_link}}
//    e.g. "Hi {{player_name}}, it's your turn to pick a prize in
//    {{event_name}}! Open the draft: {{event_link}}"
//    Copy the Template ID.
// 4. Account → General → copy your Public Key.
// 5. Paste all three values below.
//
// If these are left as placeholders, the app simply skips sending emails
// (everything else still works fine without them).

const emailjsConfig = {
  publicKey: "YOUR_PUBLIC_KEY",
  serviceId: "YOUR_SERVICE_ID",
  templateId: "YOUR_TEMPLATE_ID",
};
