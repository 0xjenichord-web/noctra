#!/bin/bash

# Warna
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

clear

# ASCII Art Header
echo -e "${CYAN}"
echo "  _   _                  _ "
echo " | \ | | _____   ____ _| |"
echo " |  \| |/ _ \ \ / / _\` | |"
echo " | |\  |  __/\ V / (_| | |"
echo " |_| \_|\___| \_/ \__,_|_|"
echo -e "  SECURITY INTELLIGENCE SYSTEM${NC}"
echo "-----------------------------------"
sleep 1

# 1. Simulasi Clone
echo -e "${YELLOW}[1/4]${NC} Mengkloning target repository..."
for i in {1..20}; do
    printf "\r[${CYAN}%-${20s}${NC}] %d%%" "$(printf '=%.0s' $(seq 1 $i))" "$((i*5))"
    sleep 0.05
done
echo -e "\n${GREEN}✅ Target berhasil dikloning! (1.2 MB)${NC}"
sleep 1

# 2. Simulasi Inisialisasi Engine
echo -e "\n${YELLOW}[2/4]${NC} Menginisialisasi NEA Multi-Engine..."
echo -e "${CYAN}   -> Loading AST Parser (Acorn)... OK${NC}"
sleep 0.5
echo -e "${CYAN}   -> Loading Solidity Parser... OK${NC}"
sleep 0.5
echo -e "${CYAN}   -> Loading Vulnerability Rules (42 rules)... OK${NC}"
sleep 1

# 3. Simulasi Scanning
echo -e "\n${YELLOW}[3/4]${NC} Memindai 150 file target..."
files=("auth.js" "config.js" "utils/merge.ts" "contracts/Vault.sol" "api/fetch.js")
for file in "${files[@]}"; do
    echo -e "${CYAN}   🔍 Menganalisis: ${file}...${NC}"
    sleep 0.4
done
echo -e "${GREEN}✅ Pemindaian AST & Solidity selesai!${NC}"
sleep 1

# 4. Simulasi Laporan
echo -e "\n${YELLOW}[4/4]${NC} Mengkompilasi laporan SARIF..."
sleep 1
echo -e "${RED}🚨 TEMUAN KRITIS TERDETEKSI!${NC}"
echo "-----------------------------------"
echo -e "${RED}[CRITICAL]${NC} HARDCODED_SECRET in ${CYAN}config.js:12${NC}"
echo -e "   Pesan: Private key blockchain terdeteksi."
echo -e "   Cuplikan: ${YELLOW}const PRIV_KEY = '0x123...';${NC}"
echo ""
echo -e "${RED}[HIGH]${NC} TX_ORIGIN_AUTH in ${CYAN}contracts/Vault.sol:45${NC}"
echo -e "   Pesan: Penggunaan tx.origin rentan terhadap phishing."
echo -e "   Cuplikan: ${YELLOW}require(tx.origin == owner);${NC}"
echo "-----------------------------------"
echo -e "${GREEN}✈️ Laporan SARIF disimpan ke: noctra-report.sarif${NC}"
echo -e "${CYAN}Selesai dalam 4.2 detik.${NC}"
