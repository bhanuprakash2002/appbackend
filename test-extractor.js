const textToSpeech = require('@google-cloud/text-to-speech');
const client = new textToSpeech.TextToSpeechClient({
  credentials: require('./firebase-service-account.json')
});

function extractWavData(buffer) {
  let offset = 12; // skip RIFF header
  while (offset < buffer.length) {
    const chunkId = buffer.toString('utf8', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return buffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  return buffer; // fallback
}

async function test() {
  const [response] = await client.synthesizeSpeech({
    input: {text: 'hello'},
    voice: {languageCode: 'en-US', name: 'en-US-Standard-A'},
    audioConfig: {audioEncoding: 'MULAW', sampleRateHertz: 8000},
  });
  const buf = response.audioContent;
  const dataBuf = extractWavData(buf);
  console.log("Original Length:", buf.length);
  console.log("Data Length:", dataBuf.length);
  console.log("Difference (Header size):", buf.length - dataBuf.length);
}
test().catch(console.error);
