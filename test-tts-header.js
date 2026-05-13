const textToSpeech = require('@google-cloud/text-to-speech');
const client = new textToSpeech.TextToSpeechClient({
  credentials: require('./firebase-service-account.json')
});
async function test() {
  const [response] = await client.synthesizeSpeech({
    input: {text: 'hello'},
    voice: {languageCode: 'en-US', name: 'en-US-Standard-A'},
    audioConfig: {audioEncoding: 'LINEAR16'},
  });
  const buf = response.audioContent;
  console.log("Length:", buf.length);
  console.log("First 44 bytes:", buf.slice(0, 44).toString('hex'));
  console.log("Starts with RIFF?", buf.slice(0, 4).toString('utf8') === 'RIFF');
}
test().catch(console.error);
