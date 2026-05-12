const textToSpeech = require('@google-cloud/text-to-speech');
const client = new textToSpeech.TextToSpeechClient({
  credentials: require('./firebase-service-account.json')
});
console.log("Client created");
async function test() {
  const [response] = await client.synthesizeSpeech({
    input: {text: 'hello'},
    voice: {languageCode: 'en-US', name: 'en-US-Standard-A'},
    audioConfig: {audioEncoding: 'LINEAR16'},
  });
  console.log(typeof response.audioContent);
  console.log(Buffer.isBuffer(response.audioContent) ? "Is Buffer" : "Not Buffer");
  console.log(response.audioContent instanceof Uint8Array ? "Is Uint8Array" : "Not Uint8Array");
}
test().catch(console.error);
