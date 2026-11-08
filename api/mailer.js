// Sends emails (invites and "forgot password" links), but only if it has been set up. Without it,
// admins share invite and reset links themselves, by text or any messaging app.
//
// To turn it on, add to .env:
//   SMTP_URL=smtps://you%40gmail.com:app-password@smtp.gmail.com:465   (any mail provider's SMTP)
//   MAIL_FROM=Family Health Planner <you@gmail.com>
//   APP_URL=https://planner.example.com    (the address people use, for the links in emails)
//
// APP_URL is needed because links in emails can't be built from the request: someone could send
// a request with a fake "Host" and get a reset email with a link to their own site.
let transport = null;
let problem = '';

function configured() {
  return !!(process.env.SMTP_URL && process.env.MAIL_FROM && process.env.APP_URL);
}

function getTransport() {
  if (transport) return transport;
  try {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport(process.env.SMTP_URL);
  } catch (e) {
    problem = 'nodemailer is not installed';
  }
  return transport;
}

// A full link from a path, like "/login?join=abc" -> "https://planner.example.com/login?join=abc".
function link(pathAndQuery) {
  return String(process.env.APP_URL || '').replace(/\/+$/, '') + pathAndQuery;
}

// Sends one plain-text email. Resolves to true if it was handed to the mail server.
async function send(to, subject, text) {
  if (!configured()) return false;
  const t = getTransport();
  if (!t) {
    console.error('mail:', problem);
    return false;
  }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
    return true;
  } catch (e) {
    console.error('mail: could not send:', e.message);
    return false;
  }
}

module.exports = { configured, send, link };
