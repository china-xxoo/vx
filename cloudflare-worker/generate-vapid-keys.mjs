const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

function b64urlToBytes(value) {
  const text = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(text), char => char.charCodeAt(0));
}

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const publicKey = new Uint8Array(65);
publicKey[0] = 4;
publicKey.set(b64urlToBytes(publicJwk.x), 1);
publicKey.set(b64urlToBytes(publicJwk.y), 33);

console.log("VAPID_PUBLIC_KEY=" + bytesToB64url(publicKey));
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify(privateJwk));
console.log("PUSH_SECRET=" + crypto.randomUUID() + crypto.randomUUID().replace(/-/g, ""));
