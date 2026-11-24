// Contoh kerentanan Prototype Pollution yang berbahaya

function merge(target, source) {
  for (const key in source) {
    // VULNERABLE: Tidak memfilter __proto__ atau constructor
    target[key] = source[key];
  }
}

// Serangan 1: Melalui __proto__
const userInput1 = JSON.parse('{"__proto__":{"isAdmin":true}}');
const config1 = {};
merge(config1, userInput1);
console.log({}.isAdmin); // true! Semua object sekarang isAdmin

// Serangan 2: Melalui constructor.prototype
const userInput2 = JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}');
const config2 = {};
merge(config2, userInput2);

// Serangan 3: Object.assign yang tidak aman
function unsafeMerge(data) {
  const defaults = { role: 'user' };
  return Object.assign(defaults, data); // Berbahaya jika data dari user!
}

// Pemicu langsung untuk menguji AST Rule (Akan terdeteksi!)
const testObj = {};
testObj.__proto__.isAdmin = true;
testObj.constructor.prototype.isAdmin = true;
