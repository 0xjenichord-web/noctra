function processData(userData) {
  // Kerentanan 1: Penggunaan eval yang berbahaya
  const result = eval(userData);
  return result;
}

function updateUI(data) {
  // Kerentanan 2: XSS melalui innerHTML
  document.getElementById('output').innerHTML = data;
}
