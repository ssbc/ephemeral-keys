const level = require('level')
var db = level('./db')

const sodium = require('sodium-native')
const hmac = require('hmac-blake2b')
const secretBox = sodium.crypto_secretbox_easy
const secretBoxOpen = sodium.crypto_secretbox_open_easy
const NONCEBYTES = sodium.crypto_secretbox_NONCEBYTES
const KEYBYTES = sodium.crypto_secretbox_KEYBYTES
const zero = sodium.sodium_memzero

const concat = Buffer.concat
const curve = 'ed25519'

function randomBytes (n) {
  var b = Buffer.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

function genericHash (msg) {
  var hash = sodium.sodium_malloc(sodium.crypto_generichash_BYTES_MAX)
  sodium.crypto_generichash(hash, msg)
  return hash
}

function scalarMult (sk, pk) {
  var result = sodium.sodium_malloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult(result, sk, pk)
  return result
}

function keyPair () {
  var ephKeypair = {}
  ephKeypair.publicKey = sodium.sodium_malloc(KEYBYTES)
  ephKeypair.secretKey = sodium.sodium_malloc(KEYBYTES)
  sodium.crypto_box_keypair(ephKeypair.publicKey, ephKeypair.secretKey)
  return ephKeypair
}

const packKey = k => k.toString('base64') + '.' + curve
const unpackKey = k => Buffer.from(k.slice(0, -curve.length - 1), 'base64')

module.exports = {

  generateAndStore: function (dbKey, callback) {
    const ephKeypairBuffer = keyPair()
    var ephKeypair = {}

    for (var k in ephKeypairBuffer) ephKeypair[k] = packKey(ephKeypairBuffer[k])

    db.put(dbKey, ephKeypair, {valueEncoding: 'json'}, (err) => {
      if (err) return callback(err)
      callback(null, ephKeypair.publicKey)
    })
  },

  boxMessage: function (message, pubKeyBase64, contextMessageString) {
    // TODO: handle empty contextMessage
    const contextMessage = Buffer.from(contextMessageString, 'utf-8')
    const messageBuffer = Buffer.from(message, 'utf-8')
    const pubKey = unpackKey(pubKeyBase64)
    var boxed = Buffer.alloc(messageBuffer.length + sodium.crypto_secretbox_MACBYTES)
    const ephKeypair = keyPair()
    const nonce = randomBytes(NONCEBYTES)

    var sharedSecret = sodium.sodium_malloc(hmac.BYTES)
    hmac(sharedSecret,
      concat([ ephKeypair.publicKey, pubKey, contextMessage ]),
      genericHash(scalarMult(ephKeypair.secretKey, pubKey)))

    secretBox(boxed, messageBuffer, nonce, sharedSecret)

    zero(sharedSecret)
    zero(ephKeypair.secretKey)

    return concat([nonce, ephKeypair.publicKey, boxed])
  },

  unBoxMessage: function (dbKey, cipherText, contextMessageString, callback) {
    db.get(dbKey, {valueEncoding: 'json'}, (err, ephKeypairBase64) => {
      if (err) return callback(err)
      const contextMessage = Buffer.from(contextMessageString, 'utf-8')
      var ephKeypair = {}
      for (var k in ephKeypairBase64) ephKeypair[k] = unpackKey(ephKeypairBase64[k])
      const nonce = cipherText.slice(0, NONCEBYTES)
      const pubKey = cipherText.slice(NONCEBYTES, NONCEBYTES + KEYBYTES)
      const box = cipherText.slice(NONCEBYTES + KEYBYTES, cipherText.length)
      var unboxed = Buffer.alloc(box.length - sodium.crypto_secretbox_MACBYTES)

      var sharedSecret = sodium.sodium_malloc(hmac.BYTES)
      hmac(sharedSecret,
        concat([ pubKey, ephKeypair.publicKey, contextMessage ]),
        genericHash(scalarMult(ephKeypair.secretKey, pubKey)))

      const success = secretBoxOpen(unboxed, box, nonce, sharedSecret)
      zero(sharedSecret)
      zero(ephKeypair.secretKey)
      zero(ephKeypair.publicKey)

      if (!success) {
        callback(new Error('Decryption failed'))
      } else {
        callback(null, unboxed.toString())
      }
    })
  },

  deleteKeyPair: function (dbKey, callback) {
    db.del(dbKey, (err) => {
      if (err) return callback(err)
      callback()
    })
  }
}
