const { Translate } = require('@google-cloud/translate').v2;
const clientConfig = { projectId: 'test' };
const gTranslate = new Translate(clientConfig);
console.log(clientConfig);
