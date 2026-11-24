// --- SKENARIO 1: AMAN (False Positive yang diabaikan oleh Taint Analysis) ---
const safeMath = "2 + 2";
const result1 = eval(safeMath); // Noctra Taint TIDAK akan menandai ini (Aman!)

// --- SKENARIO 2: BERBAHAYA (Taint Flow terdeteksi!) ---
// Simulasi input dari user (SOURCE)
const userInput = req.body.expression; 

// Data berbahaya mengalir ke fungsi berbahaya (SINK)
const result2 = eval(userInput); // Noctra Taint AKAN menandai ini CRITICAL!

// --- SKENARIO 3: BERBAHAYA (DOM XSS) ---
const userHtml = req.query.content;
document.getElementById('output').innerHTML = userHtml; // Noctra Taint AKAN menandai ini HIGH!
