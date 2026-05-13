const orig = Buffer.from("hello world");
const b = Buffer.from(orig, "base64");
console.log(b.toString());
console.log(orig.equals(b));
