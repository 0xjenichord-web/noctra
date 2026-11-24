#!/bin/bash

echo "🚀 Setting up Noctra CLI..."

# Create directory structure
echo "📁 Creating directories..."
mkdir -p bin lib/cli/commands

# Create bin/noctra.mjs
echo "📝 Creating bin/noctra.mjs..."
cat > bin/noctra.mjs << 'EOF'
#!/usr/bin/env node

import { parseArgs } from "../lib/cli/parser.mjs";
import { scanCommand } from "../lib/cli/commands/scan.mjs";

const VERSION = "0.1.0";

function showHelp() {
  console.log(`
NOCTRA - Independent Security Research and Bug Bounty Intelligence System

USAGE:
  noctra <command> [options]

COMMANDS:
  scan <path>          Scan project for vulnerabilities
  --help               Show this help message
  --version            Show version number

EXAMPLES:
  noctra scan ./my-project
  noctra scan ./src --format json

For more information, visit: https://github.com/noctra
`);
}

function showVersion() {
  console.log(`noctra v${VERSION}`);
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const parsed = parseArgs(args);

    if (parsed.flags.help || args.length === 0) {
      showHelp();
      process.exit(0);
    }

    if (parsed.flags.version) {
      showVersion();
      process.exit(0);
    }

    const command = parsed.command;

    switch (command) {
      case "scan":
        await scanCommand(parsed.positional[0], parsed.flags);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
EOF

# Create lib/cli/parser.mjs
echo "📝 Creating lib/cli/parser.mjs..."
cat > lib/cli/parser.mjs << 'EOF'
export function parseArgs(args) {
  const result = {
    command: null,
    positional: [],
    flags: {}
  };

  let i = 0;

  // First non-flag argument is the command
  while (i < args.length && !args[i].startsWith("-")) {
    if (result.command === null) {
      result.command = args[i];
    } else {
      result.positional.push(args[i]);
    }
    i++;
  }

  // Parse flags and remaining positional arguments
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const flagName = arg.slice(2);
      
      // Check if next argument is a value (not a flag)
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        result.flags[flagName] = args[i + 1];
        i += 2;
      } else {
        result.flags[flagName] = true;
        i++;
      }
    } else if (arg.startsWith("-")) {
      // Short flags
      const flagName = arg.slice(1);
      result.flags[flagName] = true;
      i++;
    } else {
      result.positional.push(arg);
      i++;
    }
  }

  return result;
}
EOF

# Create lib/cli/commands/scan.mjs
echo "📝 Creating lib/cli/commands/scan.mjs..."
cat > lib/cli/commands/scan.mjs << 'EOF'
import { analyzeJavaScript } from "../../../tools/inspector/ast-analyzer.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

function collectJavaScriptFiles(dirPath, files = []) {
  const entries = readdirSync(dirPath);

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }
      collectJavaScriptFiles(fullPath, files);
    } else if (stat.isFile()) {
      const ext = extname(entry);
      if ([".js", ".mjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export async function scanCommand(targetPath, flags) {
  if (!targetPath) {
    throw new Error("Please provide a target path to scan");
  }

  const format = flags.format || "text";
  
  console.log(`Scanning: ${targetPath}`);
  console.log(`Format: ${format}`);
  console.log("");

  try {
    const files = collectJavaScriptFiles(targetPath);
    
    console.log(`Found ${files.length} JavaScript/TypeScript files`);
    console.log("");

    const results = {
      scannedFiles: files.length,
      findings: [],
      errors: []
    };

    for (const file of files) {
      try {
        const source = readFileSync(file, "utf-8");
        const analysis = analyzeJavaScript(source);

        if (analysis.status === "SYNTAX_ERROR") {
          results.errors.push({
            file,
            error: analysis.syntaxError?.message || "Syntax error"
          });
        } else {
          // TODO: Add vulnerability detection rules here
          // For now, just collect basic info
          results.findings.push({
            file,
            status: analysis.status,
            functions: analysis.declarations?.filter(d => d.kind === "function").length || 0,
            classes: analysis.declarations?.filter(d => d.kind === "class").length || 0
          });
        }
      } catch (error) {
        results.errors.push({
          file,
          error: error.message
        });
      }
    }

    // Output results
    if (format === "json") {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log("=== Scan Summary ===");
      console.log(`Files scanned: ${results.scannedFiles}`);
      console.log(`Files with errors: ${results.errors.length}`);
      console.log("");

      if (results.errors.length > 0) {
        console.log("Errors:");
        for (const err of results.errors) {
          console.log(`  ${err.file}: ${err.error}`);
        }
        console.log("");
      }

      console.log("Analysis complete. Vulnerability detection rules coming soon!");
    }
  } catch (error) {
    throw new Error(`Failed to scan ${targetPath}: ${error.message}`);
  }
}
EOF

# Make noctra.mjs executable
echo "🔧 Setting permissions..."
chmod +x bin/noctra.mjs

# Update package.json
echo "📝 Updating package.json..."
cat > package.json << 'EOF'
{
  "name": "noctra",
  "version": "0.1.0",
  "private": true,
  "description": "Independent security research and bug bounty intelligence system",
  "type": "module",
  "bin": {
    "noctra": "./bin/noctra.mjs"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test tests/*.test.mjs"
  },
  "dependencies": {
    "@sveltejs/acorn-typescript": "^1.0.13",
    "acorn": "^8.19.0",
    "acorn-jsx": "^5.3.2"
  }
}
EOF

echo "✅ Noctra CLI setup complete!"
echo ""
echo "🧪 Test the CLI with:"
echo "  ./bin/noctra.mjs --help"
echo "  ./bin/noctra.mjs --version"
echo ""
echo "📁 Create a test project:"
echo "  mkdir -p test-project"
echo "  echo 'function hello() { console.log(\"world\"); }' > test-project/test.js"
echo "  ./bin/noctra.mjs scan ./test-project"
