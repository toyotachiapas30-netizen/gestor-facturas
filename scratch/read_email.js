const { getAuthorizedClient, getGoogle } = require('../routes/drive');

async function test() {
  try {
    const client = getAuthorizedClient();
    if (!client) return console.log('Not authorized');
    const google = getGoogle();
    const gmail = google.gmail({ version: 'v1', auth: client });
    
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: '190565deff81bc39',
      format: 'full'
    });
    
    console.log('SUBJECT:', msg.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value);
    console.log('SNIPPET:', msg.data.snippet);
    
    function getGmailBody(payload) {
      let body = '';
      if (payload.body && payload.body.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf8');
      } else if (payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/html') {
            body = Buffer.from(part.body.data, 'base64').toString('utf8');
            break;
          } else if (part.mimeType === 'text/plain' && !body) {
            body = Buffer.from(part.body.data, 'base64').toString('utf8');
          } else if (part.parts) {
            body = getGmailBody(part);
            if (body) break;
          }
        }
      }
      return body;
    }
    
    console.log('BODY:', getGmailBody(msg.data.payload));
  } catch(e) {
    console.log('Error:', e.message);
  }
}

test();
