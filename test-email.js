// =====================================================================
//  Sends ONE test email using the settings in config.json, and says
//  in plain words whether it worked.
//
//  Run it from the tracker folder with:   node test-email.js
//  (The tracker itself can keep running while you do this.)
// =====================================================================

const fs = require('fs');
const path = require('path');

function stop(message) {
  console.log('\n' + message + '\n');
  process.exit(1);
}

// 1. Read config.json
const configFile = path.join(__dirname, 'config.json');
if (!fs.existsSync(configFile)) stop('No config.json found in this folder. Make sure you are in the it-asset-tracker folder (the one with server.js).');
let config;
try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
catch (e) { stop('config.json has a typing mistake in it (often a missing quote mark or comma):\n  ' + e.message); }
const email = config.email || {};

// 2. Check the settings are filled in
const missing = ['host', 'from', 'to'].filter(k => !email[k] || String(email[k]).includes('yourcompany.com'));
if (missing.length) stop(`Please fill in these settings in config.json first: ${missing.join(', ')}\n(They still have the example "yourcompany.com" values or are empty.)`);

// 3. Make sure the email add-on is installed
let nodemailer;
try { nodemailer = require('nodemailer'); }
catch (e) { stop('The email add-on is not installed yet. In this folder, run:\n  npm install\nthen try again.'); }

// 4. Send the test
console.log(`\nSending a test email...\n  From: ${email.from}\n  To:   ${email.to}\n  Mail server: ${email.host}, port ${email.port || 25}\n`);
const mailer = nodemailer.createTransport({
  host: email.host,
  port: email.port || 25,
  secure: !!email.secure,
  auth: email.user ? { user: email.user, pass: email.pass } : undefined,
  connectionTimeout: 15000
});

mailer.sendMail({
  from: email.from,
  to: email.to,
  subject: (email.subject || 'low inventory') + ' (TEST)',
  text: 'This is a test email from the IT Asset Tracker.\n\n' +
        'If you received this, email is set up correctly. Real alerts will look like:\n' +
        'According to our current inventory, we are down to 2 Headsets.'
}).then(() => {
  console.log('SUCCESS: the mail server accepted the test email. Check the inbox for ' + email.to +
              ' (and the Junk folder) in the next minute or two.\n');
}).catch(err => {
  const msg = String(err.message || err);
  let hint = '';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) hint = 'The mail server name (host) was not found. Check the spelling of "host".';
  else if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) hint = 'Could not connect to the mail server. The port may be wrong, or the network/firewall is blocking it. IT can tell you the right host and port.';
  else if (/auth|535|534|Username and Password/i.test(msg)) hint = 'The mail server rejected the user name or password. Check "user" and "pass".';
  else if (/relay|550|554|not permitted|denied/i.test(msg)) hint = 'The mail server refused to send it. This computer may not be allowed to send through it, or the "from" address is not allowed. Ask IT.';
  else if (/certificate|SSL|TLS|wrong version/i.test(msg)) hint = 'Security setting mismatch. Usually: port 465 needs "secure": true, and ports 25 or 587 need "secure": false.';
  stop('FAILED: the test email was not sent.\n  ' + (hint || 'See the technical message below.') + '\n  Technical message: ' + msg);
});
