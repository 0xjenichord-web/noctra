# 🛡️ NOCTRA

> Independent security research and bug bounty intelligence system.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-285%20passing-brightgreen)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](#)

Noctra adalah *security scanner* modular berbasis CLI yang dirancang untuk mendeteksi kerentanan keamanan pada kode JavaScript/TypeScript. Berbeda dengan scanner berbasis Regex biasa, Noctra menggunakan **Abstract Syntax Tree (AST) Analysis** untuk memahami struktur kode secara mendalam, mengurangi *false positive* secara drastis.

Didukung oleh arsitektur **NEA (Noctra Engine Architecture)**, Noctra memungkinkan eksekusi multi-engine yang terstandarisasi, aman, dan dapat diperluas (*extensible*).

---

## ✨ Fitur Utama

- 🧠 **AST-Based Detection**: Menganalisis struktur kode (bukan sekadar teks) untuk mendeteksi *Prototype Pollution*, *XSS*, *Eval Injection*, dan lainnya dengan akurasi tinggi.
- 🏗️ **NEA Architecture**: Arsitektur modular di mana setiap fitur adalah "Engine" yang berkomunikasi melalui kontrak data yang ketat (*immutable* & *validated*).
- ⚡ **Multi-Engine Orchestration**: Menjalankan beberapa engine (misal: Vulnerability Scanner + Dependency Checker) secara paralel dalam satu perintah.
- 🛡️ **Read-Only by Default**: Dirancang dengan prinsip keamanan maksimal, menolak *path traversal*, *symlinks*, dan eksekusi kode yang tidak sah.
- 🧪 **Test-Driven**: Dibangun dengan 285+ unit test yang passing, menjamin stabilitas dan mencegah regresi.

---

## 🚀 Quick Start

### Prasyarat
- Node.js v20 atau lebih baru

### Instalasi
```bash
# 1. Clone atau masuk ke direktori proyek
cd ~/noctra

# 2. Instal dependensi
npm install

# 3. Berikan izin eksekusi pada CLI
chmod +x bin/noctra.mjs
```

### Penggunaan Dasar
```bash
# Lihat bantuan
./bin/noctra.mjs --help

# Scan direktori tertentu
./bin/noctra.mjs scan ./target-folder

# Scan dan simpan hasil ke file JSON
./bin/noctra.mjs scan ./target-folder --output laporan.json

# Scan dengan format output JSON (untuk integrasi CI/CD)
./bin/noctra.mjs scan ./target-folder --format json
```

---

## 📊 Contoh Output

```text
Scanning: ./test-project
Format: text

Found 5 target files

🚀 Initializing Multi-Engine NEA Scan...
🚀 Executing engines in parallel via NEA Contracts...

=== 🛡️ Noctra Multi-Engine Scan Summary ===
Files scanned: 5
Total Findings: 7
Errors: 0

🚨 Findings:
  [CRITICAL] PROTOTYPE_POLLUTION_AST in test-project/pollution.js:29
    Message: AST Analysis: Direct access to __proto__ detected. High risk of Prototype Pollution.
    Snippet: testObj.__proto__.isAdmin = true;

  [HIGH] DANGEROUS_EVAL_AST in test-project/vulnerable.js:3
    Message: AST Analysis: Direct use of eval() detected.
    Snippet: const result = eval(userData);
```

---

## 🏗️ Arsitektur (NEA)

Noctra menggunakan arsitektur berlapis yang memisahkan antarmuka CLI, orkestrasi, dan eksekusi engine:

```text
┌─────────────────────────────────────────────────────────────┐
│                        CLI (bin/noctra.mjs)                 │
│  (Mengumpulkan file, memformat output, menangani argumen)   │
└───────────────────────────┬─────────────────────────────────┘
                            │ (NEA Execution Request)
┌───────────────────────────▼─────────────────────────────────┐
│                  NEA Core (tools/nea/core/)                 │
│  • Contracts (Validasi & Immutability)                      │
│  • Engine Registry (Pendaftaran Engine)                     │
│  • Orchestrator (Eksekusi & Dependensi)                     │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
┌──────────────▼──────────────┐  ┌────────────▼──────────────┐
│ Vulnerability Scanner       │  │ Dependency Checker        │
│ (AST Parsing + Regex Rules) │  │ (Package.json Analysis)   │
└──────────────┬──────────────┘  └───────────────────────────┘
               │
┌──────────────▼──────────────┐
│ Inspector (tools/inspector/)│
│ (Acorn AST, Scope Analyzer, │
│  Binding Resolver, TS/JSX)  │
└─────────────────────────────┘
```

---

## 🧪 Pengujian

Proyek ini dikembangkan dengan pendekatan *Test-Driven Development* (TDD). Untuk menjalankan seluruh suite pengujian:

```bash
npm test
```
*(Target: 285+ tests passing)*

---

## 🛠️ Pengembangan Selanjutnya (Roadmap)

- [ ] Taint Analysis / Data Flow Tracking (Melacak aliran data dari input ke sink)
- [ ] SARIF Output Format (Integrasi native dengan GitHub Code Scanning & VS Code)
- [ ] HTML Report Generation
- [ ] Custom Rules via `.noctra-config.json`

---

## 📜 Lisensi

Distributed under the MIT License. Lihat `LICENSE` untuk informasi lebih lanjut.

---
*Dibuat dengan ❤️ untuk komunitas keamanan siber dan bug bounty hunter.*
