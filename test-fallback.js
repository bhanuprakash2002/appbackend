const textToSpeech = require('@google-cloud/text-to-speech');
const client = new textToSpeech.TextToSpeechClient({
  credentials: require('./firebase-service-account.json'),
  fallback: true
});
async function test() {
  const [response] = await client.synthesizeSpeech({
    input: {text: 'hello'},
    voice: {languageCode: 'en-US', name: 'en-US-Standard-A'},
    audioConfig: {audioEncoding: 'MULAW', sampleRateHertz: 8000},
  });
  console.log("Success with fallback. Length:", response.audioContent.length);
}
test().catch(console.error);
